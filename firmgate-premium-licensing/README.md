# Firmgate premium licensing (vendor / private)

Sign **FG2** enterprise license keys with Ed25519. The public app only verifies keys; it cannot mint them.

## One-time setup

```bash
cd firmgate-premium-licensing
python3 generate_keypair.py
```

This creates `enterprise_license_private.pem` in this folder and `app/enterprise_license_public.b64` in the repo root.

## Generate a key

```bash
./generate_license.py --all --expires 2026-12-31 --subject "Customer Name"
```

Or specific features:

```bash
./generate_license.py --feature office365 --feature ldap --expires 2026-12-31
```

All AI enterprise features (Document Search + Chatbot):

```bash
./generate_license.py --ai --expires 2026-12-31 --subject "Customer Name"
```

Paste the printed `FG2.…` key under **Administration → Enterprise Features**.

Each generated key is recorded in `issued_licenses.json` (gitignored) with fingerprint, subject, features, and expiry.

List all licenses in the vendor ledger (issued and revoked):

```bash
./generate_license.py --list-all
```

The same flag works on `./revoke_license.py --list-all`. Use `./revoke_license.py --list` for revoked entries only.

## Revoke a license

Revocation is enforced by a **fingerprint blocklist** on each Firmgate server (16-character id derived from the full key string). A revoked key remains cryptographically valid but the app refuses to activate or use it.

### Vendor ledger (this folder)

Record a revocation in your private ledger (`revoked_licenses.json` is gitignored):

```bash
./revoke_license.py --key "FG2.…" --reason "Contract ended"
```

Or by fingerprint if you only store fingerprints when issuing keys:

```bash
./revoke_license.py --fingerprint a1b2c3d4e5f67890 --subject "Customer Name" --reason "Non-payment"
```

List recorded revocations:

```bash
./revoke_license.py --list
```

Export entries for customer import:

```bash
./revoke_license.py --print-import
```

### On the customer server

**If the license is still active** on that server:

1. **Administration → Enterprise Features → Revoke license** — disables enterprise features and adds the key fingerprint to the blocklist so the same key cannot be pasted back.

**Clear license** only removes the key from the server; the same `FG2.…` string can be activated again unless it was revoked.

**If you maintain a vendor ledger**, push revocations to each deployment (for example after a refund or when a key was leaked before activation):

```http
PUT /admin/api/settings/premium-license
Content-Type: application/json

{
  "import_revoked": [
    {
      "fingerprint": "a1b2c3d4e5f67890",
      "subject": "Customer Name",
      "expires_at": "2026-12-31",
      "reason": "Contract ended"
    }
  ]
}
```

Use `./revoke_license.py --print-import` to generate the `import_revoked` array from `revoked_licenses.json`.

Other API options (same endpoint):

| Body field | Effect |
|------------|--------|
| `revoke: true` | Revoke the currently active license (same as the admin button) |
| `revoke_key` | Block a specific `FG2.…` string without activating it |
| `revoke_fingerprint` | Block by 16-character fingerprint |

## Feature ids

| Id | Unlocks |
|----|---------|
| `self_registration` | Extranet self-service sign-up |
| `office365` | Microsoft 365 / Office Online integration |
| `ldap` | LDAP / Active Directory integration |
| `security_officer_export` | Security Officer PDF report |
| `security_encryption` | Security encryption settings |
| `ai_document_search` | AI Document Search (chat over documents) |

## Notes

- Use expiry dates as **YYYY-MM-DD** (e.g. `2026-06-03`, not `2026-6-3`).
- Optional: `export FIRMGATE_LICENSE_PRIVATE_KEY=/path/to/enterprise_license_private.pem`
- Legacy **FG1** (HMAC) keys are no longer accepted.
- Re-issue a new key after revocation if the customer should continue with enterprise features.
