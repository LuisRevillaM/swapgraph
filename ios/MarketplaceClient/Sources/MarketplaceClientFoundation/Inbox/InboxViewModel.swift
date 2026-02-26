import Foundation

public struct ProposalDetailPresentation: Identifiable {
    public let id: String
    public let viewModel: ProposalDetailViewModel

    public init(id: String, viewModel: ProposalDetailViewModel) {
        self.id = id
        self.viewModel = viewModel
    }
}

@MainActor
public final class InboxViewModel: ObservableObject {
    @Published public private(set) var snapshot: ProposalInboxSnapshot?
    @Published public private(set) var fallbackState: FallbackState?
    @Published public private(set) var staleDataState: StaleDataState?
    @Published public private(set) var isLoading = false
    @Published public var detailPresentation: ProposalDetailPresentation?

    private var proposalsByID: [String: CycleProposal] = [:]
    private let repository: MarketplaceProposalRepositoryProtocol
    private let offlineStore: OfflineSnapshotStore<[CycleProposal]>?
    private let analyticsClient: AnalyticsClient?
    private let actorID: String
    private let now: () -> Date

    public init(
        repository: MarketplaceProposalRepositoryProtocol,
        offlineStore: OfflineSnapshotStore<[CycleProposal]>? = nil,
        analyticsClient: AnalyticsClient? = nil,
        actorID: String = "u1",
        now: @escaping () -> Date = Date.init
    ) {
        self.repository = repository
        self.offlineStore = offlineStore
        self.analyticsClient = analyticsClient
        self.actorID = actorID
        self.now = now
    }

    public func refresh() async {
        isLoading = true
        defer { isLoading = false }

        do {
            let proposals = try await repository.listProposals()
            proposalsByID = Dictionary(uniqueKeysWithValues: proposals.map { ($0.id, $0) })
            snapshot = Self.makeSnapshot(proposals: proposals, now: now())
            fallbackState = nil
            staleDataState = nil
            try? offlineStore?.save(proposals, nowEpochSeconds: nowEpochSeconds())

            await track(
                name: "marketplace.inbox.viewed",
                payload: [
                    "actor_id": .string(actorID),
                    "proposal_count": .number(Double(proposals.count))
                ]
            )
        } catch let error as MarketplaceClientError {
            if restoreOfflineSnapshot() {
                fallbackState = nil
                return
            }
            fallbackState = FallbackState.from(error: error)
            staleDataState = nil
        } catch {
            if restoreOfflineSnapshot() {
                fallbackState = nil
                return
            }
            fallbackState = .failure(
                title: "Unable to load inbox",
                message: "Please retry in a moment."
            )
            staleDataState = nil
        }
    }

    public func openIfNeeded(proposalID: String?) async {
        guard let proposalID else { return }
        guard detailPresentation?.id != proposalID else { return }
        await openProposal(id: proposalID)
    }

    public func openProposal(id: String) async {
        let cached = proposalsByID[id]
        let detailViewModel = ProposalDetailViewModel(
            proposalID: id,
            repository: repository,
            cachedProposal: cached,
            analyticsClient: analyticsClient,
            actorID: actorID,
            now: now
        )
        var payload: [String: JSONValue] = [
            "proposal_id": .string(id),
            "actor_id": .string(actorID)
        ]
        if let confidence = cached?.confidenceScore {
            payload["confidence_score"] = .number(confidence)
        }

        await track(name: "marketplace.proposal.opened", payload: payload)
        await detailViewModel.refresh()
        detailPresentation = ProposalDetailPresentation(id: id, viewModel: detailViewModel)
    }

    public func closeDetail() {
        detailPresentation = nil
    }

    public static func preview() -> InboxViewModel {
        let repository = StaticProposalRepository(proposals: ProposalPreviewFixtures.sampleProposals())
        let viewModel = InboxViewModel(repository: repository)
        viewModel.snapshot = Self.makeSnapshot(
            proposals: ProposalPreviewFixtures.sampleProposals(),
            now: Date()
        )
        return viewModel
    }

