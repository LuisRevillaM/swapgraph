import Foundation

@MainActor
public final class ProposalDetailViewModel: ObservableObject {
    @Published public private(set) var snapshot: ProposalDetailSnapshot?
    @Published public private(set) var fallbackState: FallbackState?
    @Published public private(set) var isLoading = false
    @Published public private(set) var isMutating = false
    @Published public private(set) var decisionState: ProposalDecisionState = .idle

    public let proposalID: String

    private let repository: MarketplaceProposalRepositoryProtocol
    private let analyticsClient: AnalyticsClient?
    private let actorID: String
    private let now: () -> Date

    private var cachedProposal: CycleProposal?
    private var acceptIdempotencyKey: String?
    private var declineIdempotencyKey: String?

    public init(
        proposalID: String,
        repository: MarketplaceProposalRepositoryProtocol,
        cachedProposal: CycleProposal? = nil,
        analyticsClient: AnalyticsClient? = nil,
        actorID: String = "u1",
        now: @escaping () -> Date = Date.init
    ) {
        self.proposalID = proposalID
        self.repository = repository
        self.cachedProposal = cachedProposal
        self.analyticsClient = analyticsClient
        self.actorID = actorID
        self.now = now

        if let cachedProposal {
            self.snapshot = Self.makeSnapshot(from: cachedProposal)
        }
    }

    public func refresh() async {
        isLoading = true
        defer { isLoading = false }

        do {
            let proposal = try await repository.getProposal(id: proposalID)
            cachedProposal = proposal
            snapshot = Self.makeSnapshot(from: proposal)
            fallbackState = nil

            await track(
                name: "marketplace.proposal.detail.viewed",
                payload: [
                    "actor_id": .string(actorID),
                    "proposal_id": .string(proposalID)
                ]
            )
        } catch let error as MarketplaceClientError {
            fallbackState = FallbackState.from(error: error)
        } catch {
            fallbackState = .failure(
                title: "Unable to load proposal",
                message: "Please retry in a moment."
            )
        }
    }

    @discardableResult
    public func acceptProposal() async -> Bool {
        guard !isMutating else { return false }

        isMutating = true
        decisionState = .accepting
        fallbackState = nil

        let key = acceptIdempotencyKey ?? UUID().uuidString.lowercased()
        acceptIdempotencyKey = key

        do {
            let commit = try await repository.acceptProposal(
                id: proposalID,
                occurredAt: ISO8601DateFormatter().string(from: now()),
                idempotencyKey: key
            )
            decisionState = .accepted(commitID: commit.id)

            await track(
                name: "marketplace.proposal.accepted",
                payload: [
                    "proposal_id": .string(proposalID),
                    "actor_id": .string(actorID),
                    "idempotency_key": .string(key)
                ]
            )

            isMutating = false
            return true
        } catch let error as MarketplaceClientError {
            decisionState = .failed(message: "Accept failed")
            fallbackState = FallbackState.from(error: error)
            isMutating = false
            return false
        } catch {
            decisionState = .failed(message: "Accept failed")
            fallbackState = .failure(
                title: "Accept failed",
                message: "Could not accept proposal."
            )
            isMutating = false
            return false
        }
    }

    @discardableResult
    public func declineProposal() async -> Bool {
        guard !isMutating else { return false }

        isMutating = true
        decisionState = .declining
        fallbackState = nil

        let key = declineIdempotencyKey ?? UUID().uuidString.lowercased()
        declineIdempotencyKey = key

        do {
            let commit = try await repository.declineProposal(
                id: proposalID,
                occurredAt: ISO8601DateFormatter().string(from: now()),
                idempotencyKey: key
            )
            decisionState = .declined(commitID: commit.id)

            await track(
                name: "marketplace.proposal.declined",
                payload: [
                    "proposal_id": .string(proposalID),
                    "actor_id": .string(actorID),
                    "idempotency_key": .string(key)
                ]
            )

            isMutating = false
            return true
        } catch let error as MarketplaceClientError {
            decisionState = .failed(message: "Decline failed")
            fallbackState = FallbackState.from(error: error)
            isMutating = false
            return false
        } catch {
            decisionState = .failed(message: "Decline failed")
            fallbackState = .failure(
                title: "Decline failed",
                message: "Could not decline proposal."
            )
            isMutating = false
            return false
        }
    }

