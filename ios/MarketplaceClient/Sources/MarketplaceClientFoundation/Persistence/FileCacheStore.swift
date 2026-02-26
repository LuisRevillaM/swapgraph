import Foundation
import CryptoKit

public enum FileCacheStoreError: Error, Equatable {
    case unableToCreateDirectory
    case invalidCachePath
}

public struct CacheEnvelope<Value: Codable & Sendable>: Codable, Sendable {
    public let storedAtEpochSeconds: Int
    public let ttlSeconds: Int
    public let value: Value

    public init(storedAtEpochSeconds: Int, ttlSeconds: Int, value: Value) {
        self.storedAtEpochSeconds = storedAtEpochSeconds
        self.ttlSeconds = ttlSeconds
        self.value = value
    }

    public func isExpired(nowEpochSeconds: Int) -> Bool {
        nowEpochSeconds > (storedAtEpochSeconds + ttlSeconds)
    }
}

public final class FileCacheStore: @unchecked Sendable {
    public let directoryURL: URL
    private let fileManager: FileManager
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    public init(
        directoryURL: URL,
        fileManager: FileManager = .default
    ) throws {
        self.directoryURL = directoryURL
        self.fileManager = fileManager
        self.encoder = JSONEncoder()
        self.decoder = JSONDecoder()

        var isDirectory = ObjCBool(false)
        if fileManager.fileExists(atPath: directoryURL.path, isDirectory: &isDirectory) {
            guard isDirectory.boolValue else {
                throw FileCacheStoreError.invalidCachePath
            }
        } else {
            do {
                try fileManager.createDirectory(at: directoryURL, withIntermediateDirectories: true)
            } catch {
                throw FileCacheStoreError.unableToCreateDirectory
            }
        }
    }

    public func write<Value: Codable & Sendable>(
        _ value: Value,
        key: String,
        ttlSeconds: Int,
        nowEpochSeconds: Int
    ) throws {
        let envelope = CacheEnvelope(
            storedAtEpochSeconds: nowEpochSeconds,
            ttlSeconds: max(ttlSeconds, 1),
            value: value
        )

        let data = try encoder.encode(envelope)
        try data.write(to: fileURL(for: key), options: [.atomic])
    }

    public func read<Value: Codable & Sendable>(
        _ type: Value.Type,
        key: String,
        nowEpochSeconds: Int
    ) throws -> Value? {
        let primaryFileURL = fileURL(for: key)
        let legacyURL = legacyFileURL(for: key)
        let targetURL: URL

        if fileManager.fileExists(atPath: primaryFileURL.path) {
            targetURL = primaryFileURL
        } else if fileManager.fileExists(atPath: legacyURL.path) {
            targetURL = legacyURL
        } else {
            return nil
        }

        let data = try Data(contentsOf: targetURL)
        let envelope = try decoder.decode(CacheEnvelope<Value>.self, from: data)

        if envelope.isExpired(nowEpochSeconds: nowEpochSeconds) {
            try? fileManager.removeItem(at: targetURL)
            return nil
        }

        if targetURL != primaryFileURL {
            try? data.write(to: primaryFileURL, options: [.atomic])
            try? fileManager.removeItem(at: targetURL)
        }

        return envelope.value
    }

    public func invalidate(key: String) throws {
        let hashedURL = fileURL(for: key)
        let legacyURL = legacyFileURL(for: key)

        if fileManager.fileExists(atPath: hashedURL.path) {
            try fileManager.removeItem(at: hashedURL)
        }
        if fileManager.fileExists(atPath: legacyURL.path) {
            try fileManager.removeItem(at: legacyURL)
        }
    }

    private func fileURL(for key: String) -> URL {
        let digest = SHA256.hash(data: Data(key.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
        return directoryURL.appendingPathComponent("\(digest).json")
    }

    private func legacyFileURL(for key: String) -> URL {
        let safe = key.replacingOccurrences(of: "/", with: "_")
        return directoryURL.appendingPathComponent("\(safe).json")
    }
}
