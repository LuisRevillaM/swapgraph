import Foundation

public protocol MarketplaceNotificationPreferencesStoreProtocol: Sendable {
    func load(nowEpochSeconds: Int) throws -> MarketplaceNotificationPreferences
    func save(_ preferences: MarketplaceNotificationPreferences, nowEpochSeconds: Int) throws
    func reset() throws
}

public final class MarketplaceNotificationPreferencesStore: MarketplaceNotificationPreferencesStoreProtocol, @unchecked Sendable {
    private let persistence: MarketplacePersistence
    private let cacheKey: String
    private let ttlSeconds: Int

    public init(
        persistence: MarketplacePersistence,
        cacheKey: String = "marketplace.notification.preferences",
        ttlSeconds: Int = 60 * 60 * 24 * 365
    ) {
        self.persistence = persistence
        self.cacheKey = cacheKey
        self.ttlSeconds = ttlSeconds
    }

    public func load(nowEpochSeconds: Int) throws -> MarketplaceNotificationPreferences {
        try persistence.loadCached(
            MarketplaceNotificationPreferences.self,
            key: cacheKey,
            nowEpochSeconds: nowEpochSeconds
        ) ?? .default
    }

    public func save(_ preferences: MarketplaceNotificationPreferences, nowEpochSeconds: Int) throws {
        try persistence.cache(
            value: preferences,
            key: cacheKey,
            ttlSeconds: ttlSeconds,
            nowEpochSeconds: nowEpochSeconds
        )
    }

    public func reset() throws {
        try persistence.invalidateCache(key: cacheKey)
    }
}