    public static func preview() -> ProposalDetailViewModel {
        let proposal = ProposalPreviewFixtures.sampleProposals()[0]
        return ProposalDetailViewModel(
            proposalID: proposal.id,
            repository: StaticProposalRepository(proposals: ProposalPreviewFixtures.sampleProposals()),
            cachedProposal: proposal
        )
    }

    private static func makeSnapshot(from proposal: CycleProposal) -> ProposalDetailSnapshot {
        let firstParticipant = proposal.participants.first
        let giveTitle = displayName(for: firstParticipant?.give.first?.assetID ?? "unknown")
        let getTitle = displayName(for: firstParticipant?.get.first?.assetID ?? "unknown")

        let confidenceScore = proposal.confidenceScore ?? 0
        let confidenceText = "\(Int((confidenceScore * 100).rounded()))%"
        let spreadScore = proposal.valueSpread ?? 0
        let valueDeltaText = "\(Int((spreadScore * 100).rounded()))%"

        let participantNodes = proposal.participants.map { participant in
            ProposalParticipantNodeModel(
                id: participant.intentID,
                actorLabel: "@\(participant.actor.id)",
                givesLabel: displayName(for: participant.give.first?.assetID ?? "unknown"),
                getsLabel: displayName(for: participant.get.first?.assetID ?? "unknown")
            )
        }

        let explainabilityCards = explainabilityCards(for: proposal)
        let cycleTypeLabel = cycleType(for: proposal.participants.count)

        return ProposalDetailSnapshot(
            proposalID: proposal.id,
            cycleTypeLabel: cycleTypeLabel,
            giveTitle: giveTitle,
            getTitle: getTitle,
            confidenceText: confidenceText,
            valueDeltaText: valueDeltaText,
            participantNodes: participantNodes,
            explainabilityCards: explainabilityCards
        )
    }

    private static func explainabilityCards(for proposal: CycleProposal) -> [ProposalExplainabilityCardModel] {
        let confidenceValue = "\(Int(((proposal.confidenceScore ?? 0) * 100).rounded()))%"
        let valueDeltaValue = "\(Int(((proposal.valueSpread ?? 0) * 100).rounded()))%"
        let constraintText = proposal.explainability?.first
            ?? "Constraints satisfy the selected wear and value tolerance."

        return [
            ProposalExplainabilityCardModel(
                id: "value_delta",
                title: "Value delta",
                valueText: valueDeltaValue,
                descriptionText: "Projected spread for this cycle."
            ),
            ProposalExplainabilityCardModel(
                id: "confidence",
                title: "Confidence",
                valueText: confidenceValue,
                descriptionText: "Model confidence for this proposal."
            ),
            ProposalExplainabilityCardModel(
                id: "constraint_fit",
                title: "Constraint fit",
                valueText: "Matched",
                descriptionText: constraintText
            )
        ]
    }

    private static func cycleType(for participants: Int) -> String {
        switch participants {
        case ..<3:
            return "Direct"
        case 3:
            return "3-way"
        default:
            return "\(participants)-way"
        }
    }

    private static func displayName(for assetID: String) -> String {
        let normalized = assetID
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)

        guard !normalized.isEmpty else {
            return "Unknown item"
        }

        return normalized
            .split(separator: " ")
            .map { component in
                let value = String(component)
                if value.count <= 3 {
                    return value.uppercased()
                }
                return value.prefix(1).uppercased() + value.dropFirst().lowercased()
            }
            .joined(separator: " ")
    }

    private func track(name: String, payload: [String: JSONValue]) async {
        guard let analyticsClient else { return }

        let event = AnalyticsEvent(
            name: name,
            correlationID: UUID().uuidString.lowercased(),
            occurredAt: ISO8601DateFormatter().string(from: now()),
            payload: payload
        )
        try? await analyticsClient.track(event)
    }
}
