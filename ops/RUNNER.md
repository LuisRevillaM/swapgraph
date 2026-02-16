Project root: /workspace/projects/swapgraph
Plan file: /workspace/projects/swapgraph/PLAN.md

Rules:
- Operate ONLY in project root.
- Execute ONE bounded chunk per run (max 15m): implement -> verify -> artifact -> report.
- Update ops/runner-state.json at start/end (lease+heartbeat).
- If tests fail: no commit; append blocker to BLOCKERS.md.
- If tests pass and code changed: commit + update docs/STATUS.md.
- If blocked twice on same milestone: set status=stalled and stop this run.
- If PLAN.md missing or AUTOPILOT_APPROVED != true: NOOP.
