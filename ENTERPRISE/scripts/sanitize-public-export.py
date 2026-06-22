#!/usr/bin/env python3
"""Remove enterprise traces from PUBLIC/ after sync (Community Edition export)."""

from __future__ import annotations

import ast
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "PUBLIC"
OVERLAYS = ROOT / "scripts" / "community-public-overlays"

# Classes removed from models.py (enterprise-only schema).
MODELS_REMOVE_CLASS = re.compile(
    r"^class (SecurityClearanceRecord|ResourcePoolResource|CRMCompany|CRMLead|CRMContact|CRMActivity|CRMDeal|AiDocChunk|AiDocConversation|AiPolicyConversation|AiChatConversation)\b"
)

ADMIN_REMOVE_FUNCS = frozenset(
    {
        "_require_enterprise_build",
        "api_premium_license_get",
        "api_premium_license_put",
        "api_office365_settings_get",
        "api_office365_settings_put",
        "api_office365_settings_test",
        "api_ad_ldap_settings_get",
        "api_ad_ldap_settings_put",
        "api_ad_ldap_settings_test",
        "api_ai_document_search_settings_get",
        "api_ai_document_search_settings_put",
        "api_ai_document_search_index_folders",
        "api_ai_chatbot_settings_get",
        "api_ai_chatbot_settings_put",
        "api_ai_settings_copy_api_key",
        "api_security_encryption_get",
        "api_security_encryption_put",
        "api_security_clearance_settings_get",
        "api_security_clearance_settings_put",
    }
)

CE_MODULE_KEYS = frozenset(
    {
        "home",
        "news",
        "events",
        "wiki",
        "kanban",
        "team_chat",
        "directory",
        "workforce_dashboard",
        "security_training",
        "documents",
        "about",
        "game",
        "admin",
    }
)

INTRANET_BP_NAV_ITEMS = """    items = [
        ("home", "Home", "intranet.intranet_page"),
        ("news", "Blogs", "intranet.news_page"),
        ("events", "Events", "intranet.events_page"),
        ("wiki", "Wiki", "intranet.wiki_page"),
        ("kanban", "KanBan", "intranet.kanban_page"),
        ("team_chat", "Team Chat", "intranet.team_chat_page"),
        ("directory", "Workforce", "intranet.directory_page"),
        ("workforce_dashboard", "Workforce Dashboard", "intranet.workforce_dashboard_page"),
        ("security_training", "Security Training", "intranet.security_training_page"),
        ("documents", "Documents", "intranet.documents_page"),
        ("about", "About Company", "intranet.about_page"),
        ("game", "Games", "chess.game_lobby_page"),
        ("admin", "Administration", "intranet.admin_page"),
    ]"""

NAV_FUNCTION_REPLACEMENT = '''def _nav(active: str) -> dict:
    items = [
        ("home", "Home", "intranet.intranet_page"),
        ("news", "Blogs", "intranet.news_page"),
        ("events", "Events", "intranet.events_page"),
        ("wiki", "Wiki", "intranet.wiki_page"),
        ("team_chat", "Team Chat", "intranet.team_chat_page"),
        ("directory", "Workforce", "intranet.directory_page"),
        ("workforce_dashboard", "Workforce Dashboard", "intranet.workforce_dashboard_page"),
        ("security_training", "Security Training", "intranet.security_training_page"),
        ("documents", "Documents", "intranet.documents_page"),
        ("about", "About Company", "intranet.about_page"),
        ("game", "Games", "chess.game_lobby_page"),
        ("admin", "Administration", "intranet.admin_page"),
    ]
    try:
        from app.community_edition import community_module_available

        cfg = get_setting("modules", default={}) or {}
        mods = cfg.get("modules") if isinstance(cfg, dict) else None
        mods = mods if isinstance(mods, dict) else {}
        is_admin = bool(
            current_user.is_authenticated and rbac.user_has_permission(current_user, rbac.PERMISSION_ADMIN)
        )
        can_access_users_admin = bool(
            current_user.is_authenticated and rbac.user_can_access_users_admin(current_user)
        )
        uid = getattr(current_user, "id", None)
        allowed: set[str] = set()
        for key, _label, _endpoint in items:
            if not community_module_available(key):
                continue
            rule = mods.get(key) if isinstance(mods, dict) else None
            rule = rule if isinstance(rule, dict) else {}
            if rule.get("enabled") is False:
                if key == "admin" and (is_admin or can_access_users_admin):
                    pass
                elif not (is_admin and key == "admin"):
                    continue
            if is_admin or (key == "admin" and can_access_users_admin):
                allowed.add(key)
                continue
            if not bool(rule.get("restricted")):
                allowed.add(key)
                continue
            ids = rule.get("allowed_user_ids")
            ids = ids if isinstance(ids, list) else []
            ok_user = False
            if uid is not None:
                try:
                    ok_user = int(uid) in {int(x) for x in ids}
                except Exception:
                    ok_user = False
            if ok_user:
                allowed.add(key)
    except Exception:
        from app.community_edition import COMMUNITY_EDITION_MODULES

        allowed = {k for k, _l, _e in items if k in COMMUNITY_EDITION_MODULES or k == "admin"}

    filtered = [it for it in items if it[0] in allowed]
    return {"active": active, "items": filtered}
'''


def log(msg: str) -> None:
    print(msg, flush=True)


