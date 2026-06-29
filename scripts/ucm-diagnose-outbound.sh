#!/usr/bin/env bash
# Diagnose outbound (PSTN) calling on a Grandstream UCM:
#   - extension outbound permission (privilege level)
#   - outbound routes (pattern + required permission)
#
# Usage:
#   UCM_API_USER=snoop UCM_API_PASS=secret UCM_EXTENSION=1008 ./scripts/ucm-diagnose-outbound.sh

set -euo pipefail

UCM_HOST="${UCM_HOST:-10.10.4.186}"
UCM_PORT="${UCM_PORT:-8089}"
UCM_API_USER="${UCM_API_USER:?Set UCM_API_USER}"
UCM_API_PASS="${UCM_API_PASS:?Set UCM_API_PASS}"
UCM_EXTENSION="${UCM_EXTENSION:-1008}"
UCM_API="https://${UCM_HOST}:${UCM_PORT}/api"

md5hex() { if command -v md5 >/dev/null 2>&1; then md5 -q; else md5sum | awk '{print $1}'; fi; }
api() { curl -sk -H "Content-Type: application/json;charset=UTF-8" -d "$1" "$UCM_API"; }

CHALLENGE=$(api "{\"request\":{\"action\":\"challenge\",\"user\":\"${UCM_API_USER}\",\"version\":\"1.0\"}}" | jq -r '.response.challenge')
TOKEN=$(printf "%s%s" "$CHALLENGE" "$UCM_API_PASS" | md5hex)
COOKIE=$(api "{\"request\":{\"action\":\"login\",\"user\":\"${UCM_API_USER}\",\"token\":\"${TOKEN}\"}}" | jq -r '.response.cookie')
if [[ -z "$COOKIE" || "$COOKIE" == "null" ]]; then echo "Login failed." >&2; exit 1; fi

echo "==> Extension ${UCM_EXTENSION} outbound permission"
api "{\"request\":{\"action\":\"getSIPAccount\",\"cookie\":\"${COOKIE}\",\"extension\":\"${UCM_EXTENSION}\"}}" \
  | jq '.response.extension | {extension, permission}'

echo "==> Outbound routes (name, required permission, pattern)"
api "{\"request\":{\"action\":\"listOutboundRoute\",\"cookie\":\"${COOKIE}\",\"options\":\"outbound_rt_name,outbound_rt_index,permission,sequence,pattern\"}}" \
  | jq '.response'
