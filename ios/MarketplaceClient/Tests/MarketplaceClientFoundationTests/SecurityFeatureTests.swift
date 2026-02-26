import Foundation
import XCTest
@testable import MarketplaceClientFoundation

final class SecurityHardeningTests: XCTestCase {
    func testFileCacheStoreUsesOpaqueFileNamesForSensitiveKeys() throws {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("marketplace-secure-cache-\(UUID().uuidString)")
        let store = try FileCacheStore(directoryURL: directory)

        try store.write(
            ["status": "ok"],
            key: "session/token/private/user_123",
            ttlSeconds: 60,
            nowEpochSeconds: 100
        )

        let files = try FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil
        )

        XCTAssertEqual(files.count, 1)
        let filename = files[0].lastPathComponent
        XCTAssertFalse(filename.contains("session"))
        XCTAssertFalse(filename.contains("token"))
        XCTAssertEqual(filename.count, 69) // 64 hex chars + ".json"
    }

    func testFileCacheStoreMigratesLegacyCacheFileName() throws {
        struct Value: Codable, Sendable, Equatable {
            let state: String
        }

        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("marketplace-secure-cache-migrate-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let key = "legacy/cache/key"
        let legacyFilename = key.replacingOccurrences(of: "/", with: "_") + ".json"
        let legacyURL = directory.appendingPathComponent(legacyFilename)

        let legacyPayload = CacheEnvelope(storedAtEpochSeconds: 100, ttlSeconds: 300, value: Value(state: "ok"))
        let data = try JSONEncoder().encode(legacyPayload)
        try data.write(to: legacyURL, options: [.atomic])

        let store = try FileCacheStore(directoryURL: directory)
        let hydrated = try store.read(Value.self, key: key, nowEpochSeconds: 120)
        XCTAssertEqual(hydrated, Value(state: "ok"))

        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        XCTAssertEqual(files.count, 1)
        XCTAssertFalse(files[0].lastPathComponent.contains("legacy_cache_key"))
    }

    func testSecurityLogRedactorRemovesSensitiveValues() {
        let raw = """
        transport failure: Authorization=Bearer abc123456789 Idempotency-Key: idem_7788 x-correlation-id: corr_123
        """
        let redacted = SecurityLogRedactor.redact(raw)

        XCTAssertFalse(redacted.contains("abc123456789"))
        XCTAssertFalse(redacted.contains("idem_7788"))
        XCTAssertFalse(redacted.contains("corr_123"))
        XCTAssertTrue(redacted.contains("Bearer <redacted>"))
        XCTAssertTrue(redacted.contains("Idempotency-Key: <redacted>"))
        XCTAssertTrue(redacted.contains("x-correlation-id: <redacted>"))
    }

    func testAPIClientRejectsMissingActorContextBeforeNetworkSend() async {
        let transport = CountingTransport()
        let client = MarketplaceAPIClient(
            configuration: APIClientConfiguration(
                baseURL: URL(string: "http://localhost:3005")!,
                actorType: " ",
                actorID: ""
            ),
            transport: transport,
            idempotencyKeyProvider: IdempotencyKeyStore()
        )

        do {
            _ = try await client.health()
            XCTFail("Expected invalid actor context error")
        } catch let error as MarketplaceClientError {
            guard case let .validation(envelope) = error else {
                XCTFail("Expected validation error, got \(error)")
                return
            }
            XCTAssertEqual(envelope.error.code, "INVALID_ACTOR_CONTEXT")
        } catch {
            XCTFail("Expected MarketplaceClientError, got \(error)")
        }

        let count = await transport.sendCount
        XCTAssertEqual(count, 0)
    }
}

private actor CountingTransport: HTTPTransport {
    private(set) var sendCount = 0

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        _ = request
        sendCount += 1
        let response = HTTPURLResponse(
            url: URL(string: "http://localhost:3005/healthz")!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["content-type": "application/json"]
        )!
        return (Data("{\"ok\":true}".utf8), response)
    }
}
