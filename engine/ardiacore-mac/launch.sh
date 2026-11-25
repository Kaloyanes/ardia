#!/usr/bin/env bash
set -euo pipefail
if [[ $# -lt 3 || $1 == -h || $1 == --help ]]; then
  echo "usage: engine/ardiacore-mac/launch.sh <Ardia WebUI.app> <data dir> <devtools port> [switches…]   hidden WebUI instance; prints its pid" >&2
  exit 64
fi
app=$1 data=$2 port=$3
shift 3
mkdir -p "$data/Chromium"
open -g -n "$app" --args --ardia-shell=webui --user-data-dir="$data/Chromium" --ardia-data-dir="$data" \
  --ardia-background --use-mock-keychain --remote-debugging-port="$port" --enable-logging --v=0 "$@"
for _ in $(seq 1 200); do
  pid=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)
  [[ -n "$pid" ]] && { echo "$pid"; exit 0; }
  sleep 0.05
done
echo "no DevTools listener on $port" >&2
exit 1
