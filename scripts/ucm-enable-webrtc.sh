#!/usr/bin/env bash
# Enable WebRTC on a Grandstream UCM extension via HTTPS API.
# Requires: curl, jq, md5 (or md5sum)
#
# Usage:
#   export UCM_HOST="10.10.4.186"
#   export UCM_API_USER="your_api_user"
#   export UCM_API_PASS="your_api_password"
#   export UCM_EXTENSION="1008"
#   ./scripts/ucm-enable-webrtc.sh

set -euo pipefail

UCM_HOST="${UCM_HOST:-10.10.4.186}"
UCM_PORT="${UCM_PORT:-8089}"
UCM_API_USER="${UCM_API_USER:?Set UCM_API_USER}"
UCM_API_PASS="${UCM_API_PASS:?Set UCM_API_PASS}"
UCM_EXTENSION="${UCM_EXTENSION:-1008}"
UCM_API="https://${UCM_HOST}:${UCM_PORT}/api"

md5hex() {
  if command -v md5 >/dev/null 2>&1; then
    md5 -q
  else
    md5sum | awk '{print $1}'
  fi
}

api() {
  curl -sk -H "Content-Type: application/json;charset=UTF-8" -d "$1" "$UCM_API"
}

echo "==> Challenge"
CHALLENGE_RESP=$(api "{\"request\":{\"action\":\"challenge\",\"user\":\"${UCM_API_USER}\",\"version\":\"1.0\"}}")
echo "$CHALLENGE_RESP" | jq .
STATUS=$(echo "$CHALLENGE_RESP" | jq -r '.status')
if [[ "$STATUS" != "0" ]]; then
  echo "Challenge failed. Enable HTTPS API on the UCM and whitelist this machine's IP." >&2
  exit 1
fi
CHALLENGE=$(echo "$CHALLENGE_RESP" | jq -r '.response.challenge')
TOKEN=$(printf "%s%s" "$CHALLENGE" "$UCM_API_PASS" | md5hex)

echo "==> Login"
LOGIN_RESP=$(api "{\"request\":{\"action\":\"login\",\"user\":\"${UCM_API_USER}\",\"token\":\"${TOKEN}\"}}")
echo "$LOGIN_RESP" | jq .
STATUS=$(echo "$LOGIN_RESP" | jq -r '.status')
if [[ "$STATUS" != "0" ]]; then
  echo "Login failed." >&2
  exit 1
fi
COOKIE=$(echo "$LOGIN_RESP" | jq -r '.response.cookie')

echo "==> Current extension settings"
api "{\"request\":{\"action\":\"getSIPAccount\",\"cookie\":\"${COOKIE}\",\"extension\":\"${UCM_EXTENSION}\"}}" | jq '.response.extension | {extension, account_type, enable_webrtc, encryption, media_encryption, allow}'

echo "==> Enable WebRTC + SRTP support"
UPDATE_RESP=$(api "{\"request\":{\"action\":\"updateSIPAccount\",\"cookie\":\"${COOKIE}\",\"extension\":\"${UCM_EXTENSION}\",\"enable_webrtc\":\"yes\",\"encryption\":\"support\",\"directmedia\":\"no\",\"nat\":\"yes\",\"allow\":\"ulaw,alaw,g722,gsm,g726,g729,opus,vp8,h264\"}}")
echo "$UPDATE_RESP" | jq .

echo "==> Apply changes"
APPLY_RESP=$(api "{\"request\":{\"action\":\"applyChanges\",\"cookie\":\"${COOKIE}\"}}")
echo "$APPLY_RESP" | jq .

echo "==> Updated extension settings"
api "{\"request\":{\"action\":\"getSIPAccount\",\"cookie\":\"${COOKIE}\",\"extension\":\"${UCM_EXTENSION}\"}}" | jq '.response.extension | {extension, account_type, enable_webrtc, encryption, media_encryption, allow}'

echo "Done. Unregister/register the browser phone, then try dialing 7000."
