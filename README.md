# Firmgate

**Self-hosted intranet for teams** — news, wiki, chat, documents, workforce directory, and compliance workflows in one stack you run on **your** hardware. No mandatory SaaS, no per-seat cloud tax.

Licensed under [Apache 2.0](LICENSE).

![Firmgate — home with navigation and announcements](docs/screenshots/home.png)

---

## At a glance

| Module | What it does |
|--------|----------------|
| **Home** | Configurable landing page — hero banner, announcement cards, quick links, and “at a glance” stats. |
| **Blogs** | Internal news posts with categories. |
| **Events** | Shared calendar with day, month, and year views. |
| **Wiki** | Knowledge base with sanitised HTML pages, sidebar navigation, and search. |
| **Team Chat** | Chat rooms, attachments, unread badges, and optional WebRTC voice calls. |
| **Workforce** | Employee directory — search, tags, presence, and profile pages. |
| **Workforce Dashboard** | Workforce metrics and summary views for managers. |
| **Security Training** | Training content library and completion tracking. |
| **Documents** | Folder tree, uploads, sharing, favourites, trash, and in-browser previews. **OnlyOffice** editing when Document Server is configured. |
| **About Company** | Editable company profile — mission, contacts, and glance figures. |
| **Games** | Built-in Chess, Lemmings, and Sky Control. |
| **Administration** | Users, roles, groups, modules, integrations, email, portal branding, backup/restore, and software updates. |

Enable or restrict modules under **Administration → Modules**.

---

## Screenshots

Images are stored in [`docs/screenshots/`](docs/screenshots/).

### Home

Configurable landing page with announcements and hero content.

![Firmgate — home](docs/screenshots/home.png)

### Blogs

Internal posts with categories; permitted authors can publish new entries.

![Firmgate — blogs](docs/screenshots/blogs.png)

### Events

Shared calendar with day, month, and year views.

![Firmgate — events](docs/screenshots/events.png)

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

![Firmgate — workforce](docs/screenshots/workforce.png)

### Games

Built-in games for informal team engagement.

![Firmgate — games](docs/screenshots/games.png)

### Administration — Users

User accounts, roles, groups, and access control.

![Firmgate — administration users](docs/screenshots/administration-users.png)

### Administration — Modules

Enable or restrict intranet modules per role and user.

![Firmgate — administration modules](docs/screenshots/administration-modules.png)

### Regenerating screenshots

