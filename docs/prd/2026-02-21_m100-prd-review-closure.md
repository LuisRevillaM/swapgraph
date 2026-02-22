# M100 PRD Review Closure — Decision Checklist

Date: 2026-02-21
Status: Approved and implemented (fixtures-first)

Purpose: record approved M100 decisions and implementation closure for deterministic metrics/network-health contracts.

## Decision D1 — Primary north-star metric
- **Question:** which metric is canonical primary in first contract release?
- **Recommendation:** default to `weekly_successful_swaps_per_active_trader`, while still exposing `fill_rate_7d_bps` as co-equal summary metric.
- **Approval needed:** no (approved).

## Decision D2 — Time window semantics
- **Question:** canonical window boundary and timezone semantics.
- **Recommendation:** UTC, inclusive `from_iso`, exclusive `to_iso` (`[from,to)`).
- **Approval needed:** no (approved).

## Decision D3 — Metric denominator transparency
- **Question:** should rates include denominator fields in all contracts?
- **Recommendation:** yes, all bps/rate metrics must include denominators explicitly.
- **Approval needed:** no (approved).

## Decision D4 — Partner visibility model
- **Question:** what aggregation levels are partner-visible in first release?
- **Recommendation:** partner- and tenant-scoped views only; no cross-partner aggregate disclosure.
- **Approval needed:** no (approved).

## Decision D5 — Export continuity requirements
- **Question:** should metrics export require signed attestation and checkpoint continuity in first release?
- **Recommendation:** yes, signed export hash + attestation + checkpoint continuity required.
- **Approval needed:** no (approved).

## Decision D6 — Scope model
- **Question:** new `metrics:*` scopes now vs reuse existing scopes in first tranche.
- **Recommendation:** reuse `settlement:read` for first implementation tranche.
- **Approval needed:** no (approved).

## Decision D7 — Canonical reason-code floor
- **Question:** minimal deterministic reason-code set for metrics surfaces.
- **Recommendation:**
  - `metrics_query_invalid`
  - `metrics_window_invalid`
  - `metrics_bucket_invalid`
  - `metrics_export_query_invalid`
  - `metrics_export_cursor_not_found`
  - `metrics_export_checkpoint_required`
  - `metrics_export_checkpoint_mismatch`
- **Approval needed:** no (approved).

## Implementation closure gate (M100)
M100 implementation closure is achieved when:
- `npm run verify:m100` exits 0.
- `node verify/runner.mjs milestones/M100.yaml` returns `overall=true`.
- Artifacts are present under `artifacts/milestones/M100/latest/*`.
