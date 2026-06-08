# Release packages (by edition)

| Folder | Contents |
|--------|----------|
| `COMMUNITY/` | Community Edition upgrade ZIPs (built from `PUBLIC/`) |
| `ENTERPRISE/` | Enterprise Edition upgrade ZIPs (full app from repo root) |

Built with `scripts/build_edition_packages.sh`. Upload via **Administration → Software version → Upgrade from package**.

Legacy combined builds may still appear under `PRIVATE/RELEASES/` from `scripts/build_release_package.sh`.
