import XCTest
@testable import MarketplaceClientFoundation

@MainActor
final class AppShellUISmokeTests: XCTestCase {
    func testBootsWithFiveTabsWhenAllEnabled() {
        let vm = AppShellViewModel(featureFlags: .allEnabled)

        XCTAssertEqual(vm.availableTabs, [.items, .intents, .inbox, .active, .receipts])
        XCTAssertEqual(vm.selectedTab, .items)
    }

    func testFeatureFlagFallbackRouteWhenTabDisabled() {
        var flags = MarketplaceFeatureFlags.allEnabled
        flags.inboxEnabled = false

        let vm = AppShellViewModel(featureFlags: flags)
        vm.open(.proposal(id: "cycle_123"))

        XCTAssertNotEqual(vm.selectedTab, .inbox)
        XCTAssertEqual(vm.selectedTab, .items)
    }

    func testDeepLinkRoutesToExpectedTabs() {
        let vm = AppShellViewModel(featureFlags: .allEnabled)

        let proposalURL = URL(string: "swapgraph://proposal/cycle_111")!
        XCTAssertTrue(vm.handleDeepLink(proposalURL))
        XCTAssertEqual(vm.selectedTab, .inbox)
        XCTAssertEqual(vm.selectedProposalID, "cycle_111")

        let activeURL = URL(string: "https://swapgraph.app/active/cycle_222")!
        XCTAssertTrue(vm.handleDeepLink(activeURL))
        XCTAssertEqual(vm.selectedTab, .active)
        XCTAssertEqual(vm.selectedActiveCycleID, "cycle_222")

        let receiptURL = URL(string: "swapgraph://receipt/cycle_333")!
        XCTAssertTrue(vm.handleDeepLink(receiptURL))
        XCTAssertEqual(vm.selectedTab, .receipts)
        XCTAssertEqual(vm.selectedReceiptCycleID, "cycle_333")
    }
}
