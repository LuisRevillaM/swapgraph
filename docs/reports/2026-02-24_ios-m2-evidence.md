# IOS-M2 Evidence Report (IOS-T011..IOS-T015)

Date: 2026-02-24  
Scope executed: IOS-T011 through IOS-T015 only (no IOS-T016+ work started)

## 1) Task Delivery Matrix

| Task | Status | Files changed |
|---|---|---|
| IOS-T011: Items list/grid + demand banner + empty/error states | PASS | `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Items/ItemsModels.swift`, `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Items/ItemsRepository.swift`, `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Items/ItemsViewModel.swift`, `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Items/ItemsView.swift`, `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/AppShell/AppShellView.swift`, `ios/MarketplaceClient/Tests/MarketplaceClientFoundationTests/ItemsFeatureTests.swift` |
| IOS-T012: Item card metadata layout (name/wear/price/demand/float) | PASS | `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Items/ItemsView.swift`, `ios/MarketplaceClient/Tests/MarketplaceClientFoundationTests/ItemsFeatureTests.swift` |
| IOS-T013: Intents screen + persistent watching state | PASS | `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Intents/IntentsModels.swift`, `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Intents/IntentsRepository.swift`, `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Intents/IntentWatchSnapshotStore.swift`, `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Intents/IntentsViewModel.swift`, `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Intents/IntentsView.swift`, `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/AppShell/AppShellView.swift`, `ios/MarketplaceClient/Tests/MarketplaceClientFoundationTests/IntentsFeatureTests.swift` |
| IOS-T014: Structured intent composer sheet + required-field enforcement | PASS | `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Intents/IntentsModels.swift`, `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Intents/IntentsView.swift`, `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Intents/IntentsViewModel.swift`, `ios/MarketplaceClient/Tests/MarketplaceClientFoundationTests/IntentsFeatureTests.swift` |
| IOS-T015: create/edit/cancel mutations with optimistic guards + fallback consistency | PASS | `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/API/MarketplaceAPIClient.swift`, `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Domain/MarketplaceModels.swift`, `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Intents/IntentsRepository.swift`, `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Intents/IntentsViewModel.swift`, `ios/MarketplaceClient/Tests/MarketplaceClientFoundationTests/APIClientIntegrationTests.swift`, `ios/MarketplaceClient/Tests/MarketplaceClientFoundationTests/IntentsFeatureTests.swift`, `scripts/ios/run-sc-api-03.mjs`, `scripts/ios/run-sc-rl-02.mjs` |

Additional M2 analytics/taxonomy support:
- `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Analytics/AnalyticsClient.swift`
- `ios/MarketplaceClient/Tests/MarketplaceClientFoundationTests/AnalyticsTests.swift`
- `scripts/ios/run-sc-an-01.mjs`

Additional M2 gate automation:
- `scripts/ios/run-sc-ux-01.mjs`
- `verify/ios-m2.sh`

## 2) Required Gate Results

Artifact root: `artifacts/milestones/IOS-M2/20260224-151252`  
Latest mirror: `artifacts/milestones/IOS-M2/latest`

| Check | Command | Result | Evidence |
|---|---|---|---|
| SC-UX-01 | `node scripts/ios/run-sc-ux-01.mjs` | PASS | `artifacts/milestones/IOS-M2/20260224-151252/sc-ux-01.json` |
| SC-API-03 | `node scripts/ios/run-sc-api-03.mjs` | PASS | `artifacts/milestones/IOS-M2/20260224-151252/sc-api-03.json` |
| SC-RL-02 | `node scripts/ios/run-sc-rl-02.mjs` | PASS | `artifacts/milestones/IOS-M2/20260224-151252/sc-rl-02.json` |
| SC-AN-01 | `node scripts/ios/run-sc-an-01.mjs` | PASS | `artifacts/milestones/IOS-M2/20260224-151252/sc-an-01.json` |
| SC-DS-01 (regression) | `node scripts/ios/run-sc-ds-01.mjs` | PASS | `artifacts/milestones/IOS-M2/20260224-151252/sc-ds-01.json` |
| SC-DS-02 (regression) | `node scripts/ios/run-sc-ds-02.mjs` | PASS | `artifacts/milestones/IOS-M2/20260224-151252/sc-ds-02.json` |
| SC-API-01 (regression) | `node scripts/ios/run-sc-api-01.mjs` | PASS | `artifacts/milestones/IOS-M2/20260224-151252/sc-api-01.json` |

Supplemental build/test run:
- `HOME=/Users/luisrevilla/code/swapgraph/.codex-home CLANG_MODULE_CACHE_PATH=/Users/luisrevilla/code/swapgraph/.clang-module-cache swift test` in `ios/MarketplaceClient` -> PASS
- Log: `artifacts/milestones/IOS-M2/20260224-151252/swift-test.log`

## 3) Explicit Incomplete / Blocking List

- Incomplete within IOS-T011..IOS-T015 scope: none.
- Blocking issues for required gates (SC-UX-01, SC-API-03, SC-RL-02, SC-AN-01, SC-DS-01 regression, SC-DS-02 regression, SC-API-01 regression): none.
- Intentionally out of scope and not started: IOS-T016+ / IOS-M3.
