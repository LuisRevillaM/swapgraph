# WEB-M2 Evidence Report (2026-02-24)

## Scope
Implemented **WEB-T011 through WEB-T015 only** from:
- `/Users/luisrevilla/code/swapgraph/docs/prd/2026-02-24_marketplace-web-phase0-task-pack.md`

Did **not** start WEB-T016+ / WEB-M3.

## Task Delivery Matrix
| Task | Files changed | Checks run | Pass/Fail | Blockers |
|---|---|---|---|---|
| WEB-T011 | `client/marketplace/src/ui/screens.mjs`, `client/marketplace/src/features/items/cards.mjs`, `client/marketplace/src/app/bootstrap.mjs`, `client/marketplace/src/api/apiClient.mjs`, `client/marketplace/src/domain/mappers.mjs`, `client/marketplace/src/state/store.mjs`, `client/marketplace/styles.css`, `tests/web/unit/items-cards.test.mjs`, `tests/web/unit/screens-m2.test.mjs` | `npm run web:m2:test`, `npm run web:m2:check:sc-ux-01` | Pass | None |
| WEB-T012 | `client/marketplace/src/ui/screens.mjs`, `client/marketplace/src/features/items/cards.mjs`, `client/marketplace/src/state/store.mjs`, `client/marketplace/styles.css`, `tests/web/unit/items-cards.test.mjs`, `tests/web/unit/screens-m2.test.mjs` | `npm run web:m2:test`, `npm run web:m2:check:sc-ds-02` (regression) | Pass | None |
| WEB-T013 | `client/marketplace/src/ui/screens.mjs`, `client/marketplace/src/features/intents/watchState.mjs`, `client/marketplace/src/app/bootstrap.mjs`, `tests/web/unit/watch-state.test.mjs`, `tests/web/unit/screens-m2.test.mjs` | `npm run web:m2:test`, `npm run web:m2:check:sc-ux-01`, `npm run web:m2:check:sc-api-01` (regression) | Pass | None |
| WEB-T014 | `client/marketplace/src/features/intents/composer.mjs`, `client/marketplace/src/ui/screens.mjs`, `client/marketplace/src/ui/shell.mjs`, `client/marketplace/src/app/bootstrap.mjs`, `client/marketplace/styles.css`, `tests/web/unit/composer.test.mjs`, `tests/web/unit/screens-m2.test.mjs`, `tests/web/unit/store.test.mjs` | `npm run web:m2:test`, `npm run web:m2:check:sc-ux-01`, `npm run web:m2:check:sc-ds-02` (regression) | Pass | None |
| WEB-T015 | `client/marketplace/src/app/bootstrap.mjs`, `client/marketplace/src/api/apiClient.mjs`, `client/marketplace/src/state/store.mjs`, `client/marketplace/src/analytics/events.mjs`, `tests/web/unit/api-client-intents.test.mjs`, `tests/web/unit/store.test.mjs`, `tests/web/unit/analytics.test.mjs`, `scripts/web-m2/check-sc-api-03-idempotency.mjs`, `scripts/web-m2/check-sc-rl-02-retry-backoff.mjs`, `scripts/web-m2/check-sc-an-01-event-taxonomy.mjs`, `scripts/web-m2/check-sc-ux-01-first-intent.mjs`, `package.json` | `npm run web:m2:test`, `npm run web:m2:check:sc-api-03`, `npm run web:m2:check:sc-rl-02`, `npm run web:m2:check:sc-an-01` | Pass | None |

## Required Gate Results
| Gate | Command | Result | Evidence artifact |
|---|---|---|---|
| SC-UX-01 | `npm run web:m2:check:sc-ux-01` | Pass | `artifacts/web-m2/sc-ux-01-first-intent-report.json` |
| SC-API-03 | `npm run web:m2:check:sc-api-03` | Pass | `artifacts/web-m2/sc-api-03-idempotency-report.json` |
| SC-RL-02 | `npm run web:m2:check:sc-rl-02` | Pass | `artifacts/web-m2/sc-rl-02-retry-backoff-report.json` |
| SC-AN-01 | `npm run web:m2:check:sc-an-01` | Pass | `artifacts/web-m2/sc-an-01-event-taxonomy-report.json` |
| SC-DS-01 (regression) | `npm run web:m2:check:sc-ds-01` | Pass | `artifacts/web-m1/sc-ds-01-token-parity-report.json` |
| SC-DS-02 (regression) | `npm run web:m2:check:sc-ds-02` | Pass | `artifacts/web-m1/sc-ds-02-readability-report.json` |
| SC-API-01 (regression) | `npm run web:m2:check:sc-api-01` | Pass | `artifacts/web-m1/sc-api-01-contract-report.json` |

## Test Harness Run
- Command: `npm run web:m2:test`
- Result: **Pass** (24/24 tests)
- Added/extended M2 coverage:
  - Composer structured validation and payload construction
  - Items card derivation + demand sorting behavior
  - Intents watching/no-match/matched state derivation
  - API client update/cancel/inventory-awakening semantics
  - Screen rendering assertions for Items + Intents M2 UI surfaces

## Explicit Incomplete / Blocking List
- Incomplete (intentional due scope): **WEB-T016 and above were not started**.
- Blocking issues for WEB-T011..WEB-T015: **None**.
