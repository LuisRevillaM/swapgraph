# IOS-M6 Evidence Report (2026-02-24)

Scope executed: `IOS-T026` through `IOS-T028` only (IOS-M6).

Verification bundle:
- `artifacts/milestones/IOS-M6/20260224-195638/`
- `artifacts/milestones/IOS-M6/latest/`

## Task Evidence Matrix

| Task | Files changed | Checks run | Pass/Fail | Blockers |
|---|---|---|---|---|
| `IOS-T026` Push notification intake + route mapping | `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Notifications/PushNotificationIntakeCoordinator.swift`<br>`ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Notifications/MarketplaceNotificationPreferences.swift`<br>`ios/MarketplaceClient/Tests/MarketplaceClientFoundationTests/NotificationsFeatureTests.swift`<br>`scripts/ios/run-sc-ux-02.mjs`<br>`scripts/ios/run-sc-ux-03.mjs` | `SC-UX-02` (`artifacts/milestones/IOS-M6/latest/sc-ux-02.json`)<br>`SC-UX-03` (`artifacts/milestones/IOS-M6/latest/sc-ux-03.json`)<br>`SC-API-03` regression (`artifacts/milestones/IOS-M6/latest/sc-api-03.json`)<br>`SC-API-04` regression (`artifacts/milestones/IOS-M6/latest/sc-api-04.json`) | Pass | None |
| `IOS-T027` In-app notification preferences (category + urgency) | `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Notifications/MarketplaceNotificationPreferences.swift`<br>`ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Notifications/MarketplaceNotificationPreferencesStore.swift`<br>`ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Notifications/NotificationPreferencesViewModel.swift`<br>`ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Notifications/NotificationPreferencesView.swift`<br>`ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Intents/IntentsView.swift`<br>`ios/MarketplaceClient/Sources/MarketplaceClientFoundation/AppShell/AppShellView.swift`<br>`ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Analytics/AnalyticsClient.swift`<br>`ios/MarketplaceClient/Tests/MarketplaceClientFoundationTests/NotificationsFeatureTests.swift`<br>`ios/MarketplaceClient/Tests/MarketplaceClientFoundationTests/AnalyticsTests.swift`<br>`scripts/ios/run-sc-an-01.mjs`<br>`scripts/ios/run-sc-rl-03.mjs` | `SC-AN-01` (`artifacts/milestones/IOS-M6/latest/sc-an-01.json`)<br>`SC-RL-03` (`artifacts/milestones/IOS-M6/latest/sc-rl-03.json`)<br>`SC-UX-02` (`artifacts/milestones/IOS-M6/latest/sc-ux-02.json`)<br>`SC-UX-03` (`artifacts/milestones/IOS-M6/latest/sc-ux-03.json`) | Pass | None |
| `IOS-T028` Offline cache hydration + stale-state banners | `ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Persistence/OfflineSnapshotStore.swift`<br>`ios/MarketplaceClient/Sources/MarketplaceClientFoundation/UI/StaleDataBannerView.swift`<br>`ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Items/ItemsModels.swift`<br>`ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Items/ItemsViewModel.swift`<br>`ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Items/ItemsView.swift`<br>`ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Intents/IntentsViewModel.swift`<br>`ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Inbox/InboxViewModel.swift`<br>`ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Inbox/InboxView.swift`<br>`ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Active/ActiveViewModel.swift`<br>`ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Active/ActiveView.swift`<br>`ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Receipts/ReceiptsViewModel.swift`<br>`ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Receipts/ReceiptsView.swift`<br>`ios/MarketplaceClient/Tests/MarketplaceClientFoundationTests/OfflineResilienceFeatureTests.swift`<br>`ios/MarketplaceClient/Tests/MarketplaceClientFoundationTests/PersistenceTests.swift`<br>`scripts/ios/run-sc-rl-01.mjs`<br>`scripts/ios/run-sc-rl-03.mjs` | `SC-RL-01` (`artifacts/milestones/IOS-M6/latest/sc-rl-01.json`)<br>`SC-RL-03` (`artifacts/milestones/IOS-M6/latest/sc-rl-03.json`)<br>`SC-API-01` regression (`artifacts/milestones/IOS-M6/latest/sc-api-01.json`)<br>`SC-DS-01` regression (`artifacts/milestones/IOS-M6/latest/sc-ds-01.json`)<br>`SC-DS-02` regression (`artifacts/milestones/IOS-M6/latest/sc-ds-02.json`) | Pass | None |

## Required Gate Results

| Gate | Result | Evidence |
|---|---|---|
| `SC-RL-01` | Pass | `artifacts/milestones/IOS-M6/latest/sc-rl-01.json` |
| `SC-RL-03` | Pass | `artifacts/milestones/IOS-M6/latest/sc-rl-03.json` |
| `SC-AN-01` | Pass | `artifacts/milestones/IOS-M6/latest/sc-an-01.json` |
| `SC-UX-02` | Pass | `artifacts/milestones/IOS-M6/latest/sc-ux-02.json` |
| `SC-UX-03` | Pass | `artifacts/milestones/IOS-M6/latest/sc-ux-03.json` |
| `SC-API-03` (regression) | Pass | `artifacts/milestones/IOS-M6/latest/sc-api-03.json` |
| `SC-API-04` (regression) | Pass | `artifacts/milestones/IOS-M6/latest/sc-api-04.json` |
| `SC-API-01` (regression) | Pass | `artifacts/milestones/IOS-M6/latest/sc-api-01.json` |
| `SC-DS-01` (regression) | Pass | `artifacts/milestones/IOS-M6/latest/sc-ds-01.json` |
| `SC-DS-02` (regression) | Pass | `artifacts/milestones/IOS-M6/latest/sc-ds-02.json` |

Additional execution evidence:
- Full package tests: `artifacts/milestones/IOS-M6/latest/swift-test.log` (66 tests, 0 failures)
- Verification command log: `artifacts/milestones/IOS-M6/latest/commands.log`
- Verification runner: `verify/ios-m6.sh`

## Incomplete / Blocking List

- None for `IOS-T026`..`IOS-T028` scope.
- No blockers encountered after applying elevated permissions for the verification wrapper run.
