import Foundation

public protocol MarketplaceItemsRepositoryProtocol: Sendable {
    func loadItems() async throws -> ItemsScreenSnapshot
}

public actor MarketplaceItemsRepository: MarketplaceItemsRepositoryProtocol {
    private let apiClient: MarketplaceAPIClient

    public init(apiClient: MarketplaceAPIClient) {
        self.apiClient = apiClient
    }

    public func loadItems() async throws -> ItemsScreenSnapshot {
        async let projectionTask = apiClient.inventoryAwakeningProjection(limit: 50)
        async let proposalsTask = apiClient.listProposals()

        let projection = try await projectionTask
        let proposals = try await proposalsTask

        var demandCounts: [String: Int] = [:]
        for proposal in proposals.proposals {
            for participant in proposal.participants {
                for asset in participant.give {
                    demandCounts[asset.assetID, default: 0] += 1
                }
            }
        }

        var confidenceByAsset: [String: Int] = [:]
        var allAssetIDs = Set<String>()

        for recommendation in projection.projection.recommendedFirstIntents {
            if let assetID = recommendation.suggestedGiveAssetID {
                allAssetIDs.insert(assetID)
                confidenceByAsset[assetID] = recommendation.confidenceBps
            }
        }

        for key in demandCounts.keys {
            allAssetIDs.insert(key)
        }

        let cards = allAssetIDs.map { assetID in
            MarketplaceItemCardModel(
                id: assetID,
                assetID: assetID,
                displayName: MarketplaceItemsRepository.displayName(for: assetID),
                wearLabel: nil,
                floatValue: nil,
                priceUSD: nil,
                demandCount: demandCounts[assetID, default: 0],
                confidenceBps: confidenceByAsset[assetID]
            )
        }
        .sorted {
            if $0.demandCount != $1.demandCount {
                return $0.demandCount > $1.demandCount
            }
            return $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
        }

        let highestDemand = cards.filter { $0.demandCount > 0 }
        let tradable = cards.filter { $0.demandCount == 0 }

        var sections: [ItemsSectionModel] = []
        if !highestDemand.isEmpty {
            sections.append(ItemsSectionModel(id: "highest-demand", title: "Highest demand", items: highestDemand))
        }
        if !tradable.isEmpty {
            sections.append(ItemsSectionModel(id: "also-tradable", title: "Also tradable", items: tradable))
        }

        return ItemsScreenSnapshot(
            demandBannerCount: projection.projection.swappabilitySummary.cycleOpportunities,
            sections: sections,
            emptyMessage: "Post an intent to start matching"
        )
    }

    private static func displayName(for assetID: String) -> String {
        let normalized = assetID
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)

        if normalized.isEmpty {
            return "Unknown item"
        }

        return normalized
            .split(separator: " ")
            .map { word in
                let value = String(word)
                if value.count <= 3 {
                    return value.uppercased()
                }
                return value.prefix(1).uppercased() + value.dropFirst().lowercased()
            }
            .joined(separator: " ")
    }
}

public struct StaticItemsRepository: MarketplaceItemsRepositoryProtocol {
    public let snapshot: ItemsScreenSnapshot

    public init(snapshot: ItemsScreenSnapshot) {
        self.snapshot = snapshot
    }

    public func loadItems() async throws -> ItemsScreenSnapshot {
        snapshot
    }
}
