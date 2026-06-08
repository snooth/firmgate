# Firmgate

**Self-hosted intranet for teams** — news, wiki, chat, documents, workforce directory, and security workflows in one stack you run on **your** hardware. No mandatory SaaS, no per-seat cloud tax.

> **This repository is the open-source Community Edition only.**  
> A separate commercial edition is available from your supplier; it is not included here. See [Commercial edition](#commercial-edition) below.

This tree is **Firmgate Community Edition** — open source under [Apache 2.0](LICENSE).

![Firmgate — home with navigation and announcements](docs/screenshots/home.png)

---

## Community Edition at a glance

Community Edition is the default when `COMMUNITY_EDITION=1` (see [`.env.example`](.env.example)). The app enforces a **fixed module allowlist**.

### Included modules

| Module | What it does |
|--------|----------------|
| **Home** | Configurable landing page — hero, announcements, quick links, at-a-glance stats. |
| **Blogs** | Internal news posts with categories; admins publish articles. |
| **Events** | Shared calendar — **day**, **month**, and **year** views; public holidays. |
| **Wiki** | Knowledge base with sanitised HTML, navigation, and search. |
| **Team Chat** | Chat **rooms**, attachments, unread badges, optional **WebRTC / Jitsi** voice. |
| **Workforce** | Employee **directory** — search, tags, presence, profiles, optional photos. |
| **Workforce Dashboard** | Workforce **metrics** and summary views. |
| **Security Training** | Security awareness **content library**. |
| **Documents** | Folders, **upload**, **sharing**, favourites, previews; **OnlyOffice** when configured. |
| **About Company** | Editable **company profile**. |
| **Games** | **Chess**, **Lemmings**, and **Sky Control**. |
| **Administration** | Users, groups, roles, modules, backups, branding, software updates. |

### Commercial edition

Additional capabilities are offered as a **separate product** from your supplier:

| Capability | Examples |
|------------|----------|
| **Business modules** | CRM, Resource Pool, Casual Calculator, Security Clearance, Security Officer, Timesheets |
| **AI assistants** | Document search, chatbot, policy Q&A, CV builder, tender assistant |
| **Integrations** | Microsoft 365 editing, LDAP / Active Directory, self-registration |
| **Security add-ons** | Encryption at rest, Security Officer PDF export |

That edition is not published in this repository and cannot be built from this source tree alone. It requires a vendor release package and **FG2 licence key(s)**.

---

## Upgrading to the commercial edition

1. **Contact your supplier** for the commercial release package and licence terms.
2. **Deploy that package** on your server (**Administration → Software version → Upgrade from package**, or fresh install). This is **not** a `git pull` from this public repository.
3. **Apply your licence key** under **Administration → Enterprise Features** on the commercial build.
4. **Keep your data:** package upgrades preserve `instance/` on the same server; use **Backup and restore** when moving hosts.

Backups from Community Edition are **runtime data** (database, uploads, branding) and can be restored on a commercial deployment when your supplier confirms compatibility.

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

Regenerate after UI changes:

```bash
python run.py   # http://127.0.0.1:5001
python3 -m pip install playwright && python3 -m playwright install chromium
python3 scripts/capture_readme_screenshots.py
python3 scripts/update_readme_screenshots.py
```

### Home

![Firmgate — home](docs/screenshots/home.png)

### Blogs

![Firmgate — blogs](docs/screenshots/blogs.png)

### Events

![Firmgate — events calendar](docs/screenshots/events.png)

### Wiki

![Firmgate — wiki](docs/screenshots/wiki.png)

### Team Chat

![Firmgate — team chat](docs/screenshots/team-chat.png)

### Documents

![Firmgate — documents](docs/screenshots/documents.png)

### Workforce

![Firmgate — workforce directory](docs/screenshots/workforce.png)

### Games

![Firmgate — games](docs/screenshots/games.png)

### Administration — Users

![Firmgate — administration users](docs/screenshots/administration-users.png)

### Administration — Modules

![Firmgate — administration modules](docs/screenshots/administration-modules.png)

### Administration — Enterprise Features (commercial edition)

Licence activation panel — shown when running a commercial build with enterprise admin tabs.

![Firmgate — enterprise features](docs/screenshots/enterprise-features.png)

---

## Administration (Community Edition)

| Section | Functions |
|---------|-----------|
| **Users / Groups / Roles** | Accounts, bulk groups, fine-grained permissions |
| **Modules** | Show/hide Community Edition sidebar items; per-user restrictions |
| **Integrations** | OnlyOffice Document Server |
| **Email Settings** | Outbound SMTP |
| **Portal customisation** | Logo, theme, home page content |
| **Backup and restore** | Download zip, restore, factory reset, demo data |
| **Software version** | Git or package upgrade |

---

## Requirements

| Requirement | Notes |
|-------------|--------|
| **Python 3.10+** | 3.11 recommended |
| **Git** | Clone and deploy updates |
| **SQLite** | Default database |
| **Docker** (optional) | Docker Engine + Compose v2 |

```bash
pip install -r requirements.txt
```

| Optional | Notes |
|----------|--------|
| **HTTPS reverse proxy** | nginx or Caddy (recommended in production) |
| **OnlyOffice** | Document Server + callback URL |
| **Large uploads** | `MAX_UPLOAD_MB` and proxy body size |

---

## Default administrator

| Field | Value |
|-------|--------|
| **Email** | `admin@example.com` |
| **Password** | `admin` |

Change before production. Deactivated once another admin exists. **Factory reset** restores bootstrap credentials.

---

## Install

### Docker Compose

```bash
git clone https://github.com/snooth/firmgate.git
cd firmgate
cp .env.example .env
docker compose up -d --build
```

Open **http://127.0.0.1:5001/**.

### Local development

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python run.py
```

### Release ZIP

Community packages can be built with `scripts/build_edition_packages.sh` (maintainer workflow). Upload via **Administration → Software version → Upgrade from package**.

---

## Using the application

After sign-in, the **sidebar** lists enabled modules. Typical flow: **Home** → **Documents** → **Events / Wiki / Chat** → **Workforce**.

Built-in roles: **Standard**, **Power**, **admin**. Configure permissions under **Administration → Roles & permissions**.

[`docs/User_Manual.html`](docs/User_Manual.html) — end-user guide.

---

## Production deployment

```
Internet → nginx (TLS) → Gunicorn → Flask → instance/ + .env
```

```bash
sudo cp /root/intranet/scripts/root-update.sh /root/update.sh
sudo /root/update.sh   # on-server updates
```

---

## Configuration

| Variable | Purpose |
|----------|---------|
| `SECRET_KEY` | Flask sessions |
| `COMMUNITY_EDITION` | CE allowlist (`1` default) |
| `DATABASE_URL` | Database URI |
| `UPLOAD_ROOT` | Document storage |
| `MAX_UPLOAD_MB` | Upload limit |

See [`.env.example`](.env.example) and [`config.py`](config.py).

---

## Backup and factory reset

| Action | Effect |
|--------|--------|
| **Download backup** | Zip of database, uploads, branding |
| **Restore** | Replace from zip |
| **Factory reset** | Wipe portal; restore bootstrap admin |
| **Add demo data** | Sample content |

Factory reset requires typing `FACTORY RESET`.

---

## Troubleshooting

| Symptom | What to check |
|---------|----------------|
| **Module missing from nav** | **Administration → Modules** |
| **Enterprise features locked** | Commercial package + licence from supplier |
| **Upload HTTP 413** | `MAX_UPLOAD_MB` and nginx |
| **OnlyOffice won’t save** | Callback URL reachable from Document Server |
| **Package upgrade rejected** | ZIP must include `firmgate/manifest.json` |

---

## Repository layout

```
app/                 Flask application
scripts/             Build and deploy helpers
docs/screenshots/    README gallery
instance/            Runtime data (gitignored)
LICENSE              Apache 2.0
COMMERCIAL.md        Commercial terms
```

---

## License

**Community Edition** — [Apache License 2.0](LICENSE). Optional support and commercial edition: [COMMERCIAL.md](COMMERCIAL.md).
