import Foundation

@MainActor
public final class ItemsViewModel: ObservableObject {
    @Published public private(set) var snapshot: ItemsScreenSnapshot?
    @Published public private(set) var fallbackState: FallbackState?
    @Published public private(set) var staleDataState: StaleDataState?
    @Published public private(set) var isLoading = false

    private let repository: MarketplaceItemsRepositoryProtocol
    private let offlineStore: OfflineSnapshotStore<ItemsScreenSnapshot>?
    private let analyticsClient: AnalyticsClient?
    private let actorID: String
    private let now: () -> Date

    public init(
        repository: MarketplaceItemsRepositoryProtocol,
        offlineStore: OfflineSnapshotStore<ItemsScreenSnapshot>? = nil,
        analyticsClient: AnalyticsClient? = nil,
        actorID: String = "u1",
        now: @escaping () -> Date = Date.init
    ) {
        self.repository = repository
        self.offlineStore = offlineStore
        self.analyticsClient = analyticsClient
        self.actorID = actorID
        self.now = now
    }

    public func refresh() async {
        isLoading = true
        defer { isLoading = false }

        do {
            let next = try await repository.loadItems()
            snapshot = next
            fallbackState = nil
            staleDataState = nil
            try? offlineStore?.save(next, nowEpochSeconds: nowEpochSeconds())

            if let analyticsClient {
                try? await analyticsClient.track(
                    AnalyticsEvent(
                        name: "marketplace.items.viewed",
                        correlationID: UUID().uuidString.lowercased(),
                        occurredAt: ISO8601DateFormatter().string(from: now()),
                        payload: [
                            "actor_id": .string(actorID),
                            "cycle_opportunities": .number(Double(next.demandBannerCount)),
                            "section_count": .number(Double(next.sections.count))
                        ]
                    )
                )
            }
        } catch let error as MarketplaceClientError {
            if let cached = try? offlineStore?.load(nowEpochSeconds: nowEpochSeconds()) {
                snapshot = cached.value
                fallbackState = nil
                staleDataState = .cachedFallback(cachedAtEpochSeconds: cached.cachedAtEpochSeconds)
                return
            }
            fallbackState = FallbackState.from(error: error)
            staleDataState = nil
        } catch {
            if let cached = try? offlineStore?.load(nowEpochSeconds: nowEpochSeconds()) {
                snapshot = cached.value
                fallbackState = nil
                staleDataState = .cachedFallback(cachedAtEpochSeconds: cached.cachedAtEpochSeconds)
                return
            }
            fallbackState = .failure(
                title: "Unable to load items",
                message: "Please retry in a moment."
            )
            staleDataState = nil
        }
    }

    public func trackDemandBannerTap() async {
        guard let analyticsClient, let snapshot else { return }

        try? await analyticsClient.track(
            AnalyticsEvent(
                name: "marketplace.items.demand_banner_tapped",
                correlationID: UUID().uuidString.lowercased(),
                occurredAt: ISO8601DateFormatter().string(from: now()),
                payload: [
                    "actor_id": .string(actorID),
                    "opportunity_count": .number(Double(snapshot.demandBannerCount))
                ]
            )
        )
    }

    public static func preview() -> ItemsViewModel {
        let snapshot = ItemsScreenSnapshot(
            demandBannerCount: 3,
            sections: [
                ItemsSectionModel(
                    id: "highest-demand",
                    title: "Highest demand",
                    items: [
                        MarketplaceItemCardModel(
                            id: "asset_a",
                            assetID: "asset_a",
                            displayName: "M9 Bayonet",
                            wearLabel: "MW",
                            floatValue: 0.08,
                            priceUSD: 722.4,
                            demandCount: 17,
                            confidenceBps: 8600
                        )
                    ]
                ),
                ItemsSectionModel(
                    id: "also-tradable",
                    title: "Also tradable",
                    items: [
                        MarketplaceItemCardModel(
                            id: "asset_b",
                            assetID: "asset_b",
                            displayName: "AK-47 Vulcan",
                            wearLabel: "FT",
                            floatValue: 0.21,
                            priceUSD: 315.5,
                            demandCount: 2,
                            confidenceBps: 8000
                        )
                    ]
                )
            ],
            emptyMessage: "Post an intent to start matching"
        )

        let model = ItemsViewModel(repository: StaticItemsRepository(snapshot: snapshot))
        model.snapshot = snapshot
        return model
    }

    private func nowEpochSeconds() -> Int {
        Int(now().timeIntervalSince1970)
    }
}
