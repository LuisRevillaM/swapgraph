import Foundation

public struct OfflineCachedValue<Value: Codable & Sendable>: Codable, Sendable {
    public let cachedAtEpochSeconds: Int
    public let value: Value

    enum CodingKeys: String, CodingKey {
        case cachedAtEpochSeconds = "cached_at_epoch_seconds"
        case value
    }

    public init(cachedAtEpochSeconds: Int, value: Value) {
        self.cachedAtEpochSeconds = cachedAtEpochSeconds
        self.value = value
    }
}

public final class OfflineSnapshotStore<Value: Codable & Sendable>: @unchecked Sendable {
    private let persistence: MarketplacePersistence
    private let cacheKey: String
    private let ttlSeconds: Int

    public init(
        persistence: MarketplacePersistence,
        cacheKey: String,
        ttlSeconds: Int = 60 * 60 * 24 * 7
    ) {
        self.persistence = persistence
        self.cacheKey = cacheKey
        self.ttlSeconds = ttlSeconds
    }

    public func load(nowEpochSeconds: Int) throws -> OfflineCachedValue<Value>? {
        try persistence.loadCached(
            OfflineCachedValue<Value>.self,
            key: cacheKey,
            nowEpochSeconds: nowEpochSeconds
        )
    }

    public func save(_ value: Value, nowEpochSeconds: Int) throws {
        let payload = OfflineCachedValue(cachedAtEpochSeconds: nowEpochSeconds, value: value)
        try persistence.cache(
            value: payload,
            key: cacheKey,
            ttlSeconds: ttlSeconds,
            nowEpochSeconds: nowEpochSeconds
        )
    }
}
