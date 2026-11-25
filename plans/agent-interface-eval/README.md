# Agent interface evaluation

Records of the evaluation of roadmap items 1–4 in [../agent-interface.md](../agent-interface.md),
run on 2026-11-24. Open [report.html](report.html) for the results.

- `cases.json`: each case's request, persona, channel, the agent's answer, verdict and notes,
  plus the findings.
- `cases/<id>/`: what happened. MCP cases have `steps.json` (the calls), `results.json` (each
  call's output) and `transcript.jsonl` (every JSON-RPC message through the stdio shim). CLI
  cases have `transcript.txt`.
- `inspector.txt`: the MCP Inspector CLI talking to the shim.
- `screens/`: Settings → Agents in the preview.
- `tools/`: the harness. `restart-preview.sh` starts an isolated preview with the agent interface
  on, `rpc.ts` acts as the person through the preview's RPC, `seed.ts` writes the OnTrack and
  Upkeep fixtures, `mcp-run.ts` and `cli-run.sh` run cases, and `report.ts` rebuilds the report.

Local paths in the records are replaced by placeholders: `<tmp>`, `<eval>`, `<scratch>`,
`<repo>`, `~`.