The gallery is produced from a running local instance using [Playwright](https://playwright.dev/python/).

**1. Start Firmgate** (default port `5001`):

```bash
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env        # set SECRET_KEY
python run.py
```

**2. Install capture dependencies** (one-time):

```bash
pip install playwright pillow
python3 -m playwright install chromium
```

**3. Capture pages** (logs in as bootstrap admin `admin@example.com` / `admin`):

```bash
python3 scripts/capture_readme_screenshots.py
```

**4. Optional branding pass** — overlays the Firmgate header on each PNG (macOS uses `qlmanage` to rasterise the SVG logo):

```bash
python3 scripts/update_readme_screenshots.py
```

To capture richer pages (blogs, wiki articles, chat rooms), add sample content first via **Administration → Backup and restore → Add demo data**, then re-run the capture script.

Edit the shot list in [`scripts/capture_readme_screenshots.py`](scripts/capture_readme_screenshots.py) if you add new README gallery pages.

---

## Requirements

| Requirement | Notes |
|-------------|--------|
| **Python 3.10+** | 3.11 recommended |
| **Git** | Clone and deploy updates |
| **SQLite** | Default database (bundled with Python) |
| **Docker** (optional) | Docker Engine + Compose v2 |

```bash
pip install -r requirements.txt
```

Production uses **Gunicorn** (installed by `scripts/update.sh` if missing).

### Optional integrations

| Feature | What you need |
|---------|----------------|
| **HTTPS reverse proxy** | nginx, Caddy, or similar |
| **OnlyOffice** | Document Server + reachable callback URL |
| **Outbound email** | SMTP (custom, Microsoft 365, or Google Workspace) |
| **SIP phone** | PBX with WebSocket transport (optional, under Administration → SIP Client) |
| **Large uploads** | `MAX_UPLOAD_MB` and proxy `client_max_body_size` |

---

## Install

### Default administrator (factory bootstrap)

| Field | Value |
|-------|--------|
| **Email** | `admin@example.com` |
| **Password** | `admin` |

Change before production. Bootstrap admin is **deactivated** once another user has full admin rights. **Factory reset** restores it.

### Docker Compose (recommended)

```bash
git clone <your-repository-url>
cd firmgate
cp .env.example .env
# Set SECRET_KEY: openssl rand -hex 32
docker compose up -d --build
```

Open **http://127.0.0.1:5001/** (or `FIRMGATE_HTTP_PORT`). Use nginx or Caddy for HTTPS in production.

| Item | Location |
|------|----------|
| App | `firmgate` container |
| Database + uploads | Docker volume `firmgate_data` → `/data/instance` |
| Secrets | `.env` on the host |

### Local development

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # set SECRET_KEY
python run.py               # http://127.0.0.1:5001/
```

Optional: `python seed_data.py` on an empty database to ensure roles and permissions exist.

---

## Using the application

### Navigation

After sign-in, the **sidebar** lists modules enabled for your account.

Typical flows:

1. **Home** — announcements and links
2. **Documents** — files, sharing, editing
3. **Events / Wiki / Team Chat** — collaboration
4. **Workforce** — find colleagues and profiles

### Roles and permissions

Built-in roles include **Standard**, **Power**, and **admin**. Fine-grained permissions live under **Administration → Roles & permissions**. **Groups** grant roles in bulk.

### Documents and editing

- Upload via **Documents** or drag-and-drop
- **OnlyOffice** when Document Server is configured
- PDFs, images, and `.eml` use built-in viewers

### End-user documentation

[`docs/User_Manual.html`](docs/User_Manual.html) — regenerate figures with `scripts/generate_manual_figure_images.py` and `scripts/build_user_manual_docx.py`.

---

## Administration

| Section | Functions |
|---------|-----------|
| **Users** | Create, edit, deactivate accounts; assign roles; reset passwords; MFA. |
| **Groups** | Bulk role assignment. |
| **Roles & permissions** | Fine-grained RBAC. |
| **Modules** | Show/hide sidebar modules; restrict modules to specific users. |
| **Integrations** | OnlyOffice Document Server. |
| **Email Settings** | Outbound SMTP. |
| **Email Notification** | Scheduled reminders for events, wiki, team chat, workforce, and security training. |
| **SIP Client** | Optional browser phone under About Company → Phone. |
| **Portal customisation** | Logo, tab title, theme colours, home page content. |
| **Backup and restore** | Download backup archive, restore, factory reset, optional demo data. |
| **Software version** | Display version, Git pull upgrade, rollback history. |

### Backup and factory reset

| Action | Effect |
|--------|--------|
| **Download backup** | Archive of database, uploads, branding, and settings |
| **Restore** | Replace runtime data from archive (destructive) |
| **Factory reset** | Wipe portal; restore bootstrap admin |
| **Add demo data** | Sample content across modules (~20% fill per click) |

Factory reset requires typing `FACTORY RESET`.

---

## Production deployment

```
Internet → nginx (TLS) → Gunicorn → Flask
                              ↓
                    instance/ (SQLite + uploads)
                    .env (secrets)
```

| Path | Purpose |
|------|---------|
| `/root/intranet` | Application code |
| `/root/intranet_instance` | Database + uploads (symlink as `instance/`) |
| `/root/intranet-backups` | Pre-upgrade backups |

```bash
sudo cp scripts/root-update.sh /root/update.sh
sudo chmod +x /root/update.sh
sudo /root/update.sh
```

---

## Configuration

| Variable | Purpose | Default |
|----------|---------|---------|
| `SECRET_KEY` | Flask sessions | `dev-change-me-in-production` |
| `COMMUNITY_EDITION` | Module allowlist | `1` |
| `DATABASE_URL` | SQLAlchemy URI | `sqlite:///instance/secure_browser.db` |
| `UPLOAD_ROOT` | Document storage | `instance/uploads` |
| `MAX_UPLOAD_MB` | Max upload size | `4096` |
| `PORT` | Dev server port | `5001` |
| `ONLYOFFICE_APP_URL` | Document Server callback base | (request root) |
| `ENABLE_SOFTWARE_GIT_UPGRADE` | Admin Git upgrade | enabled |

See [`config.py`](config.py) and [`.env.example`](.env.example) for more variables.

---

## Troubleshooting

| Symptom | What to check |
|---------|----------------|
| **Module greyed out in admin** | Module allowlist (`COMMUNITY_EDITION=1`) and **Modules** toggles |
| **Cannot sign in as bootstrap** | Use a real admin account or factory reset |
| **Upload HTTP 413** | `MAX_UPLOAD_MB` and nginx `client_max_body_size` |
| **OnlyOffice won’t save** | App URL reachable from Document Server |
| **Screenshot capture fails** | App running on `http://127.0.0.1:5001`; bootstrap admin not deactivated |
| **Factory reset fails** | Stop extra Gunicorn workers; retry |

---

## Repository layout

```
app/                Flask application
config.py           Defaults
run.py              Dev entrypoint / Gunicorn target
requirements.txt    Dependencies
scripts/            Deployment helpers, screenshot capture, manual build
docs/screenshots/   README gallery (PNG)
instance/           Runtime data (gitignored)
LICENSE             Apache 2.0
```

---

## Tech stack

- **Backend:** Flask, Flask-Login, Flask-SQLAlchemy
- **Database:** SQLite (default)
- **Frontend:** Jinja2, vanilla JavaScript, Turbo Drive
- **Production:** Gunicorn + nginx

---

## License

Licensed under the [Apache License 2.0](LICENSE). Trademark notes: [COMMERCIAL.md](COMMERCIAL.md).
