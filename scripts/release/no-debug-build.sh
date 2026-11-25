#!/usr/bin/env bash
# Fails a release whose build settings would compile in Debug-only code: DEBUG, and with it the dev-only Mac WebUI shell.
#
#   scripts/release/no-debug-build.sh --settings [<build setting>…]   refuses extra build settings that define DEBUG or
#                                                                      name ARDIA_SHELL or ARDIA_WEBUI
#   scripts/release/no-debug-build.sh --effective                      reads `xcodebuild -showBuildSettings` output on
#                                                                      stdin and fails when any target defines DEBUG, or
#                                                                      when it lists no target at all
set -euo pipefail

usage() { awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; }
DEBUG_TOKEN='(^|[^A-Za-z0-9_])(-D ?)?DEBUG([^A-Za-z0-9_]|$)'

case "${1:-}" in
  -h | --help) usage; exit 0 ;;
  --settings)
    shift
    refused=0
    for setting in "$@"; do
      if [[ "$setting" =~ $DEBUG_TOKEN ]] || [[ "$setting" == *ARDIA_SHELL* ]] || [[ "$setting" == *ARDIA_WEBUI* ]]; then
        echo "no-debug-build: release build setting $setting would compile in Debug-only code" >&2
        refused=1
      fi
    done
    exit "$refused"
    ;;
  --effective)
    awk -v token="$DEBUG_TOKEN" '
      /^Build settings for action / { target = $0; sub(/^.* and target "?/, "", target); sub(/"?:$/, "", target); targets++; next }
      /^[ \t]+(SWIFT_ACTIVE_COMPILATION_CONDITIONS|GCC_PREPROCESSOR_DEFINITIONS|OTHER_SWIFT_FLAGS|OTHER_CFLAGS|OTHER_CPLUSPLUSFLAGS) = / {
        value = $0; sub(/^[ \t]+[A-Z_]+ = /, "", value)
        if (value ~ token) { key = $1; print "no-debug-build: target " target " defines DEBUG in " key > "/dev/stderr"; bad++ }
      }
      END {
        if (!targets) { print "no-debug-build: no build settings to check" > "/dev/stderr"; exit 1 }
        exit bad ? 1 : 0
      }'
    ;;
  *) usage >&2; exit 2 ;;
esac
