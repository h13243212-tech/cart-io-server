#!/usr/bin/env bash
# Start the bridge inside the Kali VM.
#
#   bash kali/start.sh                    normal
#   bash kali/start.sh --no-pair          refuse automatic pairing
#   AKB_BIND_LOOPBACK=1 bash kali/start.sh  keep it on 127.0.0.1 (SSH tunnel setup)
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

# --- VirtualBox NAT -------------------------------------------------------
# A VirtualBox NAT port-forward delivers the connection to the VM's own
# address (10.0.2.15), never to its loopback. An agent bound to 127.0.0.1 is
# therefore invisible to the forward: the host gets "connection refused" while
# the agent happily reports it is listening. So when we can tell we are behind
# VirtualBox NAT, bind the adapter instead.
#
# That is not a hole worth panicking about: with a NAT adapter the port is
# reachable only from inside the VM and through the host-side forward, which
# the setup scripts bind to 127.0.0.1. Use AKB_BIND_LOOPBACK=1 (and an SSH
# tunnel) if you want the old behaviour anyway.
want_host=0
for arg in "$@"; do
  case "$arg" in
    --host|--host=*) want_host=1 ;;
  esac
done

if [ "$want_host" -eq 0 ] && [ "${AKB_BIND_LOOPBACK:-0}" != "1" ] && command -v ip >/dev/null 2>&1; then
  if ip -4 -o addr show 2>/dev/null | grep -q ' 10\.0\.2\.15/'; then
    echo ""
    echo "  VirtualBox NAT detected: listening on all interfaces inside the VM,"
    echo "  otherwise the host port-forward cannot reach it. Nothing outside the"
    echo "  VM can get here except through that forward."
    set -- "$@" --host 0.0.0.0
  fi
fi

echo ""
echo "  Starting the Arena bridge. Leave this window open."
echo ""
exec python3 bridge_agent.py "$@"
