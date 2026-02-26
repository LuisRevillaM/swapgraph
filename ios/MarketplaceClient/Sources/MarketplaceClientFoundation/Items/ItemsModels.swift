import Foundation

public struct MarketplaceItemCardModel: Identifiable, Sendable, Equatable, Codable {
    public let id: String
    public let assetID: String
    public let displayName: String
    public let wearLabel: String?
    public let floatValue: Double?
    public let priceUSD: Double?
    public let demandCount: Int
    public let confidenceBps: Int?

    public init(
        id: String,
        assetID: String,
        displayName: String,
        wearLabel: String? = nil,
        floatValue: Double? = nil,
        priceUSD: Double? = nil,
        demandCount: Int,
        confidenceBps: Int? = nil
    ) {
        self.id = id
        self.assetID = assetID
        self.displayName = displayName
        self.wearLabel = wearLabel
        self.floatValue = floatValue
        self.priceUSD = priceUSD
        self.demandCount = demandCount
        self.confidenceBps = confidenceBps
    }
}

public struct ItemsSectionModel: Identifiable, Sendable, Equatable, Codable {
    public let id: String
    public let title: String
    public let items: [MarketplaceItemCardModel]

    public init(id: String, title: String, items: [MarketplaceItemCardModel]) {
        self.id = id
        self.title = title
        self.items = items
    }
}

public struct ItemsScreenSnapshot: Sendable, Equatable, Codable {
    public let demandBannerCount: Int
    public let sections: [ItemsSectionModel]
    public let emptyMessage: String

    public init(demandBannerCount: Int, sections: [ItemsSectionModel], emptyMessage: String) {
        self.demandBannerCount = demandBannerCount
        self.sections = sections
        self.emptyMessage = emptyMessage
    }
}
