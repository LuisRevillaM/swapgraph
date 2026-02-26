import Foundation

public enum MarketplacePersistenceError: Error, Equatable {
    case encodingFailed
    case decodingFailed
}

public final class MarketplacePersistence: @unchecked Sendable {
    private let secureStore: SecureStore
    private let cacheStore: FileCacheStore
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    public init(secureStore: SecureStore, cacheStore: FileCacheStore) {
        self.secureStore = secureStore
        self.cacheStore = cacheStore
        self.encoder = JSONEncoder()
        self.decoder = JSONDecoder()
    }

    public func saveSessionToken(_ token: String) throws {
        guard let data = token.data(using: .utf8) else {
            throw MarketplacePersistenceError.encodingFailed
        }
        try secureStore.set(data, for: "session_token")
    }

    public func loadSessionToken() throws -> String? {
        guard let data = try secureStore.data(for: "session_token") else {
            return nil
        }
        guard let token = String(data: data, encoding: .utf8) else {
            throw MarketplacePersistenceError.decodingFailed
        }
        return token
    }

    public func clearSessionToken() throws {
        try secureStore.delete("session_token")
    }

    public func cache<Value: Codable & Sendable>(
        value: Value,
        key: String,
        ttlSeconds: Int,
        nowEpochSeconds: Int
    ) throws {
        try cacheStore.write(value, key: key, ttlSeconds: ttlSeconds, nowEpochSeconds: nowEpochSeconds)
    }

    public func loadCached<Value: Codable & Sendable>(
        _ type: Value.Type,
        key: String,
        nowEpochSeconds: Int
    ) throws -> Value? {
        try cacheStore.read(type, key: key, nowEpochSeconds: nowEpochSeconds)
    }

    public func invalidateCache(key: String) throws {
        try cacheStore.invalidate(key: key)
    }
}
