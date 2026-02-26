import Foundation

public struct APIClientConfiguration: Sendable, Equatable {
    public var baseURL: URL
    public var actorType: String
    public var actorID: String
    public var authScopes: [String]
    public var bearerToken: String?
    public var retryConfiguration: RetryConfiguration

    public init(
        baseURL: URL,
        actorType: String,
        actorID: String,
        authScopes: [String] = [],
        bearerToken: String? = nil,
        retryConfiguration: RetryConfiguration = .default
    ) {
        self.baseURL = baseURL
        self.actorType = actorType
        self.actorID = actorID
        self.authScopes = authScopes
        self.bearerToken = bearerToken
        self.retryConfiguration = retryConfiguration
    }
}

public struct RetryConfiguration: Sendable, Equatable {
    public let maxAttempts: Int
    public let initialBackoffMilliseconds: UInt64
    public let retryableStatusCodes: Set<Int>

    public init(
        maxAttempts: Int,
        initialBackoffMilliseconds: UInt64,
        retryableStatusCodes: Set<Int>
    ) {
        self.maxAttempts = max(maxAttempts, 1)
        self.initialBackoffMilliseconds = max(initialBackoffMilliseconds, 0)
        self.retryableStatusCodes = retryableStatusCodes
    }

    public static let `default` = RetryConfiguration(
        maxAttempts: 3,
        initialBackoffMilliseconds: 120,
        retryableStatusCodes: [429, 500, 502, 503, 504]
    )
}

public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionHTTPTransport: HTTPTransport {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw MarketplaceClientError.badResponse
        }
        return (data, http)
    }
}

public protocol IdempotencyKeyProviding: Sendable {
    func key(for operation: String) async -> String
    func clear(operation: String) async
}

public actor IdempotencyKeyStore: IdempotencyKeyProviding {
    private var operationKeys: [String: String] = [:]

    public init() {}

    public func key(for operation: String) async -> String {
        if let existing = operationKeys[operation] {
            return existing
        }

        let key = UUID().uuidString.lowercased()
        operationKeys[operation] = key
        return key
    }

    public func clear(operation: String) async {
        operationKeys.removeValue(forKey: operation)
    }
}

