# IOS-M4 Evidence Report (IOS-T021..IOS-T023)

Date: 2026-02-24  
Scope executed: IOS-T021 through IOS-T023 only (no IOS-T024+ work started)

## 1) Task Delivery Matrix

| Task | Files changed | Checks run | Pass/Fail | Blockers |
|---|---|---|---|---|
| IOS-T021: active swap header + progress bar | `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Active/ActiveModels.swift`, `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Active/ActiveViewModel.swift`, `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Active/ActiveView.swift`, `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/AppShell/AppShellView.swift`, `ios/MarketplaceClient/Tests/MarketplaceClientFoundationTests/ActiveFeatureTests.swift`, `scripts/ios/run-sc-ux-03.mjs` | `swift test`, `node scripts/ios/run-sc-ux-03.mjs` | PASS | none |
| IOS-T022: timeline event list + explicit wait reasons | `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Active/ActiveModels.swift`, `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Active/ActiveViewModel.swift`, `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Active/ActiveView.swift`, `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Domain/MarketplaceModels.swift`, `ios/MarketplaceClient/Tests/MarketplaceClientFoundationTests/ActiveFeatureTests.swift`, `scripts/ios/run-sc-ux-03.mjs` | `swift test`, `node scripts/ios/run-sc-ux-03.mjs`, `node scripts/ios/run-sc-an-01.mjs` | PASS | none |
| IOS-T023: state-aware actions + disabled logic | `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Active/ActiveRepository.swift`, `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Active/ActiveViewModel.swift`, `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Active/ActiveView.swift`, `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/API/MarketplaceAPIClient.swift`, `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Domain/MarketplaceModels.swift`, `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Analytics/AnalyticsClient.swift`, `ios/MarketplaceClient/Tests/MarketplaceClientFoundationTests/ActiveFeatureTests.swift`, `ios/MarketplaceClient/Tests/MarketplaceClientFoundationTests/APIClientIntegrationTests.swift`, `ios/MarketplaceClient/Tests/MarketplaceClientFoundationTests/DomainModelTests.swift`, `ios/MarketplaceClient/Tests/MarketplaceClientFoundationTests/AnalyticsTests.swift`, `scripts/ios/run-sc-api-04.mjs`, `scripts/ios/run-sc-an-01.mjs`, `scripts/ios/run-sc-an-02.mjs` | `swift test`, `node scripts/ios/run-sc-api-04.mjs`, `node scripts/ios/run-sc-an-01.mjs`, `node scripts/ios/run-sc-an-02.mjs`, `node scripts/ios/run-sc-api-03.mjs` | PASS | none |

Additional M4 gate automation added:
- `scripts/ios/run-sc-ux-03.mjs`
- `scripts/ios/run-sc-api-04.mjs`
- `verify/ios-m4.sh`

## 2) Required Gate Results

Artifact root: `artifacts/milestones/IOS-M4/20260224-162722`  
Latest mirror: `artifacts/milestones/IOS-M4/latest`

| Check | Command | Result | Evidence |
|---|---|---|---|
| SC-UX-03 | `node scripts/ios/run-sc-ux-03.mjs` | PASS | `artifacts/milestones/IOS-M4/20260224-162722/sc-ux-03.json` |
| SC-API-04 | `node scripts/ios/run-sc-api-04.mjs` | PASS | `artifacts/milestones/IOS-M4/20260224-162722/sc-api-04.json` |
| SC-AN-01 | `node scripts/ios/run-sc-an-01.mjs` | PASS | `artifacts/milestones/IOS-M4/20260224-162722/sc-an-01.json` |
| SC-AN-02 | `node scripts/ios/run-sc-an-02.mjs` | PASS | `artifacts/milestones/IOS-M4/20260224-162722/sc-an-02.json` |
| SC-API-03 (regression) | `node scripts/ios/run-sc-api-03.mjs` | PASS | `artifacts/milestones/IOS-M4/20260224-162722/sc-api-03.json` |
| SC-DS-01 (regression) | `node scripts/ios/run-sc-ds-01.mjs` | PASS | `artifacts/milestones/IOS-M4/20260224-162722/sc-ds-01.json` |
| SC-DS-02 (regression) | `node scripts/ios/run-sc-ds-02.mjs` | PASS | `artifacts/milestones/IOS-M4/20260224-162722/sc-ds-02.json` |
| SC-API-01 (regression) | `node scripts/ios/run-sc-api-01.mjs` | PASS | `artifacts/milestones/IOS-M4/20260224-162722/sc-api-01.json` |

Supplemental build/test run:
- `HOME=/Users/luisrevilla/code/swapgraph/.codex-home CLANG_MODULE_CACHE_PATH=/Users/luisrevilla/code/swapgraph/.clang-module-cache swift test` in `ios/MarketplaceClient` -> PASS
- Log: `artifacts/milestones/IOS-M4/20260224-162722/swift-test.log`

## 3) Explicit Incomplete / Blocking List

- Incomplete within IOS-T021..IOS-T023 scope: none.
- Blocking issues for required gates (SC-UX-03, SC-API-04, SC-AN-01, SC-AN-02, SC-API-03 regression, SC-DS-01 regression, SC-DS-02 regression, SC-API-01 regression): none.
- Intentionally out of scope and not started: IOS-T024+ / IOS-M5.
