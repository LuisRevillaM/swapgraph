# Autonomous Execution Mandate

Canonical human-readable source of truth:
- `docs/source/SwapGraph_Agent_Market_Source_of_Truth_Mar2026.md`

Canonical execution plan:
- `docs/plans/market-vnext-agent-execution.md`

Codex agents must execute the active plan autonomously.

Default behavior:
- Start from the plan dispatcher.
- Select the next ready task automatically.
- Implement, verify as needed, commit, update task state, and continue.
- Do not stop after partial implementation.
- Do not stop to ask for confirmation on normal coding, testing, documentation, or git actions inside the workspace.
- Continue until the final finish gate reports complete.

Stop only if:
1. the finish gate reports complete, or
2. a true blocker is encountered.

A true blocker is limited to:
- required credentials or external access are unavailable
- a sandbox or permission boundary prevents execution
- the repo has unexpected conflicting changes
- the plan contains a contradiction that prevents safe implementation

When blocked:
- record the blocker in the task file and evidence artifact
- stop only after writing the blocker clearly

Success condition:
- `node scripts/run-market-vnext-finish-gate.mjs` reports `"complete": true`
- and the current source-of-truth document still describes the implemented system honestly

## Entry Point

Start the autonomous loop with:

```bash
node scripts/run-market-vnext-agent-dispatch.mjs
```

Execution rule:
- Read the dispatcher output.
- Execute the selected task.
- Commit with the required message.
- Update the task file with status, timestamp, commit SHA, and evidence path.
- Rerun the dispatcher.
- Repeat until the finish gate reports complete.

Do not stop at intermediate success.
Do not stop after local tests.
Stop only when the finish gate reports complete or a true blocker is recorded.