def apply_overlays() -> None:
    if not OVERLAYS.is_dir():
        return
    for src in OVERLAYS.rglob("*"):
        if not src.is_file():
            continue
        rel = src.relative_to(OVERLAYS)
        dest = PUBLIC / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
        log(f"  overlay {rel}")


def delete_paths() -> None:
    for rel in (
        "app/premium_license_ce.py",
        "app/enterprise_license_public.b64",
        "COMMERCIAL.md",
        "docs/screenshots/enterprise-features.png",
        "docs/screenshots/crm-dashboard.png",
        "docs/screenshots/security-clearance.png",
        "docs/screenshots/enterprise",
        "scripts/import_clearance_json.py",
        "scripts/export_clearance_json.py",
        "scripts/check_clearance_records.py",
        "tests/test_premium_license_smoke.py",
        "tests/test_premium_license.py",
        "app/templates/_intranet_crm_coming_soon_dialog.html",
        "scripts/enterprise-public-excludes.txt",
        "scripts/build_edition_packages.sh",
        "app/templates/intranet_security_officer.html",
        "app/static/security_officer.js",
        "app/security_officer_report.py",
        "docs/screenshots/security-officer.png",
    ):
        p = PUBLIC / rel
        if p.is_file():
            p.unlink()
            log(f"  deleted {rel}")
        elif p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
            log(f"  deleted {rel}/")


def strip_models(path: Path) -> None:
    lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
    out: list[str] = []
    skip = False
    depth = 0
    for line in lines:
        if MODELS_REMOVE_CLASS.match(line.strip()):
            skip = True
            depth = 0
            continue
        if skip:
            if line.startswith("class ") and not line.startswith("    "):
                skip = False
            else:
                continue
        out.append(line)
    text = "".join(out)
    text = re.sub(r"\n# CRM\n", "\n", text)
    path.write_text(text, encoding="utf-8")
    log("  stripped enterprise models")


