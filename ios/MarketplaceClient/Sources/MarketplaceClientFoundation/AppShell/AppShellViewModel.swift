import Foundation

@MainActor
public final class AppShellViewModel: ObservableObject {
    @Published public private(set) var featureFlags: MarketplaceFeatureFlags
    @Published public var selectedTab: MarketplaceTab
    @Published public private(set) var activeRoute: AppRoute
    @Published public private(set) var selectedProposalID: String?
    @Published public private(set) var selectedActiveCycleID: String?
    @Published public private(set) var selectedReceiptCycleID: String?

    public init(featureFlags: MarketplaceFeatureFlags = .allEnabled, initialTab: MarketplaceTab = .items) {
        self.featureFlags = featureFlags
        let fallback = featureFlags.enabledTabs.first ?? .items
        let bootTab = featureFlags.enabledTabs.contains(initialTab) ? initialTab : fallback
        self.selectedTab = bootTab
        self.activeRoute = .tab(bootTab)
    }

    public var availableTabs: [MarketplaceTab] {
        featureFlags.enabledTabs
    }

    public func updateFeatureFlags(_ newFlags: MarketplaceFeatureFlags) {
        featureFlags = newFlags
        guard !newFlags.enabledTabs.contains(selectedTab) else { return }

        if let firstTab = newFlags.enabledTabs.first {
            open(.tab(firstTab))
        }
    }

    public func open(_ route: AppRoute) {
        let targetTab = route.tab
        guard availableTabs.contains(targetTab) else {
            if let firstTab = availableTabs.first {
                selectedTab = firstTab
                activeRoute = .tab(firstTab)
            }
            return
        }

        selectedTab = targetTab
        activeRoute = route

        switch route {
        case .proposal(let id):
            selectedProposalID = id
            selectedActiveCycleID = nil
            selectedReceiptCycleID = nil
        case .activeSwap(let cycleID):
            selectedProposalID = nil
            selectedActiveCycleID = cycleID
            selectedReceiptCycleID = nil
        case .receipt(let cycleID):
            selectedProposalID = nil
            selectedActiveCycleID = nil
            selectedReceiptCycleID = cycleID
        case .tab:
            selectedProposalID = nil
            selectedActiveCycleID = nil
            selectedReceiptCycleID = nil
        }
    }

    @discardableResult
    public func handleDeepLink(_ url: URL) -> Bool {
        guard let route = DeepLinkParser.parse(url: url) else {
            return false
        }
        open(route)
        return true
    }
}
