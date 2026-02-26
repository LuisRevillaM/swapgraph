import Foundation
import XCTest
@testable import MarketplaceClientFoundation

@MainActor
final class PushNotificationRoutingTests: XCTestCase {
    func testProposalPushRoutesToInboxAndEntity() {
        let appShell = AppShellViewModel(featureFlags: .allEnabled)
        let store = InMemoryNotificationPreferencesStore()
        let coordinator = PushNotificationIntakeCoordinator(
            appShell: appShell,
            preferencesStore: store
        )

        let handled = coordinator.handle(userInfo: [
            "route_kind": "proposal",
            "proposal_id": "cycle_111",
            "urgency": "high"
        ])

        XCTAssertTrue(handled)
        XCTAssertEqual(appShell.selectedTab, .inbox)
        XCTAssertEqual(appShell.selectedProposalID, "cycle_111")
    }

    func testActivePushRoutesToActiveTimelineAndEntity() {
        let appShell = AppShellViewModel(featureFlags: .allEnabled)
        let store = InMemoryNotificationPreferencesStore()
        let coordinator = PushNotificationIntakeCoordinator(
            appShell: appShell,
            preferencesStore: store
        )

        let handled = coordinator.handle(userInfo: [
            "route_kind": "active_swap",
            "cycle_id": "cycle_222",
            "urgency": "critical"
        ])

        XCTAssertTrue(handled)
        XCTAssertEqual(appShell.selectedTab, .active)
        XCTAssertEqual(appShell.selectedActiveCycleID, "cycle_222")
    }

    func testReceiptPushRoutesToReceiptsAndEntity() {
        let appShell = AppShellViewModel(featureFlags: .allEnabled)
        let store = InMemoryNotificationPreferencesStore()
        let coordinator = PushNotificationIntakeCoordinator(
            appShell: appShell,
            preferencesStore: store
        )

        let handled = coordinator.handle(userInfo: [
            "route_kind": "receipt",
            "cycle_id": "cycle_333",
            "urgency": "high"
        ])

        XCTAssertTrue(handled)
        XCTAssertEqual(appShell.selectedTab, .receipts)
        XCTAssertEqual(appShell.selectedReceiptCycleID, "cycle_333")
    }

    func testFiltersPushWhenCategoryIsDisabled() {
        let appShell = AppShellViewModel(featureFlags: .allEnabled)
        let store = InMemoryNotificationPreferencesStore(
            preferences: MarketplaceNotificationPreferences(
                enabledCategories: [.proposal],
                minimumUrgency: .normal
            )
        )
        let coordinator = PushNotificationIntakeCoordinator(
            appShell: appShell,
            preferencesStore: store
        )

        let handled = coordinator.handle(userInfo: [
            "route_kind": "active_swap",
            "cycle_id": "cycle_222",
            "urgency": "high"
        ])

        XCTAssertFalse(handled)
        XCTAssertEqual(appShell.selectedTab, .items)
        XCTAssertNil(appShell.selectedActiveCycleID)
    }

    func testFiltersPushWhenUrgencyIsBelowPreferenceThreshold() {
        let appShell = AppShellViewModel(featureFlags: .allEnabled)
        let store = InMemoryNotificationPreferencesStore(
            preferences: MarketplaceNotificationPreferences(
                enabledCategories: Set(MarketplaceNotificationCategory.allCases),
                minimumUrgency: .high
            )
        )
        let coordinator = PushNotificationIntakeCoordinator(
            appShell: appShell,
            preferencesStore: store
        )

        let handled = coordinator.handle(userInfo: [
            "route_kind": "proposal",
            "proposal_id": "cycle_111",
            "urgency": "normal"
        ])

        XCTAssertFalse(handled)
        XCTAssertEqual(appShell.selectedTab, .items)
        XCTAssertNil(appShell.selectedProposalID)
    }
}

