import Foundation
import XCTest
@testable import MarketplaceClientFoundation

final class PersistenceTests: XCTestCase {
    struct CachedProjection: Codable, Sendable, Equatable {
        let cycleID: String
        let state: String
    }

    func testPersistsSessionAndHydratesCacheWithTTL() throws {
        let tempDirectory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("marketplace-cache-\(UUID().uuidString)")

        let secureStore = InMemorySecureStore()
        let fileCache = try FileCacheStore(directoryURL: tempDirectory)
        let persistence = MarketplacePersistence(secureStore: secureStore, cacheStore: fileCache)

        try persistence.saveSessionToken("session_token_abc")
        XCTAssertEqual(try persistence.loadSessionToken(), "session_token_abc")

        let cached = CachedProjection(cycleID: "cycle_1", state: "escrow.pending")
        try persistence.cache(value: cached, key: "timeline.cycle_1", ttlSeconds: 10, nowEpochSeconds: 100)

        let hydrated = try persistence.loadCached(CachedProjection.self, key: "timeline.cycle_1", nowEpochSeconds: 105)
        XCTAssertEqual(hydrated, cached)

        let expired = try persistence.loadCached(CachedProjection.self, key: "timeline.cycle_1", nowEpochSeconds: 111)
        XCTAssertNil(expired)

        try persistence.clearSessionToken()
        XCTAssertNil(try persistence.loadSessionToken())
    }

    func testOfflineSnapshotStorePersistsCachedAtMetadata() throws {
        let tempDirectory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("marketplace-offline-cache-\(UUID().uuidString)")

        let persistence = MarketplacePersistence(
            secureStore: InMemorySecureStore(),
            cacheStore: try FileCacheStore(directoryURL: tempDirectory)
        )

        let store = OfflineSnapshotStore<CachedProjection>(
            persistence: persistence,
            cacheKey: "offline.projection",
            ttlSeconds: 30
        )

        let projection = CachedProjection(cycleID: "cycle_2", state: "executing")
        try store.save(projection, nowEpochSeconds: 200)

        let hydrated = try store.load(nowEpochSeconds: 210)
        XCTAssertEqual(hydrated?.value, projection)
        XCTAssertEqual(hydrated?.cachedAtEpochSeconds, 200)

        let expired = try store.load(nowEpochSeconds: 231)
        XCTAssertNil(expired)
    }
}
