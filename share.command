#!/bin/bash
#
# Suhradam Volleyball — publish the LIVE site to the internet.
#
# Keep start.command running (the server) in one window, then run this in
# another. It opens a free Cloudflare tunnel and prints a public https link
# (and QR) that ANYONE, anywhere, can open — fan page, overlay, and admin.
#
# Stop sharing by closing this window / pressing Ctrl+C. The link is temporary
# and changes every time you run this.

cd "$(dirname "$0")" || exit 1
PORT=3000

echo "============================================"
echo "   Suhradam Volleyball — Go Live (internet)"
echo "============================================"
echo ""

# cloudflared check
CF="$(command -v cloudflared || echo /opt/homebrew/bin/cloudflared)"
if [ ! -x "$CF" ] && ! command -v cloudflared >/dev/null 2>&1; then
  echo "❌ cloudflared is not installed."
  echo "   Install it once with:  brew install cloudflared"
  read -n 1 -s -r -p "Press any key to close..."; exit 1
fi

# server check
if ! curl -s -m 3 -o /dev/null "http://localhost:$PORT/api/state"; then
  echo "❌ The scoring server isn't running."
  echo "   Start it first (double-click start.command), then run this again."
  read -n 1 -s -r -p "Press any key to close..."; exit 1
fi

echo "🌐 Opening a public link (this can take ~10 seconds)..."
echo ""

LOG="$(mktemp)"
# Start the tunnel in the background, streaming its logs to $LOG.
cloudflared tunnel --url "http://localhost:$PORT" --no-autoupdate > "$LOG" 2>&1 &
CF_PID=$!
trap 'kill $CF_PID 2>/dev/null; rm -f "$LOG"; echo ""; echo "🛑 Public link closed."; exit 0' INT TERM

# Wait for the public URL to appear in the logs.
URL=""
for i in $(seq 1 30); do
  URL="$(grep -Eo 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "$LOG" | head -1)"
  [ -n "$URL" ] && break
  sleep 1
done

if [ -z "$URL" ]; then
  echo "❌ Couldn't get a public link. Check your internet connection."
  echo "   Tunnel log:"; tail -10 "$LOG"
  kill $CF_PID 2>/dev/null; rm -f "$LOG"
  read -n 1 -s -r -p "Press any key to close..."; exit 1
fi

# Wait until the edge connection is registered so the link works immediately.
echo "   Link found, finalizing connection..."
for i in $(seq 1 20); do grep -q "Registered tunnel connection" "$LOG" && break; sleep 1; done
sleep 2

# Register the URL with the server so the admin page can show its QR.
curl -s -X POST "http://localhost:$PORT/api/public-url" \
  -H 'Content-Type: application/json' -d "{\"url\":\"$URL\"}" >/dev/null

clear
echo "============================================"
echo "   ✅  YOU ARE LIVE ON THE INTERNET"
echo "============================================"
echo ""
echo "  Fan page (share with everyone):"
echo "     $URL/fan"
echo ""
echo "  Admin / scoring (keep private):"
echo "     $URL/admin"
echo ""
echo "  OBS overlay:"
echo "     $URL/overlay"
echo ""
# Print a scannable QR of the fan page in the terminal.
node -e "require('qrcode').toString('$URL/fan',{type:'terminal',small:true},function(e,s){if(!e)console.log(s)})" 2>/dev/null

echo "  (Also shown as a QR on the Admin → Settings page.)"
echo ""
echo "  Keep this window open to stay live. Press Ctrl+C to stop."
echo "============================================"

# Keep running until the user stops it; clear the URL on exit.
wait $CF_PID
curl -s -X POST "http://localhost:$PORT/api/public-url" -H 'Content-Type: application/json' -d '{"url":""}' >/dev/null
rm -f "$LOG"
