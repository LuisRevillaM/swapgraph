import Foundation

public protocol MarketplaceProposalRepositoryProtocol: Sendable {
    func listProposals() async throws -> [CycleProposal]
    func getProposal(id: String) async throws -> CycleProposal
    func acceptProposal(id: String, occurredAt: String, idempotencyKey: String?) async throws -> CommitView
    func declineProposal(id: String, occurredAt: String, idempotencyKey: String?) async throws -> CommitView
}

public actor MarketplaceProposalRepository: MarketplaceProposalRepositoryProtocol {
    private let apiClient: MarketplaceAPIClient

    public init(apiClient: MarketplaceAPIClient) {
        self.apiClient = apiClient
    }

    public func listProposals() async throws -> [CycleProposal] {
        let response = try await apiClient.listProposals()
        return response.proposals
    }

    public func getProposal(id: String) async throws -> CycleProposal {
        let response = try await apiClient.getProposal(id: id)
        return response.proposal
    }

    public func acceptProposal(id: String, occurredAt: String, idempotencyKey: String?) async throws -> CommitView {
        let response = try await apiClient.acceptProposal(
            proposalID: id,
            occurredAt: occurredAt,
            idempotencyKey: idempotencyKey
        )
        return response.commit
    }

    public func declineProposal(id: String, occurredAt: String, idempotencyKey: String?) async throws -> CommitView {
        let response = try await apiClient.declineProposal(
            proposalID: id,
            occurredAt: occurredAt,
            idempotencyKey: idempotencyKey
        )
        return response.commit
    }
}

public struct StaticProposalRepositoryErrors: Sendable {
    public var list: MarketplaceClientError?
    public var get: MarketplaceClientError?
    public var accept: MarketplaceClientError?
    public var decline: MarketplaceClientError?

    public init(
        list: MarketplaceClientError? = nil,
        get: MarketplaceClientError? = nil,
        accept: MarketplaceClientError? = nil,
        decline: MarketplaceClientError? = nil
    ) {
        self.list = list
        self.get = get
        self.accept = accept
        self.decline = decline
    }
}

public actor StaticProposalRepository: MarketplaceProposalRepositoryProtocol {
    private var proposals: [CycleProposal]
    private let errors: StaticProposalRepositoryErrors

    public init(proposals: [CycleProposal], errors: StaticProposalRepositoryErrors = .init()) {
        self.proposals = proposals
        self.errors = errors
    }

    public func listProposals() async throws -> [CycleProposal] {
        if let error = errors.list { throw error }
        return proposals
    }

    public func getProposal(id: String) async throws -> CycleProposal {
        if let error = errors.get { throw error }
        guard let proposal = proposals.first(where: { $0.id == id }) else {
            throw MarketplaceClientError.notFound(
                MarketplaceAPIErrorEnvelope(
                    correlationID: "corr_\(id)",
                    error: MarketplaceAPIErrorBody(code: "NOT_FOUND", message: "proposal not found")
                )
            )
        }
        return proposal
    }

    public func acceptProposal(id: String, occurredAt: String, idempotencyKey: String?) async throws -> CommitView {
        if let error = errors.accept { throw error }
        return CommitView(id: "commit_accept_\(id)", cycleID: id, phase: "accept")
    }

    public func declineProposal(id: String, occurredAt: String, idempotencyKey: String?) async throws -> CommitView {
        if let error = errors.decline { throw error }
        return CommitView(id: "commit_decline_\(id)", cycleID: id, phase: "cancelled")
    }
}

public enum ProposalPreviewFixtures {
    public static func sampleProposals() -> [CycleProposal] {
        [
            CycleProposal(
                id: "cycle_001",
                expiresAt: "2026-02-24T10:00:00Z",
                participants: [
                    ProposalParticipant(
                        intentID: "intent_a",
                        actor: ActorRef(type: "user", id: "u1"),
                        give: [AssetRef(platform: "steam", appID: 730, contextID: 2, assetID: "m9_bayonet")],
                        get: [AssetRef(platform: "steam", appID: 730, contextID: 2, assetID: "ak_vulcan")]
                    ),
                    ProposalParticipant(
                        intentID: "intent_b",
                        actor: ActorRef(type: "user", id: "u2"),
                        give: [AssetRef(platform: "steam", appID: 730, contextID: 2, assetID: "ak_vulcan")],
                        get: [AssetRef(platform: "steam", appID: 730, contextID: 2, assetID: "m9_bayonet")]
                    )
                ],
                confidenceScore: 0.88,
                valueSpread: 0.06,
                explainability: [
                    "Constraint fit confirmed across both intents"
                ]
            ),
            CycleProposal(
                id: "cycle_002",
                expiresAt: "2026-02-25T10:00:00Z",
                participants: [
                    ProposalParticipant(
                        intentID: "intent_c",
                        actor: ActorRef(type: "user", id: "u1"),
                        give: [AssetRef(platform: "steam", appID: 730, contextID: 2, assetID: "karambit_doppler")],
                        get: [AssetRef(platform: "steam", appID: 730, contextID: 2, assetID: "awp_asiimov")]
                    ),
                    ProposalParticipant(
                        intentID: "intent_d",
                        actor: ActorRef(type: "user", id: "u4"),
                        give: [AssetRef(platform: "steam", appID: 730, contextID: 2, assetID: "awp_asiimov")],
                        get: [AssetRef(platform: "steam", appID: 730, contextID: 2, assetID: "karambit_doppler")]
                    )
                ],
                confidenceScore: 0.74,
                valueSpread: 0.11,
                explainability: [
                    "Counterparty constraints satisfy your tolerance band"
                ]
            )
        ]
    }
}
