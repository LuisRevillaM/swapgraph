import Foundation

public struct IntentWatchSnapshot: Codable, Sendable, Equatable {
    public let nearMatchesByIntentID: [String: Int]

    enum CodingKeys: String, CodingKey {
        case nearMatchesByIntentID = "near_matches_by_intent_id"
    }

    public init(nearMatchesByIntentID: [String: Int]) {
        self.nearMatchesByIntentID = nearMatchesByIntentID
    }
}

public protocol IntentWatchSnapshotStoreProtocol: Sendable {
    func load(nowEpochSeconds: Int) throws -> IntentWatchSnapshot?
    func save(_ snapshot: IntentWatchSnapshot, nowEpochSeconds: Int) throws
}

public final class IntentWatchSnapshotStore: IntentWatchSnapshotStoreProtocol, @unchecked Sendable {
    private let persistence: MarketplacePersistence
    private let cacheKey: String
    private let ttlSeconds: Int

    public init(
        persistence: MarketplacePersistence,
        cacheKey: String = "intents.watch.snapshot",
        ttlSeconds: Int = 60 * 60 * 24 * 30
    ) {
        self.persistence = persistence
        self.cacheKey = cacheKey
        self.ttlSeconds = ttlSeconds
    }

    public func load(nowEpochSeconds: Int) throws -> IntentWatchSnapshot? {
        try persistence.loadCached(IntentWatchSnapshot.self, key: cacheKey, nowEpochSeconds: nowEpochSeconds)
    }

    public func save(_ snapshot: IntentWatchSnapshot, nowEpochSeconds: Int) throws {
        try persistence.cache(
            value: snapshot,
            key: cacheKey,
            ttlSeconds: ttlSeconds,
            nowEpochSeconds: nowEpochSeconds
        )
    }
}

public final class InMemoryIntentWatchSnapshotStore: IntentWatchSnapshotStoreProtocol, @unchecked Sendable {
    private var snapshot: IntentWatchSnapshot?

    public init(snapshot: IntentWatchSnapshot? = nil) {
        self.snapshot = snapshot
    }

    public func load(nowEpochSeconds: Int) throws -> IntentWatchSnapshot? {
        snapshot
    }

    public func save(_ snapshot: IntentWatchSnapshot, nowEpochSeconds: Int) throws {
        self.snapshot = snapshot
    }
}