    private static func makeSnapshot(proposals: [CycleProposal], now: Date) -> ProposalInboxSnapshot {
        let rows = proposals.enumerated().map { index, proposal in
            makeRow(proposal: proposal, apiOrderIndex: index, now: now)
        }
        .sorted { lhs, rhs in
            let lhsPriority = rankPriority(for: lhs.urgencyBand)
            let rhsPriority = rankPriority(for: rhs.urgencyBand)
            if lhsPriority != rhsPriority {
                return lhsPriority < rhsPriority
            }
            return lhs.apiOrderIndex < rhs.apiOrderIndex
        }

        let sections: [ProposalInboxSectionModel] = ProposalUrgencyBand
            .allCases
            .compactMap { band in
                let bandRows = rows.filter { $0.urgencyBand == band }
                guard !bandRows.isEmpty else { return nil }
                return ProposalInboxSectionModel(
                    id: band.rawValue,
                    title: band.title,
                    rows: bandRows
                )
            }

        return ProposalInboxSnapshot(sections: sections)
    }

    private static func makeRow(proposal: CycleProposal, apiOrderIndex: Int, now: Date) -> ProposalInboxRowModel {
        let firstParticipant = proposal.participants.first
        let confidence = proposal.confidenceScore ?? 0
        let spread = proposal.valueSpread ?? 0

        let expirationDate = proposal.expiresAt.flatMap(Self.parseDate)
        let urgencyBand: ProposalUrgencyBand
        let statusCue: String

        if let expirationDate {
            let remaining = expirationDate.timeIntervalSince(now)
            if remaining <= 60 * 60 {
                urgencyBand = .actNow
                statusCue = "Expires in \(max(1, Int(remaining / 60)))m"
            } else if confidence >= 0.8 {
                urgencyBand = .highConfidence
                statusCue = "Confidence \(Int((confidence * 100).rounded()))%"
            } else {
                urgencyBand = .standard
                statusCue = "Cycle ready"
            }
        } else if confidence >= 0.8 {
            urgencyBand = .highConfidence
            statusCue = "Confidence \(Int((confidence * 100).rounded()))%"
        } else {
            urgencyBand = .standard
            statusCue = "Cycle ready"
        }

        return ProposalInboxRowModel(
            id: proposal.id,
            giveLabel: displayName(for: firstParticipant?.give.first?.assetID ?? "unknown"),
            getLabel: displayName(for: firstParticipant?.get.first?.assetID ?? "unknown"),
            confidenceScore: confidence,
            valueSpread: spread,
            participantCount: proposal.participants.count,
            statusCue: statusCue,
            urgencyBand: urgencyBand,
            apiOrderIndex: apiOrderIndex
        )
    }

    private static func rankPriority(for band: ProposalUrgencyBand) -> Int {
        switch band {
        case .actNow:
            return 0
        case .highConfidence:
            return 1
        case .standard:
            return 2
        }
    }

    private static func parseDate(_ iso8601: String) -> Date? {
        ISO8601DateFormatter().date(from: iso8601)
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

    @discardableResult
    private func restoreOfflineSnapshot() -> Bool {
        guard let cached = try? offlineStore?.load(nowEpochSeconds: nowEpochSeconds()) else {
            return false
        }

        let proposals = cached.value
        proposalsByID = Dictionary(uniqueKeysWithValues: proposals.map { ($0.id, $0) })
        snapshot = Self.makeSnapshot(proposals: proposals, now: now())
        staleDataState = .cachedFallback(cachedAtEpochSeconds: cached.cachedAtEpochSeconds)
        return true
    }

    private func nowEpochSeconds() -> Int {
        Int(now().timeIntervalSince1970)
    }
}

private extension ProposalUrgencyBand {
    static let allCases: [ProposalUrgencyBand] = [.actNow, .highConfidence, .standard]
}
