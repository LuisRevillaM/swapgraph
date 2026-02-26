import Foundation

public protocol MarketplaceIntentsRepositoryProtocol: Sendable {
    func listIntents() async throws -> [SwapIntent]
    func listProposals() async throws -> [CycleProposal]
    func createIntent(_ intent: SwapIntent, idempotencyKey: String?) async throws -> SwapIntent
    func updateIntent(_ intent: SwapIntent, idempotencyKey: String?) async throws -> SwapIntent
    func cancelIntent(id: String, idempotencyKey: String?) async throws -> SwapIntentCancelResponse
}

public actor MarketplaceIntentsRepository: MarketplaceIntentsRepositoryProtocol {
    private let apiClient: MarketplaceAPIClient

    public init(apiClient: MarketplaceAPIClient) {
        self.apiClient = apiClient
    }

    public func listIntents() async throws -> [SwapIntent] {
        let response = try await apiClient.listIntents()
        return response.intents
    }

    public func listProposals() async throws -> [CycleProposal] {
        let response = try await apiClient.listProposals()
        return response.proposals
    }

    public func createIntent(_ intent: SwapIntent, idempotencyKey: String?) async throws -> SwapIntent {
        let response = try await apiClient.createIntent(intent: intent, idempotencyKey: idempotencyKey)
        return response.intent
    }

    public func updateIntent(_ intent: SwapIntent, idempotencyKey: String?) async throws -> SwapIntent {
        let response = try await apiClient.updateIntent(intent: intent, idempotencyKey: idempotencyKey)
        return response.intent
    }

    public func cancelIntent(id: String, idempotencyKey: String?) async throws -> SwapIntentCancelResponse {
        try await apiClient.cancelIntent(intentID: id, idempotencyKey: idempotencyKey)
    }
}

public actor StaticIntentsRepository: MarketplaceIntentsRepositoryProtocol {
    private var intents: [SwapIntent]
    private let proposals: [CycleProposal]

    public init(intents: [SwapIntent], proposals: [CycleProposal] = []) {
        self.intents = intents
        self.proposals = proposals
    }

    public func listIntents() async throws -> [SwapIntent] {
        intents
    }

    public func listProposals() async throws -> [CycleProposal] {
        proposals
    }

    public func createIntent(_ intent: SwapIntent, idempotencyKey: String?) async throws -> SwapIntent {
        intents.append(intent)
        return intent
    }

    public func updateIntent(_ intent: SwapIntent, idempotencyKey: String?) async throws -> SwapIntent {
        if let index = intents.firstIndex(where: { $0.id == intent.id }) {
            intents[index] = intent
        }
        return intent
    }

    public func cancelIntent(id: String, idempotencyKey: String?) async throws -> SwapIntentCancelResponse {
        if let index = intents.firstIndex(where: { $0.id == id }) {
            let previous = intents[index]
            intents[index] = SwapIntent(
                id: previous.id,
                actor: previous.actor,
                offer: previous.offer,
                wantSpec: previous.wantSpec,
                valueBand: previous.valueBand,
                trustConstraints: previous.trustConstraints,
                timeConstraints: previous.timeConstraints,
                settlementPreferences: previous.settlementPreferences,
                status: "cancelled"
            )
        }

        return SwapIntentCancelResponse(
            correlationID: "corr_\(id)",
            id: id,
            status: "cancelled"
        )
    }
}
