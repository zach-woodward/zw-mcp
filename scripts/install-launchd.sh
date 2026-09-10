#!/usr/bin/env bash
# Installs the launchd agents, substituting __HOME__ for this machine's home
# directory. The plists are templated so the repo carries no local paths.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"
mkdir -p "$DEST"

# tailscaled is optional: only install it if the binary is present.
AGENTS=(com.zw.mcp com.zw.mcp.admin)
[ -x /opt/homebrew/bin/tailscaled ] && AGENTS+=(com.zw.tailscaled)

echo "Installing to $DEST"
for L in "${AGENTS[@]}"; do
  sed "s|__HOME__|$HOME|g" "$REPO/launchd/$L.plist" > "$DEST/$L.plist"
  launchctl bootout "gui/$UID_NUM/$L" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_NUM" "$DEST/$L.plist"
  echo "  bootstrapped $L"
done

echo
echo "Note: the plists assume Homebrew node at /opt/homebrew/bin/node and this"
echo "repo at $REPO. Re-run this script after moving the repo."
echo
echo "Verify with: npm run verify-boot"
