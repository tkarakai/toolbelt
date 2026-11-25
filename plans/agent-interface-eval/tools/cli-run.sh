#!/bin/sh
# Runs one toolbelt CLI command against the evaluation preview and appends it to the case's
# transcript: cli-run.sh <case dir> <args…>
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
DIR=$1; shift
mkdir -p "$DIR"
OUT=$(bun "$REPO/src/cli/toolbelt.ts" --socket "${TMPDIR}tb-agent-eval.sock" "$@" 2>&1); CODE=$?
printf '$ toolbelt %s\n%s\n[exit %s]\n\n' "$*" "$OUT" "$CODE" >> "$DIR/transcript.txt"
printf '$ toolbelt %s\n%s\n[exit %s]\n' "$*" "$OUT" "$CODE"
