#!/usr/bin/env bash
# Arena -> Kali : open the port
#
# Makes 127.0.0.1:8787 on this machine reach the agent inside a VirtualBox VM.
# Double-click on macOS (this is a .command file) or run:  ./mac-linux-portforward.sh
set -u

say() { printf '%s\n' "$*"; }

say ""
say "  Arena -> Kali : port forwarding"
say "  --------------------------------"
say "  Makes 127.0.0.1:8787 on this machine reach the agent inside your VM."
say ""

VBM="$(command -v VBoxManage 2>/dev/null || true)"
if [ -z "$VBM" ] && [ -x "/Applications/VirtualBox.app/Contents/MacOS/VBoxManage" ]; then
  VBM="/Applications/VirtualBox.app/Contents/MacOS/VBoxManage"
fi
if [ -z "$VBM" ] && [ -x "/usr/lib/virtualbox/VBoxManage" ]; then
  VBM="/usr/lib/virtualbox/VBoxManage"
fi

if [ -z "$VBM" ]; then
  say "  [X] Could not find VBoxManage. Install VirtualBox first, then re-run."
  say ""
  exit 1
fi

say "  VirtualBox: $VBM"
say ""
say "  Running VMs:"
"$VBM" list runningvms
say ""

VMNAME="${1:-}"
if [ -z "$VMNAME" ]; then
  printf '  VM name (copy it exactly, without quotes): '
  IFS= read -r VMNAME
else
  printf '  VM name: %s\n' "$VMNAME"
fi
if [ -z "$VMNAME" ]; then
  say "  No name given - nothing changed."
  exit 1
fi

say ""
say "  Adding 127.0.0.1:8787 -> guest 8787 on \"$VMNAME\" ..."
"$VBM" controlvm "$VMNAME" natpf1 delete "arena-kali" >/dev/null 2>&1 || true
if "$VBM" controlvm "$VMNAME" natpf1 "arena-kali,tcp,127.0.0.1,8787,,8787"; then
  say ""
  say "  [OK] Port forwarded. Test it:"
  say "       curl -i http://127.0.0.1:8787/health   ->  expects 401 (that is correct)"
  say ""
  say "  Keep the VM running. Next: load the extension and click Pair."
else
  say ""
  say "  [X] VirtualBox refused it."
  say "      - Is the VM actually running? (the rule is added while running)"
  say "      - Is Adapter 1 set to NAT? (Settings > Network)"
  exit 1
fi
