"""Security clearance records — SQLite table (primary) + legacy JSON migration."""

from __future__ import annotations

import json
import time
from pathlib import Path

from flask import current_app
from sqlalchemy import inspect, text

from app.extensions import db
from app.models import SecurityClearanceRecord
from app.settings import get_setting, set_setting

SC2_CONFIG_KEY = "security_clearance"
SC2_RECORDS_KEY = "security_clearance_records"
SC2_RECORDS_FILENAME = "security_clearance_records.json"
SC2_MIGRATED_FLAG = "security_clearance_records_migrated_v1"

_legacy_migrated = False


def database_path_for_diagnostics() -> str:
    uri = str(current_app.config.get("SQLALCHEMY_DATABASE_URI") or "")
    if uri.startswith("sqlite:///"):
        return uri.replace("sqlite:///", "", 1)
    return uri


def _sqlite_checkpoint() -> None:
    """Flush SQLite WAL so other workers / the next HTTP request see committed rows."""
    uri = str(current_app.config.get("SQLALCHEMY_DATABASE_URI") or "")
    if not uri.startswith("sqlite:///"):
        return
    try:
        with db.engine.connect() as conn:
            conn.execute(text("PRAGMA wal_checkpoint(TRUNCATE)"))
            conn.commit()
    except Exception:
        current_app.logger.warning("security clearance wal_checkpoint failed", exc_info=True)


def storage_diagnostics() -> dict:
    """Lightweight health info for admin troubleshooting."""
    insp = inspect(db.engine)
    table_ok = insp.has_table("security_clearance_records")
    sql_count = 0
    if table_ok:
        try:
            sql_count = int(db.session.query(SecurityClearanceRecord).count())
        except Exception:
            sql_count = 0
    settings_raw = get_setting(SC2_RECORDS_KEY, default=None)
    settings_count = len(settings_raw) if isinstance(settings_raw, list) else 0
    snap = _records_file_path()
    snap_rows = 0
    if snap.is_file():
        raw = _read_legacy_json_file()
        if isinstance(raw, list):
            snap_rows = len(raw)
    return {
        "storage": "sql+settings",
        "table_exists": table_ok,
        "record_count": sql_count,
        "settings_backup_count": settings_count,
        "database_path": database_path_for_diagnostics(),
        "snapshot_path": str(snap),
        "snapshot_rows": snap_rows,
        "migrated": bool(get_setting(SC2_MIGRATED_FLAG)),
    }


def _records_file_path() -> Path:
    uri = str(current_app.config.get("SQLALCHEMY_DATABASE_URI") or "")
    if uri.startswith("sqlite:///"):
        parent = Path(uri.replace("sqlite:///", "")).parent
        parent.mkdir(parents=True, exist_ok=True)
        return parent / SC2_RECORDS_FILENAME
    inst = Path(current_app.instance_path)
    inst.mkdir(parents=True, exist_ok=True)
    return inst / SC2_RECORDS_FILENAME


def _read_legacy_json_file() -> list | None:
    path = _records_file_path()
    if not path.is_file():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return raw if isinstance(raw, list) else None
    except (OSError, json.JSONDecodeError, TypeError):
        return None


def _load_legacy_record_lists() -> list[list]:
    out: list[list] = []
    file_raw = _read_legacy_json_file()
    if file_raw is not None:
        out.append(file_raw)
    key_raw = get_setting(SC2_RECORDS_KEY, default=None)
    if isinstance(key_raw, list):
        out.append(key_raw)
    cfg = get_setting(SC2_CONFIG_KEY, default={}) or {}
    if isinstance(cfg, dict):
        legacy = cfg.get("records")
        if isinstance(legacy, list):
            out.append(legacy)
    return out


def ensure_clearance_table() -> None:
    """Create security_clearance_records table if an upgraded deploy missed it."""
    insp = inspect(db.engine)
    if insp.has_table("security_clearance_records"):
        return
    SecurityClearanceRecord.__table__.create(db.engine, checkfirst=True)
    current_app.logger.warning("Created missing security_clearance_records table")


def count_clearance_records() -> int:
    ensure_clearance_table()
    try:
        return int(db.session.query(SecurityClearanceRecord).count())
    except Exception:
        db.session.rollback()
        return 0


def effective_record_count() -> int:
    """Rows in SQL, or settings/JSON backup counts if SQL is empty."""
    n = count_clearance_records()
    if n > 0:
        return n
    for raw in _load_legacy_record_lists():
        if isinstance(raw, list):
            return len(raw)
    return 0


def ensure_sql_populated_from_backups(normalize_fn) -> int:
    """If SQL table is empty, copy backups into SQL. Returns SQL row count."""
    n = count_clearance_records()
    if n > 0:
        return n
    return recover_all_sources_when_empty(normalize_fn)


def recover_clearance_records_from_snapshot(normalize_fn) -> int:
    """Public wrapper — reload SQL table from JSON snapshot when empty."""
    return _recover_from_json_snapshot(normalize_fn)


