#!/usr/bin/env bash
# Install the bridge inside the Kali VM so it starts on boot and stays up.
#
#   curl -fsSL https://raw.githubusercontent.com/h13243212-tech/cart-io-server/main/kali/install.sh | sudo bash
#
#   sudo bash kali/install.sh                 install / update
#   sudo bash kali/install.sh --port 8788     different port
#   sudo bash kali/install.sh --uninstall     remove everything
#
# After this, the only ongoing action is pressing CONNECT in the panel.
set -u

REPO_URL="https://github.com/h13243212-tech/cart-io-server"
DEST="/opt/arena-kali"
UNIT="/etc/systemd/system/arena-bridge.service"
PORT=8787
ACTION=install

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:-8787}"; shift 2 ;;
    --port=*) PORT="${1#*=}"; shift ;;
    --uninstall) ACTION=uninstall; shift ;;
    -h|--help)
      sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//' ; exit 0 ;;
    *) echo "  unknown option: $1"; exit 1 ;;
  esac
done

# --- root ---------------------------------------------------------------
# A system unit, not a user unit: no lingering, no "it only runs when you are
# logged in", and no password prompts for tools that need root (nmap -sS).
if [ "$(id -u)" -ne 0 ]; then
  if [ -f "${BASH_SOURCE[0]:-}" ] && command -v sudo >/dev/null 2>&1; then
    echo "  (this needs root — re-running with sudo)"
    exec sudo -E bash "${BASH_SOURCE[0]}" "$@"
  fi
  echo "  Run it with sudo:  sudo bash $0"
  exit 1
fi

say() { printf '%s\n' "$*"; }

if [ "$ACTION" = "uninstall" ]; then
  say ""
  say "  Removing the bridge service..."
  systemctl disable --now arena-bridge >/dev/null 2>&1 || true
  rm -f "$UNIT"
  systemctl daemon-reload 2>/dev/null || true
  rm -rf "$DEST"
  say "  [OK] gone. The agent, its unit and $DEST are removed."
  say "       Your browser extension can stay; it just has nothing to talk to."
  say ""
  exit 0
fi

say ""
say "  Arena -> Kali : installing the bridge"
say "  ------------------------------------"
say ""

# --- get the code -------------------------------------------------------
if ! command -v git >/dev/null 2>&1; then
  say "  git is missing. Install it with:  sudo apt install -y git"
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  say "  python3 is missing. Install it with:  sudo apt install -y python3"
  exit 1
fi

if [ -d "$DEST/.git" ]; then
  say "  updating $DEST"
  git -C "$DEST" pull --ff-only -q || say "  (update failed — keeping what is there)"
else
  say "  downloading into $DEST"
  rm -rf "$DEST"
  git clone -q --depth 1 "$REPO_URL" "$DEST" || { say "  clone failed — no internet in the VM?"; exit 1; }
fi

# --- bind address -------------------------------------------------------
# VirtualBox NAT forwards arrive at the VM's own address (10.0.2.15), never at
# its loopback, so a loopback-only agent is unreachable from the host. Same
# rule as kali/start.sh, applied once here because systemd will not re-detect.
HOST="127.0.0.1"
if ip -4 -o addr show 2>/dev/null | grep -q ' 10\.0\.2\.15/'; then
  HOST="0.0.0.0"
  say "  VirtualBox NAT detected — the agent will listen on all interfaces inside the VM"
fi

# --- service ------------------------------------------------------------
if ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then
  say ""
  say "  No systemd here, so nothing to install. Start it by hand instead:"
  say "      bash $DEST/kali/start.sh --port $PORT"
  say "  and to start it at boot, add this to 'crontab -e':"
  say "      @reboot bash $DEST/kali/start.sh --port $PORT >/dev/null 2>&1"
  say ""
  exit 0
fi

say "  writing $UNIT"
cat > "$UNIT" <<UNITFILE
[Unit]
Description=Arena <-> Kali bridge agent
Documentation=$REPO_URL
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/env python3 $DEST/kali/bridge_agent.py --host $HOST --port $PORT
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNITFILE

systemctl daemon-reload
systemctl enable arena-bridge >/dev/null 2>&1
systemctl restart arena-bridge

sleep 1
if systemctl is-active --quiet arena-bridge; then
  say ""
  say "  [OK] the bridge is running, and will start with the VM from now on."
  say ""
  say "       status   systemctl status arena-bridge"
  say "       log      journalctl -u arena-bridge -n 30"
  say "       stop     sudo systemctl stop arena-bridge"
  say "       remove   sudo bash $DEST/kali/install.sh --uninstall"
  say ""
  say "  Next, on the machine with the browser: load the extension, open arena.ai,"
  say "  press CONNECT. Nothing else."
  say ""
else
  say ""
  say "  [X] the service did not stay up. The reason is usually in:"
  say "      journalctl -u arena-bridge -n 50 --no-pager"
  say ""
  exit 1
fi
