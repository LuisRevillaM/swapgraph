State file: /workspace/projects/swapgraph/ops/runner-state.json

Rules:
- If lease valid + heartbeat fresh: SUPERVISOR_OK.
- If stale/expired: mark stalled, increment attempt, append to BLOCKERS.md and docs/STATUS.md.
- Soft threshold: 45m warn.
- Hard threshold: 2h pause + escalate.
