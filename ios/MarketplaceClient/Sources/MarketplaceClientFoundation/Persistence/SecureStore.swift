import Foundation

public protocol SecureStore: Sendable {
    func set(_ data: Data, for key: String) throws
    func data(for key: String) throws -> Data?
    func delete(_ key: String) throws
}

public final class InMemorySecureStore: SecureStore, @unchecked Sendable {
    private var storage: [String: Data] = [:]
    private let lock = NSLock()

    public init() {}

    public func set(_ data: Data, for key: String) throws {
        lock.lock()
        defer { lock.unlock() }
        storage[key] = data
    }

    public func data(for key: String) throws -> Data? {
        lock.lock()
        defer { lock.unlock() }
        return storage[key]
    }

    public func delete(_ key: String) throws {
        lock.lock()
        defer { lock.unlock() }
        storage.removeValue(forKey: key)
    }
}
