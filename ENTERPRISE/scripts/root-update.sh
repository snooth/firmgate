#!/usr/bin/env bash
# Install on the server as /root/update.sh (fixed production paths).
#   sudo cp /root/intranet/scripts/root-update.sh /root/update.sh
#   sudo chmod +x /root/update.sh
#   sudo /root/update.sh
exec /root/intranet/scripts/update.sh "$@"
