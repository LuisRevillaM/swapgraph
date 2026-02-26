import XCTest
@testable import MarketplaceClientFoundation

@MainActor
final class ReleaseReadinessTests: XCTestCase {
    func testRollbackDrillFallsBackWhenInboxRouteDisabled() {
        var flags = MarketplaceFeatureFlags.allEnabled
        flags.inboxEnabled = false
        let shell = AppShellViewModel(featureFlags: flags)

        shell.open(.proposal(id: "cycle_rollback"))

        XCTAssertEqual(shell.selectedTab, .items)
        XCTAssertEqual(shell.activeRoute, .tab(.items))
        XCTAssertNil(shell.selectedProposalID)
    }

    func testRollbackDrillCanSuppressPushRoutingViaPreferences() {
        let shell = AppShellViewModel(featureFlags: .allEnabled)
        let store = RollbackNotificationStore(
            preferences: MarketplaceNotificationPreferences(
                enabledCategories: [],
                minimumUrgency: .critical
            )
        )
        let coordinator = PushNotificationIntakeCoordinator(
            appShell: shell,
            preferencesStore: store
        )

        let handled = coordinator.handle(userInfo: [
            "route_kind": "proposal",
            "proposal_id": "cycle_rollback",
            "urgency": "high"
        ])

        XCTAssertFalse(handled)
        XCTAssertEqual(shell.selectedTab, .items)
        XCTAssertNil(shell.selectedProposalID)
    }
}

private final class RollbackNotificationStore: MarketplaceNotificationPreferencesStoreProtocol, @unchecked Sendable {
    private let preferences: MarketplaceNotificationPreferences

    init(preferences: MarketplaceNotificationPreferences) {
        self.preferences = preferences
    }

    func load(nowEpochSeconds: Int) throws -> MarketplaceNotificationPreferences {
        _ = nowEpochSeconds
        return preferences
    }

    func save(_ preferences: MarketplaceNotificationPreferences, nowEpochSeconds: Int) throws {
        _ = preferences
        _ = nowEpochSeconds
    }

    func reset() throws {}
}
