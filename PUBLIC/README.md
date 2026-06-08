# Firmgate

**Self-hosted intranet for teams** — news, wiki, chat, documents, workforce directory, and security workflows in one stack you run on **your** hardware. No mandatory SaaS, no per-seat cloud tax.

> **This repository is the open-source Community Edition only.**  
> A separate commercial edition is available from your supplier; it is not included here. See [Commercial edition](#commercial-edition) below.

This tree is **Firmgate Community Edition** — open source under [Apache 2.0](LICENSE). It ships a focused module set for internal portals.

![Firmgate — home with navigation and announcements](docs/screenshots/home.png)

---

## Community Edition at a glance

Community Edition is the default when `COMMUNITY_EDITION=1` (see [`.env.example`](.env.example)). The app enforces a **fixed module allowlist**.

### Included modules (Community Edition)

| Module | Description |
|--------|-------------|
| **Home** | Configurable landing page and announcements |
| **Blogs** | Internal posts (admin authoring) |
| **Events** | Shared calendar (day / month / year), public holidays |
| **Wiki** | Knowledge base with sanitised HTML |
| **Team Chat** | Rooms, messaging, optional WebRTC / Jitsi voice |
| **Workforce** | Employee directory, presence, admin editing |
| **Workforce Dashboard** | Workforce metrics and views |
| **Security Training** | Training content library |
| **Documents** | Folders, uploads, sharing, viewers, OnlyOffice when configured |
| **About Company** | Editable company profile |
| **Games** | Chess, Lemmings, Sky Control |
| **Administration** | Users, groups, roles, modules, backups, branding |

### Commercial edition

Additional capabilities are offered as a **separate product** from your supplier. That edition is not published in this repository and cannot be built from this source tree alone.

---

## Upgrading to the commercial edition

If you need capabilities beyond Community Edition:

1. **Contact your supplier** for the commercial release package and any licence terms that apply to your organisation.
2. **Deploy that package** on your server (package upgrade via **Administration → Software version**, or a fresh install). This is **not** a `git pull` from this public repository.
3. **Keep your data:** on the same server, a package upgrade usually preserves `instance/` (database and uploads). When moving to a new host, use **Administration → Backup and restore** (download on Community Edition, restore on the commercial deployment).

Backups from Community Edition are **runtime data** (database, uploads, branding), not application code, and can be restored on a commercial deployment when your supplier confirms compatibility.

---

## Why self-hosted?

| Benefit | What it means |
|---------|----------------|
| **Your infrastructure** | SQLite (default), uploads, and config stay on **your** servers |
| **One system** | Intranet, documents, workforce, and compliance tools in one deployable app |
| **Air-gap friendly** | LAN, VPN, or regulated networks where data must not leave the site |
| **Apache 2.0** | Use and modify Community Edition freely; optional paid support is separate |
| **Full admin control** | Users, roles, modules, backups, factory reset, and branding from **Administration** |

---

## Screenshots

Gallery captured from Community Edition (`COMMUNITY_EDITION=1`). Regenerate after UI changes:

```bash
python run.py   # http://127.0.0.1:5001
python3 -m pip install playwright && python3 -m playwright install chromium
python3 scripts/capture_readme_screenshots.py
python3 scripts/update_readme_screenshots.py   # optional branding pass
```

### Home

Configurable landing page with announcements and hero content.

![Firmgate — home](docs/screenshots/home.png)

### Blogs

Internal posts with categories; permitted authors can publish new entries.

![Firmgate — blogs](docs/screenshots/blogs.png)

### Events

Shared calendar with day, month, and year views.

![Firmgate — events calendar](docs/screenshots/events.png)

### Wiki

Internal knowledge base with rich text and page navigation.

![Firmgate — wiki](docs/screenshots/wiki.png)

### Team Chat

Chat rooms, members, attachments, and optional voice calls.

![Firmgate — team chat](docs/screenshots/team-chat.png)

### Documents

Folder tree, uploads, sharing, favourites, and in-browser previews.

![Firmgate — documents](docs/screenshots/documents.png)

### Workforce

Employee directory with search, tags, and presence.

![Firmgate — workforce directory](docs/screenshots/workforce.png)

### Games

Built-in games for informal team engagement.

![Firmgate — games](docs/screenshots/games.png)

### Administration

User management, roles, integrations, backups, and module toggles.

![Firmgate — administration users](docs/screenshots/administration-users.png)

![Firmgate — administration modules (Community Edition allowlist)](docs/screenshots/administration-modules.png)

---

## Requirements

### Server / development machine

| Requirement | Notes |
|-------------|--------|
| **Python 3.10+** | 3.11 recommended |
| **Git** | Clone and deploy updates |
| **SQLite** | Default database (bundled with Python) |
| **Disk space** | Depends on document uploads (`UPLOAD_ROOT`) |
| **Docker** (optional) | Docker Engine + Compose v2 for container deploy |

### Python dependencies

```bash
pip install -r requirements.txt
```

Production also uses **Gunicorn** (installed by `scripts/update.sh` if missing).

### Optional (by feature)

| Feature | What you need |
|---------|----------------|
| **HTTPS reverse proxy** | nginx, Caddy, or similar (strongly recommended in production) |
| **OnlyOffice** | Document Server + reachable callback URL (Community Edition) |
| **Microsoft 365 editing** | Enterprise Edition only (Azure app + supplier licence) |
| **Outbound email** | SMTP (custom, Microsoft 365, or Google Workspace) |
| **LDAP / AD** | Enterprise Edition only (directory server + supplier licence) |
| **Large uploads** | `MAX_UPLOAD_MB` and proxy `client_max_body_size` |

---

## Default administrator (factory bootstrap)

On a **fresh install** (empty database):

| Field | Value |
|-------|--------|
| **Email** | `admin@example.com` |
| **Password** | `admin` |

**Change this password before production.**

Once **any other active user** has `admin.all`, the bootstrap account is **automatically deactivated**. **Factory reset** restores the same credentials on a wiped portal.

---

## Install in minutes

Clone the repository, set a secret key, and run with **Docker Compose** — or use a [release ZIP](#release-zip-air-gapped-servers) for air-gapped servers.

1. Copy `.env.example` to `.env` and set `SECRET_KEY`
2. Run `docker compose up -d --build`
3. Open the portal and sign in with the factory bootstrap admin
4. Create your real administrator and change passwords before production

**Default bootstrap** (fresh install only): `admin@example.com` / `admin` — deactivated automatically once another admin exists.

### Docker Compose (recommended)

```bash
git clone https://github.com/snooth/firmgate.git
cd firmgate
cp .env.example .env
# Set SECRET_KEY (openssl rand -hex 32)
docker compose up -d --build
```

Open **http://127.0.0.1:5001/** (or the host port from `FIRMGATE_HTTP_PORT` in `.env`). Put **nginx** or **Caddy** in front for HTTPS in production.

| Item | Location |
|------|----------|
| App | `firmgate` container |
| Database + uploads | Docker volume `firmgate_data` → `/data/instance` |
| Secrets | `.env` on the host |

### Local development

```bash
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env        # set SECRET_KEY; COMMUNITY_EDITION=1 is the default
python run.py
# http://127.0.0.1:5001/
```

Optional: `python seed_data.py` on an empty database (bootstrap admin only, no demo data).

### Release ZIP (air-gapped servers)

Community Edition release packages can be built from this tree with `scripts/build_edition_packages.sh` (maintainer workflow). Commercial release packages are supplied separately by your vendor.

**First install:** unzip on the server, create `.env`, virtualenv, `pip install -r requirements.txt`, run Gunicorn ([production deployment](#production-deployment-start-to-finish)).

**In-place upgrade (same edition):** **Administration → Software version → Upgrade from package** when `ENABLE_SOFTWARE_PACKAGE_UPGRADE=1`. Use a package built for the edition you are running.

---

## Using the application

### Navigation (Community Edition)

After sign-in, the sidebar lists modules enabled for your account. Community Edition never shows **CRM**, **Security Clearance**, or **Resource Pool** in the nav.

Typical end-user flow:

1. **Home** — announcements  
2. **Documents** — files and sharing  
3. **Events** / **Wiki** / **Team Chat** — collaboration  
4. **Workforce** — find colleagues  

### Roles and permissions

Built-in roles include **Standard**, **Power**, and **admin**. Fine-grained permissions are under **Administration → Roles & permissions**. **Groups** grant roles in bulk.

### Administration

| Section | Purpose |
|---------|---------|
| **Users / Groups / Roles** | Accounts and access |
| **Registrations** | Approve Extranet self-sign-ups (licensed add-on) |
| **Integrations** | OnlyOffice (Community Edition) |
| **Email Settings** | Outbound SMTP |
| **Portal customisation** | Logo, theme, home content |
| **Modules** | Show/hide Community Edition nav items |
| **Backup and restore** | Download backup, restore, factory reset |
| **Software version** | Git or package upgrade |

### Documents and editing

- Upload via **Documents** or drag-and-drop  
- **OnlyOffice** works in Community Edition when configured  
- PDFs, images, and `.eml` use built-in viewers  

### End-user documentation

[`docs/User_Manual.html`](docs/User_Manual.html) — regenerate figures with `scripts/generate_manual_figure_images.py` and `scripts/build_user_manual_docx.py`.

---

## Production deployment (start to finish)

```
Internet → nginx (TLS) → Gunicorn → Flask
                              ↓
                    instance/ (SQLite + uploads)
                    .env (secrets)
```

Recommended layout:

| Path | Purpose |
|------|---------|
| `/root/intranet` | Git checkout (application code) |
| `/root/intranet_instance` | Database + uploads (symlink as `instance/`) |
| `/root/intranet-backups` | Pre-upgrade backups |

### Steps (summary)

1. Install Python 3, git, nginx  
2. Clone `https://github.com/snooth/firmgate.git`  
3. Symlink external `instance/`  
4. Create `.env` with `SECRET_KEY`, `FLASK_DEBUG=0`, `DATABASE_URL`, `UPLOAD_ROOT`, `COMMUNITY_EDITION=1`  
5. `python3 -m venv .venv && pip install -r requirements.txt gunicorn`  
6. Initialise DB: `.venv/bin/python -c "from app import create_app; create_app()"`  
7. systemd unit running Gunicorn on `127.0.0.1:5001`  
8. nginx TLS reverse proxy with large `client_max_body_size`  
9. Sign in, create real admin, configure integrations  

Example systemd and nginx blocks are unchanged from prior releases — see git history or your vendor runbook if you need the full snippets.

Install the server update helper:

```bash
sudo cp /root/intranet/scripts/root-update.sh /root/update.sh
sudo chmod +x /root/update.sh
```

---

## Updating production

**Server:**

```bash
sudo /root/update.sh
```

---

## Configuration

| Variable | Purpose | Default |
|----------|---------|---------|
| `SECRET_KEY` | Flask sessions | `dev-change-me-in-production` |
| `COMMUNITY_EDITION` | Enforce CE module allowlist | `1` |
| `DATABASE_URL` | SQLAlchemy URI | `sqlite:///instance/secure_browser.db` |
| `UPLOAD_ROOT` | Document storage | `instance/uploads` |
| `MAX_UPLOAD_MB` | Max upload size | `4096` |
| `PORT` | Dev server port | `5001` |
| `ONLYOFFICE_APP_URL` | Callback base URL for Document Server | (request root) |
| `ENABLE_SOFTWARE_GIT_UPGRADE` | Admin Git upgrade | enabled |
| `ENABLE_SOFTWARE_PACKAGE_UPGRADE` | Admin ZIP upgrade | enabled |

See [`config.py`](config.py) and [`.env.example`](.env.example) for the full list.

---

## Integrations

Configure under **Administration → Integrations**.

- **OnlyOffice** — available in Community Edition when Document Server is configured  
- **Email** — SMTP under **Email Settings**  

---

## Backup and factory reset

**Administration → Backup and restore**

| Action | Effect |
|--------|--------|
| **Download backup** | Zip of database, uploads, branding |
| **Restore** | Replace from zip (destructive) |
| **Factory reset** | Wipe portal; restore bootstrap admin |
| **Add demo data** | Sample content (~20% per module) |

Backups are edition-agnostic runtime data: a zip created on Community Edition can be restored on an Enterprise deployment (and vice versa), as long as the target install uses the same backup format.

Factory reset requires typing `FACTORY RESET`. If the database file is locked, stop extra workers and retry; the server can fall back to an in-place schema wipe.

---

## Troubleshooting

| Symptom | What to check |
|---------|----------------|
| **Module missing from nav** | Check **Administration → Modules** — Community Edition uses a fixed allowlist |
| **Cannot sign in as bootstrap** | Use real admin or factory reset |
| **Upload HTTP 413** | `MAX_UPLOAD_MB` and nginx body size |
| **OnlyOffice won’t save** | App URL reachable from Document Server |
| **Factory reset fails** | Stop Gunicorn/reloader workers; retry |
| **Package upgrade rejected** | ZIP must include `firmgate/manifest.json` |

---

## Repository layout

```
app/                 Flask application
config.py            Defaults
run.py               Dev entrypoint / Gunicorn target
requirements.txt     Dependencies
scripts/             Build, update, screenshot, sync helpers
docs/screenshots/    README gallery (Community Edition)
instance/            Runtime data (gitignored)
LICENSE              Apache 2.0
COMMERCIAL.md        Optional commercial terms
```

---