def _recover_from_json_snapshot(normalize_fn) -> int:
    """If SQL table is empty but a JSON snapshot exists, reload into SQL."""
    raw = _read_legacy_json_file()
    if not isinstance(raw, list) or not raw:
        return 0
    norm = normalize_fn(raw)
    if not norm:
        return 0
    n = replace_clearance_records(norm)
    current_app.logger.warning(
        "Recovered %s security clearance record(s) from JSON snapshot into SQL", n
    )
    return n


def recover_all_sources_when_empty(normalize_fn) -> int:
    """
    When SQL has 0 rows, try JSON snapshot then legacy app_settings blobs.
    """
    if count_clearance_records() > 0:
        return count_clearance_records()
    n = _recover_from_json_snapshot(normalize_fn)
    if n > 0:
        return n
    best_raw: list = []
    for raw in _load_legacy_record_lists():
        if isinstance(raw, list) and len(raw) > len(best_raw):
            best_raw = raw
    if not best_raw:
        return 0
    norm = normalize_fn(best_raw)
    if not norm:
        current_app.logger.error(
            "Legacy clearance backup had %s row(s) but none normalized (check CSID fields)",
            len(best_raw),
        )
        return 0
    n = replace_clearance_records(norm)
    if n:
        current_app.logger.info(
            "Recovered %s security clearance record(s) from legacy settings into SQL", n
        )
    return n


def _write_settings_backup(records: list[dict]) -> None:
    """Always mirror records into app_settings (survives SQL table issues)."""
    if not records:
        return
    try:
        set_setting(SC2_RECORDS_KEY, records)
    except Exception:
        current_app.logger.exception("security clearance settings backup write failed")


def _write_json_snapshot(records: list[dict]) -> None:
    """Best-effort JSON backup beside the SQLite DB (recovery if needed)."""
    try:
        path = _records_file_path()
        path.write_text(json.dumps(records, ensure_ascii=False), encoding="utf-8")
    except OSError:
        current_app.logger.warning("security clearance JSON snapshot write failed", exc_info=True)


def _persist_all_backups(records: list[dict]) -> None:
    _write_settings_backup(records)
    _write_json_snapshot(records)


def load_clearance_records() -> list[dict]:
    """Load from SQL table only (use ensure_sql_populated_from_backups first)."""
    ensure_clearance_table()
    try:
        rows = (
            db.session.query(SecurityClearanceRecord)
            .order_by(SecurityClearanceRecord.csid.asc())
            .all()
        )
        return [r.to_api_dict() for r in rows]
    except Exception:
        current_app.logger.exception("security clearance SQL load failed")
        db.session.rollback()
        return []


def replace_clearance_records(records: list[dict]) -> int:
    """Replace entire table with the given normalized records."""
    ensure_clearance_table()
    if not records:
        return count_clearance_records()
    try:
        db.session.query(SecurityClearanceRecord).delete()
        db.session.flush()
        n = 0
        for data in records:
            row = SecurityClearanceRecord.from_api_dict(data)
            if not row:
                continue
            if not row.created_at:
                row.created_at = int(time.time() * 1000)
            db.session.add(row)
            n += 1
        db.session.commit()
        db.session.expire_all()
        _sqlite_checkpoint()
        if n:
            _persist_all_backups(records)
        return n
    except Exception:
        db.session.rollback()
        raise


def sync_clearance_records(records: list[dict]) -> int:
    """
    Upsert all records and remove rows whose CSID is not in the payload.
    """
    ensure_clearance_table()
    if not records:
        existing = count_clearance_records()
        if existing > 0:
            raise RuntimeError(
                f"Refusing to clear {existing} clearance record(s) with an empty save."
            )
        return 0
    try:
        by_csid = {
            str(r.csid or "").strip().upper(): r
            for r in db.session.query(SecurityClearanceRecord).all()
            if r.csid
        }
        incoming_keys: set[str] = set()
        n = 0
        for data in records:
            csid = str(data.get("csid") or "").strip()[:120]
            if not csid:
                continue
            key = csid.upper()
            incoming_keys.add(key)
            existing = by_csid.get(key)
            if existing:
                existing.apply_api_dict(data)
            else:
                row = SecurityClearanceRecord.from_api_dict(data)
                if not row:
                    continue
                if not row.created_at:
                    row.created_at = int(time.time() * 1000)
                db.session.add(row)
                by_csid[key] = row
            n += 1
        for key, row in list(by_csid.items()):
            if key not in incoming_keys:
                db.session.delete(row)
        db.session.commit()
        db.session.expire_all()
        _sqlite_checkpoint()
        sql_n = count_clearance_records()
        if sql_n <= 0:
            raise RuntimeError(
                f"Save committed but SQL table has 0 rows ({n} record(s) in payload)."
            )
        loaded = load_clearance_records()
        _persist_all_backups(loaded)
        return sql_n
    except Exception:
        db.session.rollback()
        raise


