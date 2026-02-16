# SwapGraph

API-first multi-reciprocity swap clearing network (Steam-first initial settlement adapter).

## Canonical spec
- `docs/source/LATEST.md`

## Repo rules
- This repo is **spec-first**: every milestone must have `docs/prd/Mx.md` + `milestones/Mx.yaml` + `verify/mx.sh`.
- A milestone is only done when `node verify/runner.ts milestones/Mx.yaml` passes.

## Quickstart
```bash
npm i
npm run verify:m0
```
