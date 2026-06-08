# PRIVATE — not for public GitHub

Rebuilt by `scripts/sync-public-private.sh`. Holds commercial and operational material.

| Item | Purpose |
|------|---------|
| `firmgate-premium-licensing/` | Ed25519 license signing (private key never in git) |
| `upload.sh` / `push.sh` | Push to private / internal git remotes |
| `.solstak-backup.env` | Gitea credentials for full backup (gitignored) |
| `dist/` | Build output mirror |
| `RELEASE/COMMUNITY/` | Community Edition upgrade ZIPs |
| `RELEASE/ENTERPRISE/` | Enterprise Edition upgrade ZIPs |
| `RELEASES/` | Legacy combined release ZIPs |
| `instance/`, `.env` | Local snapshots (confidential) |

Develop in the **repo root**; run `./sync.sh` after each change batch.
Publish open source from **PUBLIC/** only (`./gitpush.sh`).
Build edition ZIPs with `scripts/build_edition_packages.sh` → `PRIVATE/RELEASE/`.
Full Gitea backup: copy `.solstak-backup.env.example` → `.solstak-backup.env`, then `./scripts/release-and-backup.sh`.