public actor MarketplaceAPIClient {
    private let configuration: APIClientConfiguration
    private let transport: HTTPTransport
    private let idempotencyKeyProvider: IdempotencyKeyProviding
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    public init(
        configuration: APIClientConfiguration,
        transport: HTTPTransport = URLSessionHTTPTransport(),
        idempotencyKeyProvider: IdempotencyKeyProviding = IdempotencyKeyStore()
    ) {
        self.configuration = configuration
        self.transport = transport
        self.idempotencyKeyProvider = idempotencyKeyProvider
        self.decoder = JSONDecoder()
        self.encoder = JSONEncoder()
    }

    public func health() async throws -> HealthResponse {
        let request = try buildRequest(path: "/healthz", method: "GET")
        return try await execute(request)
    }

    public func listIntents() async throws -> SwapIntentListResponse {
        let request = try buildRequest(path: "/swap-intents", method: "GET")
        return try await execute(request)
    }

    public func getIntent(id: String) async throws -> SwapIntentUpsertResponse {
        let request = try buildRequest(path: "/swap-intents/\(id)", method: "GET")
        return try await execute(request)
    }

    public func inventoryAwakeningProjection(limit: Int? = nil) async throws -> InventoryAwakeningProjectionResponse {
        let queryItems: [URLQueryItem]
        if let limit {
            queryItems = [URLQueryItem(name: "limit", value: String(limit))]
        } else {
            queryItems = []
        }

        let request = try buildRequest(
            path: "/product-projections/inventory-awakening",
            method: "GET",
            queryItems: queryItems
        )
        return try await execute(request)
    }

    public func listProposals() async throws -> CycleProposalListResponse {
        let request = try buildRequest(path: "/cycle-proposals", method: "GET")
        return try await execute(request)
    }

    public func getProposal(id: String) async throws -> CycleProposalGetResponse {
        let request = try buildRequest(path: "/cycle-proposals/\(id)", method: "GET")
        return try await execute(request)
    }

    public func createIntent(
        intent: SwapIntent,
        idempotencyKey: String? = nil
    ) async throws -> SwapIntentUpsertResponse {
        let key = await resolveIdempotencyKey(
            operation: "swapIntents.create.\(intent.id)",
            provided: idempotencyKey
        )
        let body = try encoder.encode(["intent": intent])

        let request = try buildRequest(
            path: "/swap-intents",
            method: "POST",
            body: body,
            idempotencyKey: key
        )
        return try await execute(request)
    }

    public func updateIntent(
        intent: SwapIntent,
        idempotencyKey: String? = nil
    ) async throws -> SwapIntentUpsertResponse {
        let key = await resolveIdempotencyKey(
            operation: "swapIntents.update.\(intent.id)",
            provided: idempotencyKey
        )
        let body = try encoder.encode(["intent": intent])

        let request = try buildRequest(
            path: "/swap-intents/\(intent.id)",
            method: "PATCH",
            body: body,
            idempotencyKey: key
        )
        return try await execute(request)
    }

    public func cancelIntent(
        intentID: String,
        idempotencyKey: String? = nil
    ) async throws -> SwapIntentCancelResponse {
        let key = await resolveIdempotencyKey(
            operation: "swapIntents.cancel.\(intentID)",
            provided: idempotencyKey
        )
        let body = try encoder.encode(SwapIntentCancelRequest(id: intentID))

        let request = try buildRequest(
            path: "/swap-intents/\(intentID)/cancel",
            method: "POST",
            body: body,
            idempotencyKey: key
        )
        return try await execute(request)
    }

    public func confirmDeposit(
        cycleID: String,
        depositRef: String,
        idempotencyKey: String? = nil
    ) async throws -> SettlementDepositConfirmedResponse {
        let key = await resolveIdempotencyKey(
            operation: "settlement.confirmDeposit.\(cycleID).\(depositRef)",
            provided: idempotencyKey
        )
        let body = try encoder.encode([
            "deposit_ref": depositRef
        ])

        let request = try buildRequest(
            path: "/settlement/\(cycleID)/deposit-confirmed",
            method: "POST",
            body: body,
            idempotencyKey: key
        )
        return try await execute(request)
    }

    public func beginExecution(
        cycleID: String,
        idempotencyKey: String? = nil
    ) async throws -> SettlementBeginExecutionResponse {
        let key = await resolveIdempotencyKey(
            operation: "settlement.beginExecution.\(cycleID)",
            provided: idempotencyKey
        )

        let request = try buildRequest(
            path: "/settlement/\(cycleID)/begin-execution",
            method: "POST",
            body: Data("{}".utf8),
            idempotencyKey: key
        )
        return try await execute(request)
    }

    public func completeSettlement(
        cycleID: String,
        idempotencyKey: String? = nil
    ) async throws -> SettlementCompleteResponse {
        let key = await resolveIdempotencyKey(
            operation: "settlement.complete.\(cycleID)",
            provided: idempotencyKey
        )

        let request = try buildRequest(
            path: "/settlement/\(cycleID)/complete",
            method: "POST",
            body: Data("{}".utf8),
            idempotencyKey: key
        )
        return try await execute(request)
    }

    public func settlementStatus(cycleID: String) async throws -> SettlementStatusResponse {
        let request = try buildRequest(path: "/settlement/\(cycleID)/status", method: "GET")
        return try await execute(request)
    }

    public func receipt(cycleID: String) async throws -> ReceiptGetResponse {
        let request = try buildRequest(path: "/receipts/\(cycleID)", method: "GET")
        return try await execute(request)
    }

    public func receiptShareProjection(receiptID: String) async throws -> ReceiptShareProjectionResponse {
        let request = try buildRequest(
            path: "/product-projections/receipt-share/\(receiptID)",
            method: "GET"
        )
        return try await execute(request)
    }

    public func acceptProposal(
        proposalID: String,
        occurredAt: String,
        idempotencyKey: String? = nil
    ) async throws -> CommitAcceptResponse {
        let key = await resolveIdempotencyKey(
            operation: "cycleProposals.accept.\(proposalID)",
            provided: idempotencyKey
        )
        let payload = CommitAcceptRequest(proposalID: proposalID, occurredAt: occurredAt)
        let body = try encoder.encode(payload)

        let request = try buildRequest(
            path: "/cycle-proposals/\(proposalID)/accept",
            method: "POST",
            body: body,
            idempotencyKey: key
        )

        return try await execute(request)
    }

    public func declineProposal(
        proposalID: String,
        occurredAt: String,
        idempotencyKey: String? = nil
    ) async throws -> CommitDeclineResponse {
        let key = await resolveIdempotencyKey(
            operation: "cycleProposals.decline.\(proposalID)",
            provided: idempotencyKey
        )
        let payload = CommitDeclineRequest(proposalID: proposalID, occurredAt: occurredAt)
        let body = try encoder.encode(payload)

        let request = try buildRequest(
            path: "/cycle-proposals/\(proposalID)/decline",
            method: "POST",
            body: body,
            idempotencyKey: key
        )

        return try await execute(request)
    }

    private func buildRequest(
        path: String,
        method: String,
        queryItems: [URLQueryItem] = [],
        body: Data? = nil,
        idempotencyKey: String? = nil
    ) throws -> URLRequest {
        try validateActorContext()

        guard var components = URLComponents(
            url: configuration.baseURL.appending(path: path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))),
            resolvingAgainstBaseURL: true
        ) else {
            throw MarketplaceClientError.transport(description: "Unable to create URL components for path \(path)")
        }

        if !queryItems.isEmpty {
            components.queryItems = queryItems
        }

        guard let url = components.url else {
            throw MarketplaceClientError.transport(description: "Unable to create URL for path \(path)")
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.timeoutInterval = 15
        request.setValue(configuration.actorType, forHTTPHeaderField: "x-actor-type")
        request.setValue(configuration.actorID, forHTTPHeaderField: "x-actor-id")
        request.setValue(UUID().uuidString.lowercased(), forHTTPHeaderField: "x-correlation-id")

        if !configuration.authScopes.isEmpty {
            request.setValue(configuration.authScopes.joined(separator: ","), forHTTPHeaderField: "x-auth-scopes")
        }

        if let bearerToken = configuration.bearerToken {
            request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        }

        if let idempotencyKey {
            request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        }

        if body != nil {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        return request
    }

    private func validateActorContext() throws {
        let actorType = configuration.actorType.trimmingCharacters(in: .whitespacesAndNewlines)
        let actorID = configuration.actorID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !actorType.isEmpty, !actorID.isEmpty else {
            throw MarketplaceClientError.validation(
                MarketplaceAPIErrorEnvelope(
                    correlationID: "client.invalid_actor_context",
                    error: MarketplaceAPIErrorBody(
                        code: "INVALID_ACTOR_CONTEXT",
                        message: "actor_type and actor_id are required"
                    )
                )
            )
        }
    }

    private func resolveIdempotencyKey(operation: String, provided: String?) async -> String {
        if let provided {
            return provided
        }
        return await idempotencyKeyProvider.key(for: operation)
    }

    private func execute<Response: Decodable>(_ request: URLRequest) async throws -> Response {
        let retry = configuration.retryConfiguration
        var attempt = 1

        while true {
            do {
                let (data, response) = try await transport.send(request)
                if (200...299).contains(response.statusCode) {
                    do {
                        return try decoder.decode(Response.self, from: data)
                    } catch {
                        throw MarketplaceClientError.decoding(description: String(describing: error))
                    }
                }

                let envelope = try? decoder.decode(MarketplaceAPIErrorEnvelope.self, from: data)
                let mapped = mapError(statusCode: response.statusCode, envelope: envelope)

                if shouldRetry(error: mapped, statusCode: response.statusCode, attempt: attempt, retry: retry) {
                    try await backoffSleep(attempt: attempt, retry: retry)
                    attempt += 1
                    continue
                }

                throw mapped
            } catch let error as MarketplaceClientError {
                if shouldRetry(error: error, statusCode: nil, attempt: attempt, retry: retry) {
                    try await backoffSleep(attempt: attempt, retry: retry)
                    attempt += 1
                    continue
                }
                throw error
            } catch {
                let wrapped = MarketplaceClientError.transport(
                    description: SecurityLogRedactor.redact(String(describing: error))
                )
                if shouldRetry(error: wrapped, statusCode: nil, attempt: attempt, retry: retry) {
                    try await backoffSleep(attempt: attempt, retry: retry)
                    attempt += 1
                    continue
                }
                throw wrapped
            }
        }
    }

    private func mapError(statusCode: Int, envelope: MarketplaceAPIErrorEnvelope?) -> MarketplaceClientError {
        guard let envelope else {
            return .server(statusCode: statusCode, envelope: nil)
        }

        switch statusCode {
        case 401:
            return .unauthorized(envelope)
        case 403:
            return .forbidden(envelope)
        case 404:
            return .notFound(envelope)
        case 409:
            return .conflict(envelope)
        case 400, 422:
            return .validation(envelope)
        default:
            return .server(statusCode: statusCode, envelope: envelope)
        }
    }

    private func shouldRetry(
        error: MarketplaceClientError,
        statusCode: Int?,
        attempt: Int,
        retry: RetryConfiguration
    ) -> Bool {
        guard attempt < retry.maxAttempts else {
            return false
        }

        if let statusCode, retry.retryableStatusCodes.contains(statusCode) {
            return true
        }

        return error.isRetryable
    }

    private func backoffSleep(attempt: Int, retry: RetryConfiguration) async throws {
        guard retry.initialBackoffMilliseconds > 0 else { return }
        let multiplier = UInt64(max(1, attempt))
        let milliseconds = retry.initialBackoffMilliseconds * multiplier
        try await Task.sleep(nanoseconds: milliseconds * 1_000_000)
    }
}