def upsert_clearance_records(
    records: list[dict], *, merge_import: bool = False
) -> tuple[int, int, int]:
    """
    Insert/update rows by CSID without deleting rows missing from the import file.
    Returns (added, updated, sql_row_count).
    """
    ensure_clearance_table()
    if not records:
        return 0, 0, count_clearance_records()
    try:
        by_csid = {
            str(r.csid or "").strip().upper(): r
            for r in db.session.query(SecurityClearanceRecord).all()
            if r.csid
        }
        added = updated = 0
        for data in records:
            csid = str(data.get("csid") or "").strip()[:120]
            if not csid:
                continue
            key = csid.upper()
            existing = by_csid.get(key)
            if existing:
                if merge_import:
                    existing.apply_import_dict(data)
                else:
                    existing.apply_api_dict(data)
                updated += 1
            else:
                row = SecurityClearanceRecord.from_api_dict(data)
                if not row:
                    continue
                if not row.created_at:
                    row.created_at = int(time.time() * 1000)
                db.session.add(row)
                by_csid[key] = row
                added += 1
        db.session.commit()
        db.session.expire_all()
        _sqlite_checkpoint()
        sql_n = count_clearance_records()
        if sql_n <= 0:
            raise RuntimeError(
                f"Import committed but SQL table has 0 rows "
                f"({len(records)} in payload, {added} added, {updated} updated)."
            )
        loaded = load_clearance_records()
        _persist_all_backups(loaded)
        return added, updated, sql_n
    except Exception:
        db.session.rollback()
        raise


def import_clearance_records(records: list[dict], *, merge_import: bool = True) -> tuple[int, int, int]:
    """Import rows and verify they exist in SQL before returning."""
    added, updated, sql_n = upsert_clearance_records(records, merge_import=merge_import)
    return added, updated, sql_n


def repair_clearance_storage(normalize_fn) -> dict:
    """Reload from backups into SQL; return diagnostics."""
    ensure_clearance_table()
    before = count_clearance_records()
    sql_before = before

    best_raw: list = []
    for raw in _load_legacy_record_lists():
        if isinstance(raw, list) and len(raw) > len(best_raw):
            best_raw = raw
    norm = normalize_fn(best_raw) if best_raw else []
    n = 0
    if norm:
        n = replace_clearance_records(norm)
    elif best_raw:
        current_app.logger.error(
            "Repair: %s backup row(s) but 0 normalized — not wiping SQL", len(best_raw)
        )
    else:
        n = recover_all_sources_when_empty(normalize_fn)

    db.session.expire_all()
    sql_n = count_clearance_records()
    if norm and sql_n <= 0:
        raise RuntimeError(
            f"Repair wrote 0 SQL rows ({len(norm)} normalized from {len(best_raw)} backup rows)."
        )
    return {
        "before": before,
        "sql_before": sql_before,
        "recovered_to_sql": n,
        "after": sql_n,
        "sql_count": sql_n,
        "diagnostics": storage_diagnostics(),
    }


def migrate_legacy_clearance_records(normalize_fn) -> int:
    """One-time import from app_settings / JSON file into the SQL table."""
    global _legacy_migrated
    if _legacy_migrated:
        if count_clearance_records() > 0:
            return count_clearance_records()
        return recover_all_sources_when_empty(normalize_fn)

    if get_setting(SC2_MIGRATED_FLAG):
        _legacy_migrated = True
        return recover_all_sources_when_empty(normalize_fn)

    if count_clearance_records() > 0:
        set_setting(SC2_MIGRATED_FLAG, True)
        _legacy_migrated = True
        return count_clearance_records()

    best_raw: list = []
    for raw in _load_legacy_record_lists():
        if isinstance(raw, list) and len(raw) > len(best_raw):
            best_raw = raw
    if not best_raw:
        set_setting(SC2_MIGRATED_FLAG, True)
        _legacy_migrated = True
        recovered = _recover_from_json_snapshot(normalize_fn)
        return recovered

    norm = normalize_fn(best_raw)
    n = replace_clearance_records(norm) if norm else 0
    set_setting(SC2_MIGRATED_FLAG, True)
    _legacy_migrated = True
    current_app.logger.info("Migrated %s security clearance record(s) into SQL table", n)
    if n > 0:
        _strip_legacy_settings_blob()
    return n


def _strip_legacy_settings_blob() -> None:
    """Remove oversized JSON blobs from app_settings now that SQL is primary."""
    cfg = get_setting(SC2_CONFIG_KEY, default={}) or {}
    if isinstance(cfg, dict) and "records" in cfg:
        cfg = dict(cfg)
        cfg.pop("records", None)
        set_setting(SC2_CONFIG_KEY, cfg)


# Back-compat aliases used by admin export paths
def load_raw_records_lists() -> list[list]:
    return [load_clearance_records()]


def save_raw_records(records: list[dict], *, sync_config: bool = True) -> None:
    sync_clearance_records(records)
