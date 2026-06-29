import os
from pathlib import Path


class Config:
    # Production default: debug off. For local dev only: FLASK_DEBUG=1 or DEBUG=1.
    DEBUG = os.environ.get("FLASK_DEBUG", os.environ.get("DEBUG", "0")).lower() in (
        "1",
        "true",
        "yes",
    )
    SECRET_KEY = os.environ.get("SECRET_KEY", "dev-change-me-in-production")
    PORTAL_PRODUCT_NAME = os.environ.get("PORTAL_PRODUCT_NAME", "Firmgate")
    # Label shown in Google / Microsoft Authenticator when scanning the MFA QR code.
    MFA_ISSUER = os.environ.get("MFA_ISSUER", PORTAL_PRODUCT_NAME)
    SQLALCHEMY_DATABASE_URI = os.environ.get(
        "DATABASE_URL",
        "sqlite:///" + str(Path(__file__).resolve().parent / "instance" / "secure_browser.db"),
    )
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    # Optional STUN for Team Chat WebRTC voice (LAN-only installs can leave empty).
    WEBRTC_STUN_URL = os.environ.get("WEBRTC_STUN_URL", "stun:stun.l.google.com:19302")
    # Team Chat voice: webrtc (intranet signaling) or jitsi (iframe; set JITSI_BASE_URL for self-hosted).
    VOICE_CALL_MODE = os.environ.get("VOICE_CALL_MODE", "webrtc").strip().lower()
    JITSI_BASE_URL = os.environ.get("JITSI_BASE_URL", "https://meet.jit.si").strip().rstrip("/")
    # Empty: use bundled app/static/vendor/lemmings/ only if config.json + game data exist; else embed GitHub Pages.
    LEMMINGS_GAME_URL = os.environ.get("LEMMINGS_GAME_URL", "").strip()
    UPLOAD_ROOT = Path(os.environ.get("UPLOAD_ROOT", Path(__file__).resolve().parent / "instance" / "uploads"))
    # Base URL Document Server uses to reach /onlyoffice/file and /onlyoffice/callback (Docker: host.docker.internal).
    ONLYOFFICE_APP_URL = (os.environ.get("ONLYOFFICE_APP_URL") or "").strip().rstrip("/")
    # Max request size (this app uploads one file per request, so this is the per-file limit).
    # Override without code changes via env var MAX_UPLOAD_MB.
    # Default raised to support multi-GB uploads; tune via MAX_UPLOAD_MB.
    MAX_CONTENT_LENGTH = int(os.environ.get("MAX_UPLOAD_MB", "4096")) * 1024 * 1024
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    REMEMBER_COOKIE_HTTPONLY = True
    # When false, Git upgrade/rollback APIs return 503 (use for locked-down / read-only installs).
    ENABLE_SOFTWARE_GIT_UPGRADE = os.environ.get("ENABLE_SOFTWARE_GIT_UPGRADE", "1").lower() in (
        "1",
        "true",
        "yes",
    )
    # Git working tree for admin "Upgrade from Git" (production default: /root/intranet).
    DEPLOY_ROOT = os.environ.get("DEPLOY_ROOT")
    PRODUCTION_DEPLOY_ROOT = "/root/intranet"
    # Git binary for Administration → Software version. None = auto (/usr/bin/git, shutil.which, …).
    GIT_EXECUTABLE = os.environ.get("GIT_EXECUTABLE") or None
    # After admin "Upgrade from Git": systemctl restart this unit (empty = skip restart).
    SOFTWARE_UPGRADE_SERVICE_NAME = (os.environ.get("SOFTWARE_UPGRADE_SERVICE_NAME") or "intranet").strip()
    # Light backups (.env + SQLite only) before upgrade.
    SOFTWARE_UPGRADE_BACKUP_ROOT = os.environ.get("SOFTWARE_UPGRADE_BACKUP_ROOT") or "/root/intranet-backups"
    # Module allowlist (1 = enforce built-in module list).
    COMMUNITY_EDITION = os.environ.get("COMMUNITY_EDITION", "1").lower() in ("1", "true", "yes")
    # AI Document Search (OpenAI-compatible chat completions API).
    AI_LLM_API_KEY = os.environ.get("AI_LLM_API_KEY") or os.environ.get("OPENAI_API_KEY") or ""
    AI_LLM_BASE_URL = (os.environ.get("AI_LLM_BASE_URL") or "https://api.openai.com/v1").strip().rstrip("/")
    AI_LLM_MODEL = (os.environ.get("AI_LLM_MODEL") or "gpt-4o-mini").strip()
    AI_LLM_SKIP_TLS_VERIFY = os.environ.get("AI_LLM_SKIP_TLS_VERIFY", "").lower() in ("1", "true", "yes")
    AI_DOC_INDEX_BATCH = int(os.environ.get("AI_DOC_INDEX_BATCH", "120"))
    AI_LLM_EMBEDDING_MODEL = (os.environ.get("AI_LLM_EMBEDDING_MODEL") or "text-embedding-3-small").strip()
    AI_DOC_CHUNK_CHARS = int(os.environ.get("AI_DOC_CHUNK_CHARS", "2000"))
    AI_DOC_MAX_CHUNKS = int(os.environ.get("AI_DOC_MAX_CHUNKS", "150"))
