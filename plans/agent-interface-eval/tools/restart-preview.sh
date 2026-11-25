#!/bin/sh
# Starts (or restarts) the evaluation's browser preview: an isolated ToolBelt with the agent
# interface on, in the development profile agents-eval. Stops only a preview on port 5281.
# EVAL_HOME (default: $TMPDIR/toolbelt-agent-eval) holds its config folder; the socket is
# $TMPDIR/tb-agent-eval.sock (Unix socket paths must stay short).
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
EVAL_HOME=${EVAL_HOME:-${TMPDIR}toolbelt-agent-eval}
mkdir -p "$EVAL_HOME"
PID=$(lsof -ti tcp:5281 -sTCP:LISTEN)
[ -n "$PID" ] && kill "$PID" && sleep 1
cd "$REPO"
TOOLBELT_CONFIG_DIR=$EVAL_HOME TOOLBELT_AGENT_SOCKET=${TMPDIR}tb-agent-eval.sock TOOLBELT_DEVELOPMENT_PROFILE=agents-eval PORT=5281 REMOTE_PORT=47481 PREVIEW_AGENTS=1 nohup bun scripts/preview.ts > "$EVAL_HOME/preview.log" 2>&1 &
for i in $(seq 1 40); do [ -S "${TMPDIR}tb-agent-eval.sock" ] && break; perl -e 'select(undef,undef,undef,0.25)'; done
sleep 2
echo "preview pid $(lsof -ti tcp:5281 -sTCP:LISTEN), profile $EVAL_HOME/development/agents-eval"