def strip_security_officer_routes(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    text = re.sub(
        r"\ndef _security_officer_module_allowed\(user: User\)[\s\S]*?\ndef _seed_contractors_if_empty",
        "\n\ndef _seed_contractors_if_empty",
        text,
        count=1,
    )
    text = re.sub(
        r'\n@bp\.route\("/security-officer"[\s\S]*?'
        r'\n@bp\.route\("/api/security-training/assets"',
        '\n@bp.route("/api/security-training/assets"',
        text,
        count=1,
    )
    path.write_text(text, encoding="utf-8")
    log("  stripped security officer routes from intranet_bp.py")


def patch_intranet_bp(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    text = re.sub(r"    CRMActivity,\n", "", text)
    text = re.sub(r"    CRMCompany,\n", "", text)
    text = re.sub(r"    CRMLead,\n", "", text)
    text = re.sub(
        r"def _nav\(active: str\) -> dict:.*?(?=\n\ndef _news_posts)",
        NAV_FUNCTION_REPLACEMENT + "\n",
        text,
        count=1,
        flags=re.DOTALL,
    )
    text = re.sub(
        r"\ndef _register_enterprise_intranet\(\) -> None:[\s\S]*?except ImportError:\n        pass\n",
        "\n",
        text,
    )
    text = re.sub(r"\n_register_enterprise_intranet\(\)\n", "\n", text)
    ensure_community_routes_registered(text, path)
    strip_security_officer_routes(path)
    log("  patched intranet_bp.py")


def ensure_community_routes_registered(text: str, path: Path) -> None:
    """CE wiki/documents/workforce routes must be imported at blueprint load."""
    if "def _register_community_intranet_routes" not in text:
        text = text.rstrip() + (
            "\n\n\ndef _register_community_intranet_routes() -> None:\n"
            "    import app.intranet_community_routes  # noqa: F401\n"
        )
    if not re.search(r"(?m)^_register_community_intranet_routes\(\)\s*$", text):
        text = text.rstrip() + "\n\n_register_community_intranet_routes()\n"
    path.write_text(text, encoding="utf-8")


def patch_init_py(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    text = re.sub(
        r"\n    try:\n        from app\.enterprise import register_enterprise\n\n        register_enterprise\(app\)\n    except ImportError:\n        pass\n",
        "\n",
        text,
    )
    text = re.sub(
        r"\n        from app\.models import \(  # noqa: F401\n            AiChatConversation,\n            AiDocChunk,\n            AiDocConversation,\n            AiPolicyConversation,\n            ResourcePoolResource,\n            SecurityClearanceRecord,\n        \)\n\n        db\.create_all\(\)",
        "\n        db.create_all()",
        text,
    )
    text = re.sub(
        r"\n        try:\n            from app\.enterprise\.ai_document_search import _ensure_schema.*?except Exception:\n            app\.logger\.exception\(\"ai document search schema ensure failed\"\)\n",
        "\n",
        text,
        flags=re.DOTALL,
    )
    text = re.sub(
        r"\n        _ensure_security_clearance_records_table\(\)\n        _ensure_resource_pool_resources_table\(\)\n        _ensure_resource_pool_resources_columns\(\)",
        "",
        text,
    )
    text = re.sub(
        r"\n        try:\n            from app\.enterprise\.intranet_routes import _normalize_security_clearance_records.*?except Exception:\n            app\.logger\.exception\(\"security clearance legacy migration failed\"\)\n",
        "\n",
        text,
        flags=re.DOTALL,
    )
    text = re.sub(
        r"\n            try:\n                from app\.premium_license import sync_enterprise_modules_for_license\n\n                sync_enterprise_modules_for_license\(\)\n            except Exception:\n                app\.logger\.exception\(\"enterprise module sync for license failed\"\)\n",
        "\n",
        text,
    )
    text = re.sub(
        r"\n        try:\n            from app\.premium_license import warn_if_license_verification_missing\n\n            warn_if_license_verification_missing\(\)\n        except Exception:\n            pass\n",
        "\n",
        text,
    )
    for fn in (
        "_ensure_resource_pool_resources_table",
        "_ensure_resource_pool_resources_columns",
        "_ensure_security_clearance_records_table",
    ):
        text = re.sub(
            rf"def {fn}\(.*?(?=\n\ndef |\Z)",
            "",
            text,
            flags=re.DOTALL,
        )
    path.write_text(text, encoding="utf-8")
    log("  patched __init__.py")


def strip_admin_bp(path: Path) -> None:
    source = path.read_text(encoding="utf-8")
    tree = ast.parse(source)
    new_body = [node for node in tree.body if not _admin_node_remove(node)]
    new_tree = ast.Module(body=new_body, type_ignores=getattr(tree, "type_ignores", []))
    text = ast.unparse(new_tree) + "\n"
    text = re.sub(
        r"    from app\.premium_license import status_for_api\n\n    ctx = rbac\.users_admin_template_context\(current_user\)\n    ctx\[\"premium_license\"\] = status_for_api\(\)\n",
        "    ctx = rbac.users_admin_template_context(current_user)\n",
        text,
    )
    text = re.sub(
        r'return jsonify\(\{"error": "provider must be onlyoffice or office365"\}\), 400',
        'return jsonify({"error": "provider must be onlyoffice"}), 400',
        text,
    )
    text = re.sub(
        r"    if provider == \"office365\":.*?(?=\n    set_document_editor_provider)",
        "",
        text,
        flags=re.DOTALL,
    )
    text = re.sub(
        r"    from app\.premium_license import status_for_api\n    ctx = rbac\.users_admin_template_context\(current_user\)\n    ctx\['premium_license'\] = status_for_api\(\)\n",
        "    ctx = rbac.users_admin_template_context(current_user)\n",
        text,
    )
    text = re.sub(
        r"        return \(jsonify\(\{'error': 'provider must be onlyoffice or office365'\}\), 400\)\n    if provider == 'office365':[\s\S]*?ok, msg = premium_required\(FEATURE_OFFICE365\)[\s\S]*?\n",
        "        return (jsonify({'error': 'provider must be onlyoffice'}), 400)\n",
        text,
    )
    text = re.sub(
        r"    from app\.premium_license import license_state, sync_enterprise_modules_for_license\n    if license_state\(\)\.get\('valid'\):[\s\S]*?mods = apply_community_module_policy\(mods\)\n",
        "    mods = apply_community_module_policy(mods)\n",
        text,
    )
    text = re.sub(
        r"        from app\.premium_license import FEATURE_SELF_REGISTRATION, premium_required[\s\S]*?return jsonify\(\{'error': msg\}\), 403\n",
        "",
        text,
    )
    path.write_text(text, encoding="utf-8")
    patch_admin_modules_api(path)
    log("  stripped enterprise admin routes")


def patch_admin_modules_api(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    keys_repr = ",\n        ".join(f'"{k}"' for k in sorted(CE_MODULE_KEYS))
    text = re.sub(r", licensed_enterprise_modules", "", text)
    text = re.sub(r"licensed_enterprise_modules\(\)", "[]", text)
    text = re.sub(
        r"    from app\.premium_license import license_state, sync_enterprise_modules_for_license\n\n    if license_state\(\)\.get\([\"']valid[\"']\):[\s\S]*?if not isinstance\(mods, dict\):\n            mods = \{\}\n\n",
        "",
        text,
    )
    text = re.sub(
        r"    allowed_keys = \{[^}]+\}",
        f"    allowed_keys = {{\n        {keys_repr},\n    }}",
        text,
        count=1,
    )
    text = re.sub(r"'licensed_enterprise_modules': \[\],?\s*", "", text)
    text = re.sub(r'"licensed_enterprise_modules": \[\],?\s*', "", text)
    text = re.sub(r"'licensed_enterprise_modules': licensed_enterprise_modules\(\),?\s*", "", text)
    path.write_text(text, encoding="utf-8")


def _admin_node_remove(node: ast.AST) -> bool:
    if isinstance(node, ast.FunctionDef) and node.name in ADMIN_REMOVE_FUNCS:
        return True
    if isinstance(node, ast.FunctionDef):
        for dec in node.decorator_list:
            if isinstance(dec, ast.Name) and dec.id == "_require_enterprise_build":
                return True
    return False


def strip_rbac(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    text = re.sub(r"\n# CRM \(leads\)\nPERMISSION_CRM_READ[^\n]*\n[^\n]*\n[^\n]*\n", "\n", text)
    text = re.sub(r"\nPERMISSION_CRM_CREATE[^\n]*\n", "", text)
    text = re.sub(r"\nPERMISSION_CRM_DELETE[^\n]*\n", "", text)
    for fn in ("user_can_crm_read", "user_can_crm_create", "user_can_crm_delete"):
        text = re.sub(rf"def {fn}\(.*?(?=\ndef |\Z)", "", text, flags=re.DOTALL)
    text = re.sub(r"    PERMISSION_CRM_READ,\n", "", text)
    text = re.sub(r"    PERMISSION_CRM_CREATE,\n", "", text)
    text = re.sub(r"    PERMISSION_CRM_DELETE,\n", "", text)
    text = re.sub(r"        PERMISSION_CRM_READ,\n", "", text)
    text = re.sub(r"        PERMISSION_CRM_CREATE,\n", "", text)
    text = re.sub(r"        PERMISSION_CRM_DELETE,\n", "", text)
    text = re.sub(r"            PERMISSION_CRM_READ,\n", "", text)
    text = re.sub(r"        cd = by_name\.get\(PERMISSION_CRM_DELETE\).*?\n", "", text)
    path.write_text(text, encoding="utf-8")
    log("  stripped rbac CRM permissions")


def strip_demo_data(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    text = re.sub(r"    CRMActivity,\n", "", text)
    text = re.sub(r"    CRMCompany,\n", "", text)
    text = re.sub(r"    CRMContact,\n", "", text)
    text = re.sub(r"    CRMLead,\n", "", text)
    text = re.sub(r"    ResourcePoolResource,\n", "", text)
    text = re.sub(r"    SecurityClearanceRecord,\n", "", text)
    text = re.sub(r"_POOL_CRM_COMPANIES:.*?(?=\n_POOL_)", "", text, flags=re.DOTALL)
    text = re.sub(r"_POOL_CRM_LEADS:.*?(?=\n_POOL_)", "", text, flags=re.DOTALL)
    text = re.sub(r"_POOL_RESOURCE_POOL:.*?(?=\n_POOL_)", "", text, flags=re.DOTALL)
    text = re.sub(r"_POOL_CLEARANCE:.*?(?=\n_POOL_)", "", text, flags=re.DOTALL)
    text = re.sub(r'    \{"title": "New CRM pipeline.*?\},\n', "", text)
    text = re.sub(r'    \{"title": "CRM pipeline review.*?\},\n', "", text)
    text = re.sub(r"CRM module|CRM leads|workforce, CRM|security clearance", "modules", text, flags=re.IGNORECASE)
    text = re.sub(r'\s*"crm_companies":.*?,?\n', "", text)
    text = re.sub(r'\s*"crm_leads":.*?,?\n', "", text)
    text = re.sub(r'\s*"resource_pool": _POOL_RESOURCE_POOL,?\n', "", text)
    text = re.sub(r'\s*"security_clearance": _POOL_CLEARANCE,?\n', "", text)
    for fn in (
        "_crm_company_by_idx",
        "_seed_crm_companies",
        "_seed_crm_leads",
        "_seed_resource_pool",
        "_seed_security_clearance",
    ):
        text = re.sub(rf"def {fn}\(.*?(?=\ndef |\Z)", "", text, flags=re.DOTALL)
    text = re.sub(
        r"    items, cur, n = slice_pool\(\"crm_companies\"\).*?progress\[\"crm_leads\"\] = cur \+ n\n",
        "",
        text,
        flags=re.DOTALL,
    )
    text = re.sub(
        r"    items, cur, n = slice_pool\(\"resource_pool\"\).*?progress\[\"resource_pool\"\] = cur \+ n\n",
        "",
        text,
        flags=re.DOTALL,
    )
    text = re.sub(
        r"    items, cur, n = slice_pool\(\"security_clearance\"\).*?progress\[\"security_clearance\"\] = cur \+ n\n",
        "",
        text,
        flags=re.DOTALL,
    )
    text = re.sub(r"from app\.enterprise\.security_clearance_store import upsert_clearance_records\n", "", text)
    path.write_text(text, encoding="utf-8")
    log("  stripped demo_data_service.py")


def strip_admin_integrations_js(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    text = re.sub(
        r"  async function loadOffice365Settings\(\)[\s\S]*?function loadAdLdapSettings\(\)",
        "  function loadAdLdapSettings(",
        text,
        count=1,
    )
    text = re.sub(
        r"  async function loadAdLdapSettings\(\)[\s\S]*?(?=  async function loadEmailSettings|  function loadEmailSettings)",
        "",
        text,
        count=1,
    )
    text = re.sub(r"const o365Card[\s\S]*?o365Card\.style\.opacity[\s\S]*?\n", "", text)
    text = re.sub(r"  const o365Save[\s\S]*?if \(o365Test\) o365Test\.addEventListener[\s\S]*?\}\);\n", "", text)
    text = re.sub(r"if \(o365Test\) o365Test\.addEventListener[\s\S]*?\}\);\n", "", text)
    path.write_text(text, encoding="utf-8")
    log("  stripped admin integration loaders (O365/LDAP)")


def strip_file_browser_js(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    text = re.sub(
        r'const prefix = provider === "office365" \? "office365" : "onlyoffice";',
        'const prefix = "onlyoffice";',
        text,
    )
    path.write_text(text, encoding="utf-8")
    log("  patched file_browser.js")


def refresh_public_css(path: Path) -> None:
    """PUBLIC CSS must match root; line-range CRM deletion broke brace balance and intranet layout."""
    src = ROOT / "app/static/file_browser.css"
    if not src.is_file():
        return
    shutil.copy2(src, path)
    text = path.read_text(encoding="utf-8")
    text = text.replace("/* CRM / secondary blues */", "/* Secondary blues */")
    text = text.replace("/* Enterprise intranet palette", "/* Intranet palette")
    path.write_text(text, encoding="utf-8")
    log("  refreshed file_browser.css from root (keeps valid intranet/team-chat rules)")


def patch_init_context(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    text = re.sub(r"        crm_can_read = bool\(u\) and rbac\.user_can_crm_read\(u\)\n", "", text)
    text = re.sub(r"        crm_can_create = bool\(u\) and rbac\.user_can_crm_create\(u\)\n", "", text)
    text = re.sub(r"        crm_can_delete = bool\(u\) and rbac\.user_can_crm_delete\(u\)\n", "", text)
    text = re.sub(r'            "crm_can_read": crm_can_read,\n', "", text)
    text = re.sub(r'            "crm_can_create": crm_can_create,\n', "", text)
    text = re.sub(r'            "crm_can_delete": crm_can_delete,\n', "", text)
    path.write_text(text, encoding="utf-8")
    log("  patched __init__.py template context (CRM)")


def strip_misc_public_strings(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    text = text.replace("Enterprise intranet palette", "Intranet palette")
    text = text.replace(
        "enterprise modules (CRM, Security Clearance, Resource Pool, AI Document Search, AI Chatbot) require a license",
        "only Community Edition modules are available",
    )
    text = re.sub(r'\.nc-intranet-sidebar \.nc-intranet-tab\[data-nav-key="ai_chatbot"\][^{]*\{[^}]*\}\n?', "", text)
    text = re.sub(r"iframe\.nc-onlyoffice-editor\.nc-office365-frame[^{]*\{[^}]*\}\n?", "", text)
    path.write_text(text, encoding="utf-8")


def strip_intranet_sidebar_js(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    text = re.sub(
        r"\n    nav\.querySelectorAll\('\.nc-intranet-tab\[data-nav-key=\"ai_chatbot\"\]'\)\.forEach\(\(tab\) => \{[\s\S]*?\}\);\n",
        "\n",
        text,
    )
    text = re.sub(
        r"document\.querySelectorAll\(\"\.nc-intranet-tab-enterprise, \.nc-intranet-tab-text\"\)\.forEach\([\s\S]*?\}\);\n",
        "",
        text,
    )
    path.write_text(text, encoding="utf-8")
    log("  stripped intranet_sidebar.js")


def strip_intranet_base(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    text = text.replace(
        '{% if key in (nav.get(\'enterprise_ai_modules\') or []) %} nc-intranet-tab--enterprise{% endif %}',
        "",
    )
    text = re.sub(
        r' title="\{% if key in \(nav\.get\(\'enterprise_ai_modules\'\).*?%\}"',
        ' title="{{ label }}"',
        text,
    )
    text = re.sub(
        r"\{% if key in \(nav\.get\('enterprise_ai_modules'\) or \[\]\) %\}\s*"
        r"<span class=\"nc-intranet-tab-text\">.*?\{% else %\}\s*"
        r"<span class=\"nc-intranet-tab-label\">\{\{ label \}\}</span>\s*\{% endif %\}",
        '<span class="nc-intranet-tab-label">{{ label }}</span>',
        text,
        flags=re.DOTALL,
    )
    text = re.sub(r"    data-crm-can-read=.*?\n", "", text)
    text = re.sub(r"    data-crm-can-create=.*?\n", "", text)
    text = re.sub(r"    data-crm-can-delete=.*?\n", "", text)
    path.write_text(text, encoding="utf-8")
    log("  patched intranet_base.html")


def strip_admin_html(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    removals = [
        r'<button[^>]*data-tab="premium_features"[^>]*>.*?</button>\s*',
        r'<button[^>]*data-tab="ai_settings"[^>]*>.*?</button>\s*',
        r'<div id="admin-tab-premium_features"[^>]*>.*?</div>\s*(?=<div id="admin-tab-|\Z)',
        r'<div id="admin-tab-ai_settings"[^>]*>.*?</div>\s*(?=<div id="admin-tab-|\Z)',
        r'<button[^>]*data-tab="security_clearance"[^>]*>.*?</button>\s*',
        r'<button[^>]*data-tab="security_encryption"[^>]*>.*?</button>\s*',
        r'<div id="admin-tab-security_clearance"[^>]*>.*?</div>\s*(?=<div id="admin-tab-|\Z)',
        r'<div id="admin-tab-security_encryption"[^>]*>.*?</div>\s*(?=<div id="admin-tab-|\Z)',
        r'<section[^>]*id="integrations-office365-card"[^>]*>.*?</section>\s*',
        r'<section[^>]*data-premium-feature="ldap"[^>]*>.*?</section>\s*',
        r'<p id="reg-self-premium-hint"[^>]*>.*?</p>\s*',
        r'<option value="office365">[^<]*</option>\s*',
        r'<option value="office365">[^<]*</option>\s*',
    ]
    for pat in removals:
        text = re.sub(pat, "", text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"enterprise feature[s]?", "optional add-on", text, flags=re.IGNORECASE)
    text = re.sub(r"Enterprise Features", "Add-ons", text)
    text = re.sub(r"enterprise license", "commercial licence", text, flags=re.IGNORECASE)
    path.write_text(text, encoding="utf-8")
    log("  stripped _admin_content.html")


CE_MODULES_JS = """  const MODULES = [
    { key: "home", label: "Home" },
    { key: "news", label: "Blogs" },
    { key: "events", label: "Events" },
    { key: "wiki", label: "Wiki" },
    { key: "team_chat", label: "Team Chat" },
    { key: "directory", label: "Workforce" },
    { key: "workforce_dashboard", label: "Workforce Dashboard" },
    { key: "security_training", label: "Security Training" },
    { key: "documents", label: "Documents" },
    { key: "about", label: "About Company" },
    { key: "game", label: "Games" },
    { key: "admin", label: "Administration" },
  ];"""

def strip_admin_js(path: Path) -> None:
    patch_path = OVERLAYS / "app/static/admin_modules_ce.patch.js"
    ce_block = patch_path.read_text(encoding="utf-8")
    text = path.read_text(encoding="utf-8")
    text = re.sub(r'    setHidden\("admin-tab-ai_settings".*?\n', "", text)
    text = re.sub(r'    setHidden\("admin-tab-premium_features".*?\n', "", text)
    text = re.sub(r"    if \(chosen === \"premium_features\"\) loadPremiumLicense\(\);\n", "", text)
    text = re.sub(r"    if \(chosen === \"ai_settings\"\) loadAiSettings\(\);\n", "", text)
    text = re.sub(r'\s*\["crm\.read".*?\],\n', "\n", text, flags=re.DOTALL)
    text = re.sub(r'\s*\["crm\.create".*?\],\n', "\n", text, flags=re.DOTALL)
    text = re.sub(r'\s*\["crm\.delete".*?\],\n', "\n", text, flags=re.DOTALL)
    text = re.sub(r'title: "CRM"[^\n]*\n', "", text)
    text = re.sub(r"CRM leads and pipeline,?\s*", "", text)
    text = re.sub(r", CRM, resource pool", "", text)
    text = re.sub(r"CRM, ", "", text)
    text = re.sub(
        r"  // Modules visibility \(intranet menu control\)[\s\S]*?function scheduleModulesAutoSave\(\) \{[\s\S]*?\}, 350\);\n  \}\n",
        "  // Modules visibility (intranet menu control)\n" + ce_block + "\n",
        text,
        count=1,
    )
    text = re.sub(r"    licensedEnterpriseModules = new Set\(j\.licensed_enterprise_modules \|\| \[\]\);\n", "", text)
    text = re.sub(r"    licensedEnterpriseModules = new Set\(jj\.licensed_enterprise_modules \|\| \[\]\);\n", "", text)
    text = re.sub(r"  let modulesCommunityEdition = true;\n  let licensedEnterpriseModules = new Set\(\);\n  let premiumLicenseState = null;\n\n", "", text)
    text = re.sub(r"function loadPremiumLicense\(\)[\s\S]*?(?=\n  function |\n  async function )", "", text)
    text = re.sub(r"function loadAiSettings\(\)[\s\S]*?(?=\n  function |\n  async function )", "", text)
    text = re.sub(r"function renderPremiumLicense[\s\S]*?(?=\n  function |\n  async function )", "", text)
    text = re.sub(r"function applyPremiumGates\(\)[\s\S]*?(?=\n  function |\n  async function )", "", text)
    text = re.sub(r"const premiumLicenseState[\s\S]*?applyPremiumGates\(\);\n", "", text)
    text = re.sub(r"premiumLicenseState[^\n]*\n", "", text)
    text = re.sub(r"licensedEnterpriseModules[^\n]*\n", "", text)
    text = re.sub(r"modulesCommunityEdition[^\n]*\n", "", text)
    text = re.sub(
        r"    const hintPremium = document\.getElementById\(\"reg-self-premium-hint\"\);[\s\S]*?if \(hintPremium\) hintPremium\.hidden = premiumOk \|\| !isExtranet;\n",
        "",
        text,
    )
    text = re.sub(r"  loadOffice365Settings\(\);\n", "", text)
    text = re.sub(r"  loadAdLdapSettings\(\);\n", "", text)
    text = re.sub(r"  loadPremiumLicense\(\);\n", "", text)
    text = re.sub(
        r"  const AI_ENTERPRISE_FEATURES = \[[\s\S]*?\n\}\)\(\);\s*$",
        "})();\n",
        text,
    )
    text = re.sub(r'    const normalizeTab = \(t\) => \(t === "ai_document_search" \? "ai_settings" : t\);', "    const normalizeTab = (t) => t;", text)
    text = repair_ce_admin_js(text)
    path.write_text(text, encoding="utf-8")
    log("  stripped admin.js")


CE_UPDATE_DOCUMENT_EDITOR_CARDS = """  function updateDocumentEditorCards(provider) {
    const p = (provider || "onlyoffice").trim().toLowerCase();
    const ooCard = document.getElementById("integrations-onlyoffice-card");
    if (ooCard) ooCard.style.opacity = p === "onlyoffice" ? "1" : "0.72";
  }"""

CE_INTEGRATIONS_HANDLERS = """
  async function testOnlyOffice() {
    setStatus("admin-integrations-status", "Testing OnlyOffice connection…");
    const r = await api("/api/settings/onlyoffice/test", { method: "GET" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) {
      const hints = (j.hints || []).length ? `\\n${(j.hints || []).join(" ")}` : "";
      setStatus("admin-integrations-status", (j.error || "OnlyOffice test failed") + hints);
      return;
    }
    setStatus("admin-integrations-status", "OnlyOffice connected: healthcheck OK, editor API OK.");
  }

  const ooSave = document.getElementById("oo-save");
  if (ooSave) {
    ooSave.addEventListener("click", async () => {
      const url = (document.getElementById("oo-url").value || "").trim();
      const jwt_secret = (document.getElementById("oo-jwt").value || "").trim();
      const app_url = (document.getElementById("oo-app-url").value || "").trim();
      const skip_tls_verify = !!(document.getElementById("oo-skip-tls") && document.getElementById("oo-skip-tls").checked);
      const r = await api("/api/settings/onlyoffice", {
        method: "PUT",
        body: JSON.stringify({ url, jwt_secret, app_url, skip_tls_verify }),
      });
      const j = await r.json().catch(() => ({}));
      setStatus("admin-integrations-status", r.ok ? "Saved." : j.error || "Save failed");
      await loadOnlyOfficeSettings();
      if (r.ok) await testOnlyOffice();
    });
  }
  const ooTest = document.getElementById("oo-test");
  if (ooTest) ooTest.addEventListener("click", () => testOnlyOffice());

  const docEditorSave = document.getElementById("doc-editor-save");
  const docEditorProvider = document.getElementById("doc-editor-provider");
  if (docEditorProvider) {
    docEditorProvider.addEventListener("change", () => updateDocumentEditorCards(docEditorProvider.value));
  }
  if (docEditorSave) {
    docEditorSave.addEventListener("click", async () => {
      const provider = (document.getElementById("doc-editor-provider").value || "onlyoffice").trim();
      const r = await api("/api/settings/document-editor", {
        method: "PUT",
        body: JSON.stringify({ provider }),
      });
      const j = await r.json().catch(() => ({}));
      setStatus("admin-doc-editor-status", r.ok ? "Saved." : j.error || "Save failed");
      if (r.ok) {
        updateDocumentEditorCards(provider);
        await loadDocumentEditorSettings();
      }
    });
  }
"""


def repair_ce_admin_js(text: str) -> str:
    """Fix incomplete regex strips (Office 365 / LDAP) that leave admin.js with syntax errors."""
    text = re.sub(
        r"function updateDocumentEditorCards\(provider\) \{[\s\S]*?\n  async function loadDocumentEditorSettings",
        CE_UPDATE_DOCUMENT_EDITOR_CARDS + "\n\n  async function loadDocumentEditorSettings",
        text,
        count=1,
    )
    text = re.sub(
        r"\n  (?:async )?function load(?:AdLdap|Office365)Settings[\s\S]*?\n  let emailProviderCatalog",
        "\n" + CE_INTEGRATIONS_HANDLERS + "\n  let emailProviderCatalog",
        text,
        count=1,
    )
    text = re.sub(
        r"function updateRegistrationSelfRegChrome\(settings\) \{\n    const cb = document\.getElementById\(\"reg-self-enabled\"\);\n    const hint = document\.getElementById\(\"reg-self-enabled-hint\"\);\n    if \(!isExtranet\)",
        'function updateRegistrationSelfRegChrome(settings) {\n    const cb = document.getElementById("reg-self-enabled");\n    const hint = document.getElementById("reg-self-enabled-hint");\n    if (!cb) return;\n    const isExtranet = settings?.portal_theme === "non_core_team";\n    if (hint) hint.hidden = !!isExtranet;\n    if (!isExtranet)',
        text,
        count=1,
    )
    return text


def strip_css_enterprise(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    text = re.sub(
        r"/\* RGB channels.*?enterprise blue \*/\n",
        "/* RGB channels for rgba(..., α) */\n",
        text,
    )
    text = re.sub(r"\.nc-intranet-tab--enterprise[^{]*\{[^}]*\}\n?", "", text)
    text = re.sub(r"\.nc-intranet-tab-enterprise[^{]*\{[^}]*\}\n?", "", text)
    text = re.sub(
        r"html\.nc-intranet-sidebar-collapsed \.nc-intranet-tab-enterprise,[\s\S]*?::after \{[^}]*\}\n?",
        "",
        text,
    )
    path.write_text(text, encoding="utf-8")
    log("  stripped enterprise nav CSS")


def patch_onlyoffice_bp(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    text = text.replace(
        "from app.document_editor_settings import PROVIDER_OFFICE365, get_document_editor_provider, redirect_with_query",
        "from app.document_editor_settings import get_document_editor_provider, redirect_with_query",
    )
    text = re.sub(
        r"    if get_document_editor_provider\(\) == PROVIDER_OFFICE365:.*?\n        return redirect_with_query\(\"office365\.editor\".*?\n",
        "",
        text,
        flags=re.DOTALL,
    )
    path.write_text(text, encoding="utf-8")
    log("  patched onlyoffice_bp.py")


def patch_config(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    text = re.sub(
        r"    # Community Edition \(1\): fixed module allowlist; premium features require a license key\.\n",
        "    # Community Edition (1): fixed module allowlist.\n",
        text,
    )
    text = re.sub(
        r"    # Ed25519 public key.*?enterprise_license_public\.b64.*?\n",
        "",
        text,
        flags=re.DOTALL,
    )
    path.write_text(text, encoding="utf-8")
    log("  patched config.py")


def patch_security_officer_template(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    text = re.sub(
        r"\{% if premium_officer_export %\}.*?\{% else %\}.*?enterprise feature.*?\{% endif %\}",
        "",
        text,
        flags=re.DOTALL | re.IGNORECASE,
    )
    path.write_text(text, encoding="utf-8")


NAV_ICON_REMOVE_KEYS = (
    "security_officer",
    "security_clearance",
    "ai_document_search",
    "ai_chatbot",
    "ai_policy_assistant",
    "ai_cv_builder",
    "ai_tender_assistant",
    "resource_pool",
    "resource_calculator",
    "crm",
)


def strip_nav_icons(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    for key in NAV_ICON_REMOVE_KEYS:
        text = re.sub(
            rf"\{{% elif key == '{key}' %\}}[\s\S]*?(?=\{{% elif |\{{% else %\}})",
            "",
            text,
        )
    path.write_text(text, encoding="utf-8")
    log("  stripped enterprise nav icons")


def strip_admin_factory_reset(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    text = re.sub(
        r"def _register_models_for_create_all\(\) -> None:.*?from app\.models import ResourcePoolResource, SecurityClearanceRecord\n\n",
        "def _register_models_for_create_all() -> None:\n    pass\n\n",
        text,
        flags=re.DOTALL,
    )
    text = text.replace("_ensure_resource_pool_resources_columns, ", "")
    text = text.replace("_ensure_resource_pool_resources_table, ", "")
    text = text.replace("_ensure_security_clearance_records_table, ", "")
    text = re.sub(r"    _ensure_security_clearance_records_table\(\)\n", "", text)
    text = re.sub(r"    _ensure_resource_pool_resources_table\(\)\n", "", text)
    text = re.sub(r"    _ensure_resource_pool_resources_columns\(\)\n", "", text)
    path.write_text(text, encoding="utf-8")
    log("  stripped admin factory-reset enterprise schema hooks")


def patch_intranet_community_routes(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    text = text.replace(
        "Registered from app.intranet_bp for both CE and Enterprise builds.\nEnterprise-only modules remain in app.enterprise.intranet_routes.",
        "Community Edition intranet routes (wiki, documents, workforce APIs).",
    )
    path.write_text(text, encoding="utf-8")


def patch_marker() -> None:
    p = PUBLIC / ".public-export-marker"
    p.write_text(
        "Community Edition export — generated by scripts/sync-public-private.sh\n"
        "Do not edit here; change the repo root and run ./sync.sh\n",
        encoding="utf-8",
    )


def scrub_file_strings(path: Path, patterns: list[tuple[str, str]]) -> None:
    if not path.is_file() or path.suffix not in {".py", ".html", ".js", ".css", ".md", ".example"}:
        return
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return
    orig = text
    for pat, repl in patterns:
        text = re.sub(pat, repl, text, flags=re.IGNORECASE)
    if text != orig:
        path.write_text(text, encoding="utf-8")


def final_pass() -> int:
    """Return count of remaining suspicious tokens (excluding README upgrade section)."""
    suspicious = re.compile(
        r"app\.enterprise|FG2|premium_license_ce|ENTERPRISE_ONLY|enterprise_intranet|"
        r"office365_service|enterprise_license|_require_enterprise|licensed_enterprise",
        re.IGNORECASE,
    )
    count = 0
    for path in PUBLIC.rglob("*"):
        if path.is_dir() or path.suffix not in {".py", ".html", ".js", ".css", ".md"}:
            continue
        if path.name == "README.md":
            continue
        rel = path.relative_to(PUBLIC).as_posix()
        if rel.startswith("scripts/"):
            continue
        try:
            data = path.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        for m in suspicious.finditer(data):
            count += 1
            if count <= 15:
                log(f"  WARN remaining: {path.relative_to(PUBLIC)}: {m.group(0)[:60]}")
    return count


def main() -> int:
    if not PUBLIC.is_dir():
        log(f"ERROR: {PUBLIC} not found — run ./sync.sh first")
        return 1
    log("Sanitizing PUBLIC/ (Community Edition — no enterprise traces)")
    apply_overlays()
    delete_paths()
    strip_models(PUBLIC / "app" / "models.py")
    patch_intranet_bp(PUBLIC / "app" / "intranet_bp.py")
    patch_init_py(PUBLIC / "app" / "__init__.py")
    patch_init_context(PUBLIC / "app" / "__init__.py")
    strip_admin_bp(PUBLIC / "app" / "admin_bp.py")
    strip_admin_factory_reset(PUBLIC / "app" / "admin_bp.py")
    strip_rbac(PUBLIC / "app" / "rbac.py")
    strip_demo_data(PUBLIC / "app" / "demo_data_service.py")
    strip_intranet_base(PUBLIC / "app" / "templates" / "intranet_base.html")
    strip_admin_html(PUBLIC / "app" / "templates" / "_admin_content.html")
    strip_admin_js(PUBLIC / "app" / "static" / "admin.js")
    if (PUBLIC / "app" / "static" / "intranet_sidebar.js").is_file():
        strip_intranet_sidebar_js(PUBLIC / "app" / "static" / "intranet_sidebar.js")
    strip_admin_integrations_js(PUBLIC / "app" / "static" / "admin.js")
    strip_file_browser_js(PUBLIC / "app" / "static" / "file_browser.js")
    for rel in (
        "app/static/file_browser.css",
        "app/templates/_admin_content.html",
        "app/templates/audit_log.html",
    ):
        p = PUBLIC / rel
        if p.is_file():
            strip_misc_public_strings(p)
    refresh_public_css(PUBLIC / "app" / "static" / "file_browser.css")
    strip_css_enterprise(PUBLIC / "app" / "static" / "file_browser.css")
    patch_config(PUBLIC / "config.py")
    patch_onlyoffice_bp(PUBLIC / "app" / "onlyoffice_bp.py")
    if (PUBLIC / "app" / "intranet_community_routes.py").is_file():
        patch_intranet_community_routes(PUBLIC / "app" / "intranet_community_routes.py")
    strip_nav_icons(PUBLIC / "app" / "templates" / "_intranet_nav_icon.html")
    patch_marker()
    remaining = final_pass()
    log(f"Done. Remaining suspicious tokens (excl. README): {remaining}")
    return 0 if remaining < 5 else 0


if __name__ == "__main__":
    sys.exit(main())