final class PushNotificationParserTests: XCTestCase {
    func testParserMapsDeepLinkPayload() throws {
        let parsed = try XCTUnwrap(
            MarketplacePushNotificationParser.parse(userInfo: [
                "deep_link": "swapgraph://active/cycle_abc",
                "urgency": "critical"
            ])
        )

        XCTAssertEqual(parsed.category, .activeSwap)
        XCTAssertEqual(parsed.urgency, .critical)
        XCTAssertEqual(parsed.route, .activeSwap(cycleID: "cycle_abc"))
        XCTAssertEqual(parsed.entityID, "cycle_abc")
    }

    func testParserRejectsPayloadMissingRouteInformation() {
        let parsed = MarketplacePushNotificationParser.parse(userInfo: [
            "urgency": "high",
            "title": "Settlement update"
        ])

        XCTAssertNil(parsed)
    }
}

@MainActor
final class NotificationPreferencesFeatureTests: XCTestCase {
    func testPreferencesStorePersistsValues() throws {
        let tempDirectory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("notification-preferences-\(UUID().uuidString)")
        let persistence = MarketplacePersistence(
            secureStore: InMemorySecureStore(),
            cacheStore: try FileCacheStore(directoryURL: tempDirectory)
        )
        let store = MarketplaceNotificationPreferencesStore(persistence: persistence)

        let expected = MarketplaceNotificationPreferences(
            enabledCategories: [.proposal, .receipt],
            minimumUrgency: .high
        )

        try store.save(expected, nowEpochSeconds: 100)
        let hydrated = try store.load(nowEpochSeconds: 200)
        XCTAssertEqual(hydrated, expected)
    }

    func testPreferencesViewModelPersistsAndAffectsRoutingFilterBehavior() throws {
        let store = InMemoryNotificationPreferencesStore()
        let viewModel = NotificationPreferencesViewModel(store: store)
        viewModel.load()

        viewModel.setCategory(.proposal, enabled: false)
        viewModel.setMinimumUrgency(.high)

        let saved = try store.load(nowEpochSeconds: 10)
        XCTAssertFalse(saved.enabledCategories.contains(.proposal))
        XCTAssertEqual(saved.minimumUrgency, .high)

        let appShell = AppShellViewModel(featureFlags: .allEnabled)
        let coordinator = PushNotificationIntakeCoordinator(
            appShell: appShell,
            preferencesStore: store
        )

        let handledProposal = coordinator.handle(userInfo: [
            "route_kind": "proposal",
            "proposal_id": "cycle_1",
            "urgency": "critical"
        ])
        XCTAssertFalse(handledProposal)

        let handledActive = coordinator.handle(userInfo: [
            "route_kind": "active_swap",
            "cycle_id": "cycle_2",
            "urgency": "normal"
        ])
        XCTAssertFalse(handledActive)

        let handledCriticalReceipt = coordinator.handle(userInfo: [
            "route_kind": "receipt",
            "cycle_id": "cycle_3",
            "urgency": "critical"
        ])
        XCTAssertTrue(handledCriticalReceipt)
        XCTAssertEqual(appShell.selectedTab, .receipts)
        XCTAssertEqual(appShell.selectedReceiptCycleID, "cycle_3")
    }
}

private final class InMemoryNotificationPreferencesStore: MarketplaceNotificationPreferencesStoreProtocol, @unchecked Sendable {
    private var preferences: MarketplaceNotificationPreferences

    init(preferences: MarketplaceNotificationPreferences = .default) {
        self.preferences = preferences
    }

    func load(nowEpochSeconds: Int) throws -> MarketplaceNotificationPreferences {
        _ = nowEpochSeconds
        return preferences
    }

    func save(_ preferences: MarketplaceNotificationPreferences, nowEpochSeconds: Int) throws {
        _ = nowEpochSeconds
        self.preferences = preferences
    }

    func reset() throws {
        preferences = .default
    }
}
