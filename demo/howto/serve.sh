#!/bin/sh
# Serve what demo/howto/scenario.json records: a terminal (ttyd, :7681) and the result pages
# (out/ over http, :8765). Both listen on 127.0.0.1 only. Ctrl+C stops both.
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
here="$root/demo/howto"
command -v ttyd >/dev/null || { echo "ttyd not found (brew install ttyd)" >&2; exit 1; }

mkdir -p "$root/out/_demo"
cp "$here/media.html" "$here/sheet.html" "$root/out/_demo/"

HDR_ROOT="$root" ZDOTDIR="$here/zdotdir" ttyd -p 7681 -i 127.0.0.1 -W \
  -t fontSize=25 -t disableLeaveAlert=true \
  -t 'theme={"background":"#1e1e2e","foreground":"#e6e6e6"}' zsh -i &
ttyd_pid=$!
python3 -m http.server 8765 --bind 127.0.0.1 --directory "$root/out" >/dev/null 2>&1 &
http_pid=$!
trap 'kill $ttyd_pid $http_pid 2>/dev/null' EXIT INT TERM
echo "terminal: http://127.0.0.1:7681/  results: http://127.0.0.1:8765/_demo/" >&2
wait
