#!/usr/bin/env bash
# Verifies every piece of ZW MCP came back after a reboot.
# Run it after any restart:  ./scripts/verify-boot.sh
set -uo pipefail

UID_NUM="$(id -u)"
PUBLIC="${ZW_MCP_PUBLIC_URL:-https://zws-mac-mini.tail9e5da0.ts.net}"
fail=0

check() { # name, actual, expected
  if [ "$2" = "$3" ]; then printf '  ✅ %-34s %s\n' "$1" "$2"
  else printf '  ❌ %-34s %s (expected %s)\n' "$1" "$2" "$3"; fail=$((fail+1)); fi
}

echo
echo "ZW MCP boot verification"
echo "========================"
echo
echo "launchd agents"
for L in com.zw.mcp com.zw.mcp.admin com.zw.tailscaled; do
  state="$(launchctl print "gui/$UID_NUM/$L" 2>/dev/null | awk '/state = /{print $3; exit}')"
  check "$L" "${state:-absent}" "running"
done

echo
echo "endpoints"
check "MCP /health (local)"   "$(curl -s -m 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/health)" "200"
check "admin console (local)" "$(curl -s -m 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:8788)" "200"
check "public /health"        "$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$PUBLIC/health")" "200"
check "OAuth metadata"        "$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$PUBLIC/.well-known/oauth-protected-resource")" "200"
check "MCP rejects no token"  "$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X POST "$PUBLIC/mcp" -H 'Accept: application/json, text/event-stream' -H 'Content-Type: application/json' -d '{}')" "401"

echo
echo "prerequisites for surviving the NEXT reboot"
# LaunchAgents only load once a GUI session exists. Without automatic login this
# machine comes back with everything stopped and no error anywhere.
autologin="$(defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null || echo '')"
if [ -n "$autologin" ]; then printf '  ✅ %-34s %s\n' "automatic login" "$autologin"
else printf '  ❌ %-34s %s\n' "automatic login" "NOT SET — agents will not start until someone logs in"; fail=$((fail+1)); fi

fv="$(fdesetup status 2>/dev/null | head -1)"
case "$fv" in
  *Off*) printf '  ✅ %-34s %s\n' "FileVault" "off (no unlock needed at boot)";;
  *)     printf '  ⚠️  %-34s %s\n' "FileVault" "$fv — disk must be unlocked before login";;
esac

echo
if [ "$fail" -eq 0 ]; then echo "All good."; else echo "$fail check(s) failed."; fi
exit "$fail"
