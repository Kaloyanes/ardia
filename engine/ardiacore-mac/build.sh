#!/usr/bin/env bash
set -euo pipefail
if [[ ${1:-} == -h || ${1:-} == --help ]]; then
  echo "usage: engine/ardiacore-mac/build.sh [targets…]   apply the three Mac layers and build incrementally under the chromium lock" >&2
  exit 0
fi
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
src=${CHROMIUM_SRC:-$HOME/chromium-build/chromium_git/chromium/src}
out=out/Release_GN_arm64
targets=("$@")
(( ${#targets[@]} )) || targets=(chrome_framework)
[[ -d "$src/$out" ]] || { echo "no $src/$out: incremental builds only" >&2; exit 1; }
exec "$repo/scripts/agent/locked" chromium --wait 1800 -- bash -c '
  set -euo pipefail
  repo=$1 src=$2 out=$3
  shift 3
  "$repo/engine/chromium/apply.sh"
  "$repo/engine/ardiacore/apply.sh"
  "$repo/engine/ardiacore-mac/apply.sh"
  "$repo/engine/ardiacore-mac/apply.sh" --check
  source "$repo/engine/patches/build/env.sh"
  cd "$src"
  memory_gb=$(( $(sysctl -n hw.memsize) / 1073741824 ))
  cpus=$(sysctl -n hw.ncpu)
  local_jobs=$(( memory_gb * 10 / 25 ))
  (( local_jobs > cpus )) && local_jobs=$cpus
  (( local_jobs < 2 )) && local_jobs=2
  export SISO_LIMITS="step=$(( local_jobs * 2 )),local=$local_jobs,remote=$local_jobs,startlocal=$local_jobs,fastlocal=$local_jobs"
  export PYTHONPATH="$repo/scripts/agent/python-worker-cap${PYTHONPATH:+:$PYTHONPATH}"
  autoninja -C "$out" -local_jobs="$local_jobs" "$@"
' build "$repo" "$src" "$out" "${targets[@]}"
