# IOS-M5 Evidence Report (IOS-T024..IOS-T025)

Date: 2026-02-24  
Scope executed: IOS-T024 through IOS-T025 only (no IOS-T026+ work started)

## 1) Task Delivery Matrix

| Task | Files changed | Checks run | Pass/Fail | Blockers |
|---|---|---|---|---|
| IOS-T024: receipts list with status + key metadata | `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Receipts/ReceiptsModels.swift`, `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Receipts/ReceiptsRepository.swift`, `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Receipts/ReceiptsViewModel.swift`, `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Receipts/ReceiptsView.swift`, `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/AppShell/AppShellView.swift`, `ios/MarketplaceClient/Tests/MarketplaceClientFoundationTests/ReceiptsFeatureTests.swift`, `scripts/ios/run-sc-ux-04.mjs` | `swift test`, `node scripts/ios/run-sc-ux-04.mjs`, `node scripts/ios/run-sc-api-01.mjs` | PASS | none |
| IOS-T025: receipt detail + verification metadata/proof presentation | `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Domain/MarketplaceModels.swift`, `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/API/MarketplaceAPIClient.swift`, `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Receipts/ReceiptsRepository.swift`, `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Receipts/ReceiptsViewModel.swift`, `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Receipts/ReceiptsView.swift`, `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Active/ActiveRepository.swift`, `ios/MarketplaceClient/Tests/MarketplaceClientFoundationTests/APIClientIntegrationTests.swift`, `ios/MarketplaceClient/Tests/MarketplaceClientFoundationTests/DomainModelTests.swift`, `ios/MarketplaceClient/Tests/MarketplaceClientFoundationTests/ReceiptsFeatureTests.swift`, `ios/MarketplaceClient/Tests/MarketplaceClientFoundationTests/AnalyticsTests.swift`, `scripts/ios/run-sc-an-01.mjs`, `scripts/ios/run-sc-ux-04.mjs` | `swift test`, `node scripts/ios/run-sc-ux-04.mjs`, `node scripts/ios/run-sc-an-01.mjs`, `node scripts/ios/run-sc-api-04.mjs`, `node scripts/ios/run-sc-api-03.mjs` | PASS | none |

Additional M5 gate automation added:
- `scripts/ios/run-sc-ux-04.mjs`
- `verify/ios-m5.sh`

## 2) Required Gate Results

Artifact root: `artifacts/milestones/IOS-M5/20260224-175143`  
Latest mirror: `artifacts/milestones/IOS-M5/latest`

| Check | Command | Result | Evidence |
|---|---|---|---|
| SC-UX-04 | `node scripts/ios/run-sc-ux-04.mjs` | PASS | `artifacts/milestones/IOS-M5/20260224-175143/sc-ux-04.json` |
| SC-AN-01 | `node scripts/ios/run-sc-an-01.mjs` | PASS | `artifacts/milestones/IOS-M5/20260224-175143/sc-an-01.json` |
| SC-API-01 (regression) | `node scripts/ios/run-sc-api-01.mjs` | PASS | `artifacts/milestones/IOS-M5/20260224-175143/sc-api-01.json` |
| SC-API-04 (regression) | `node scripts/ios/run-sc-api-04.mjs` | PASS | `artifacts/milestones/IOS-M5/20260224-175143/sc-api-04.json` |
| SC-API-03 (regression) | `node scripts/ios/run-sc-api-03.mjs` | PASS | `artifacts/milestones/IOS-M5/20260224-175143/sc-api-03.json` |
| SC-DS-01 (regression) | `node scripts/ios/run-sc-ds-01.mjs` | PASS | `artifacts/milestones/IOS-M5/20260224-175143/sc-ds-01.json` |
| SC-DS-02 (regression) | `node scripts/ios/run-sc-ds-02.mjs` | PASS | `artifacts/milestones/IOS-M5/20260224-175143/sc-ds-02.json` |

Supplemental build/test run:
- `HOME=/Users/luisrevilla/code/swapgraph/.codex-home CLANG_MODULE_CACHE_PATH=/Users/luisrevilla/code/swapgraph/.clang-module-cache swift test` in `ios/MarketplaceClient` -> PASS
- Log: `artifacts/milestones/IOS-M5/20260224-175143/swift-test.log`

## 3) Explicit Incomplete / Blocking List

- Incomplete within IOS-T024..IOS-T025 scope: none.
- Blocking issues for required gates (SC-UX-04, SC-AN-01, SC-API-01 regression, SC-API-04 regression, SC-API-03 regression, SC-DS-01 regression, SC-DS-02 regression): none.
- Intentionally out of scope and not started: IOS-T026+ / IOS-M6.
