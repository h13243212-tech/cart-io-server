#!/usr/bin/env bash
# Start the bridge inside the Kali VM.
#
#   bash kali/start.sh              normal
#   bash kali/start.sh --no-pair    refuse automatic pairing
#
# Double-clicking works in most file managers. Keep this window open while you
# work — it *is* the bridge, and its log is your audit trail.
cd "$(dirname "$0")" || exit 1

if ! command -v python3 >/dev/null 2>&1; then
  echo ""
  echo "  python3 is missing. Install it with:"
  echo "      sudo apt install -y python3"
  echo ""
  read -r -p "  Press Enter to close." _
  exit 1
fi

echo ""
echo "  Starting the Arena bridge. Leave this window open."
echo ""
exec python3 bridge_agent.py "$@"
