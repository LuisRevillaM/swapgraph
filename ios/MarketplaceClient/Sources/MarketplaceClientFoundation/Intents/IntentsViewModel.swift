import Foundation

public struct IntentsOfflineSnapshot: Codable, Sendable {
    public let intents: [SwapIntent]
    public let nearMatchesByIntentID: [String: Int]

    enum CodingKeys: String, CodingKey {
        case intents
        case nearMatchesByIntentID = "near_matches_by_intent_id"
    }

    public init(intents: [SwapIntent], nearMatchesByIntentID: [String: Int]) {
        self.intents = intents
        self.nearMatchesByIntentID = nearMatchesByIntentID
    }
}

@MainActor
public final class IntentsViewModel: ObservableObject {
    @Published public private(set) var rows: [IntentRowModel] = []
    @Published public private(set) var fallbackState: FallbackState?
    @Published public private(set) var staleDataState: StaleDataState?
    @Published public private(set) var isLoading = false
    @Published public var isComposerPresented = false
    @Published public var composerDraft = IntentComposerDraft()
    @Published public private(set) var composerIssues: [IntentComposerValidationIssue] = []
    @Published public private(set) var editingIntentID: String?
    @Published public private(set) var journeyTraces: [IntentJourneyTrace] = []
    @Published public private(set) var firstIntentDurationsSeconds: [Double] = []

    private var intentsByID: [String: SwapIntent] = [:]
    private var nearMatchCountByIntentID: [String: Int] = [:]
    private var mutationPhaseByIntentID: [String: IntentMutationPhase] = [:]

    private let repository: MarketplaceIntentsRepositoryProtocol
    private let watchSnapshotStore: IntentWatchSnapshotStoreProtocol
    private let offlineStore: OfflineSnapshotStore<IntentsOfflineSnapshot>?
    private let analyticsClient: AnalyticsClient?
    private let actorID: String
    private let now: () -> Date

    private var activeJourneySessionID: String?
    private var activeJourneyStartedAt: Date?
    private var activeJourneyEvents: [IntentJourneyEvent] = []

    public init(
        repository: MarketplaceIntentsRepositoryProtocol,
        watchSnapshotStore: IntentWatchSnapshotStoreProtocol,
        offlineStore: OfflineSnapshotStore<IntentsOfflineSnapshot>? = nil,
        analyticsClient: AnalyticsClient? = nil,
        actorID: String = "u1",
        now: @escaping () -> Date = Date.init
    ) {
        self.repository = repository
        self.watchSnapshotStore = watchSnapshotStore
        self.offlineStore = offlineStore
        self.analyticsClient = analyticsClient
        self.actorID = actorID
        self.now = now
    }

    public var medianFirstIntentSeconds: Double? {
        let sorted = firstIntentDurationsSeconds.sorted()
        guard !sorted.isEmpty else { return nil }
        let mid = sorted.count / 2
        if sorted.count % 2 == 1 {
            return sorted[mid]
        }
        return (sorted[mid - 1] + sorted[mid]) / 2.0
    }

    public func refresh() async {
        isLoading = true
        defer { isLoading = false }

        do {
            async let intentsTask = repository.listIntents()
            async let proposalsTask = repository.listProposals()

            let intents = try await intentsTask
            let proposals = try await proposalsTask

            intentsByID = Dictionary(uniqueKeysWithValues: intents.map { ($0.id, $0) })
            nearMatchCountByIntentID = Self.nearMatchCounts(proposals: proposals)

            if nearMatchCountByIntentID.isEmpty,
               let persisted = try watchSnapshotStore.load(nowEpochSeconds: nowEpochSeconds()) {
                nearMatchCountByIntentID = persisted.nearMatchesByIntentID
            }

            try watchSnapshotStore.save(
                IntentWatchSnapshot(nearMatchesByIntentID: nearMatchCountByIntentID),
                nowEpochSeconds: nowEpochSeconds()
            )

            buildRows()
            fallbackState = nil
            staleDataState = nil
            saveOfflineSnapshot()

            await track(
                name: "marketplace.intents.viewed",
                payload: [
                    "actor_id": .string(actorID),
                    "intent_count": .number(Double(rows.count))
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
                title: "Unable to load intents",
                message: "Please retry in a moment."
            )
            staleDataState = nil
        }
    }

    public func openComposer(prefilledAssetID: String? = nil) {
        editingIntentID = nil
        composerDraft = IntentComposerDraft()
        if let prefilledAssetID {
            composerDraft.offeringAssetID = prefilledAssetID
        }
        composerIssues = []
        isComposerPresented = true

        beginJourneySession()
        appendJourneyEvent(named: "intent_composer_opened")

        Task {
            await track(
                name: "marketplace.intent.composer.opened",
                payload: [
                    "actor_id": .string(actorID),
                    "prefilled_offering": .bool(prefilledAssetID != nil)
                ]
            )
        }
    }

    public func startEditing(intentID: String) {
        guard let intent = intentsByID[intentID] else { return }

        editingIntentID = intentID
        composerDraft = IntentComposerDraft.from(intent: intent)
        composerIssues = []
        isComposerPresented = true

        Task {
            await track(
                name: "marketplace.intent.edit.opened",
                payload: [
                    "actor_id": .string(actorID),
                    "intent_id": .string(intentID)
                ]
            )
        }
    }

    public func dismissComposer() {
        isComposerPresented = false
        composerIssues = []
        editingIntentID = nil
    }

    @discardableResult
    public func submitComposer() async -> Bool {
        let issues = IntentComposerValidator.validate(composerDraft)
        composerIssues = issues

        await track(
            name: "marketplace.intent.composer.validated",
            payload: [
                "actor_id": .string(actorID),
                "issue_count": .number(Double(issues.count)),
                "valid": .bool(issues.isEmpty)
            ]
        )

        guard issues.isEmpty else {
            return false
        }

        if let editingIntentID {
            return await updateIntent(intentID: editingIntentID)
        }

        return await createIntent()
    }

    @discardableResult
    public func cancelIntent(id: String) async -> Bool {
        guard let existing = intentsByID[id] else { return false }

        mutationPhaseByIntentID[id] = .cancelling

        let optimistic = SwapIntent(
            id: existing.id,
            actor: existing.actor,
            offer: existing.offer,
            wantSpec: existing.wantSpec,
            valueBand: existing.valueBand,
            trustConstraints: existing.trustConstraints,
            timeConstraints: existing.timeConstraints,
            settlementPreferences: existing.settlementPreferences,
            status: "cancelled"
        )

        intentsByID[id] = optimistic
        buildRows()

        do {
            _ = try await repository.cancelIntent(id: id, idempotencyKey: nil)
            mutationPhaseByIntentID[id] = .idle
            buildRows()
            staleDataState = nil
            saveOfflineSnapshot()

            await track(
                name: "marketplace.intent.cancelled",
                payload: [
                    "actor_id": .string(actorID),
                    "intent_id": .string(id)
                ]
            )

            return true
        } catch let error as MarketplaceClientError {
            intentsByID[id] = existing
            mutationPhaseByIntentID[id] = .failed
            fallbackState = FallbackState.from(error: error)
            staleDataState = nil
            buildRows()
            return false
        } catch {
            intentsByID[id] = existing
            mutationPhaseByIntentID[id] = .failed
            fallbackState = .failure(
                title: "Cancel failed",
                message: "Could not cancel intent."
            )
            staleDataState = nil
            buildRows()
            return false
        }
    }

    public static func preview() -> IntentsViewModel {
        let sampleIntent = IntentComposerDraft(
            offeringAssetID: "asset_a",
            wantQuery: "knife",
            acceptableWear: [.mw, .ft],
            valueTolerance: .usd50,
            cycleLength: .threeWay,
            urgency: "normal"
        ).makeSwapIntent(actorID: "u1", now: Date())

        let repository = StaticIntentsRepository(intents: [sampleIntent], proposals: [])
        let watchStore = InMemoryIntentWatchSnapshotStore(
            snapshot: IntentWatchSnapshot(nearMatchesByIntentID: [sampleIntent.id: 0])
        )

        let model = IntentsViewModel(
            repository: repository,
            watchSnapshotStore: watchStore,
            actorID: "u1"
        )
        model.intentsByID = [sampleIntent.id: sampleIntent]
        model.nearMatchCountByIntentID = [sampleIntent.id: 0]
        model.buildRows()
        return model
    }

    private func createIntent() async -> Bool {
        let timestamp = now()
        let optimistic = composerDraft.makeSwapIntent(actorID: actorID, now: timestamp)
        let intentID = optimistic.id

        mutationPhaseByIntentID[intentID] = .creating
        intentsByID[intentID] = optimistic
        nearMatchCountByIntentID[intentID] = 0
        buildRows()

        appendJourneyEvent(named: "intent_create_submitted")

        do {
            let created = try await repository.createIntent(optimistic, idempotencyKey: nil)
            intentsByID[intentID] = created
            mutationPhaseByIntentID[intentID] = .idle
            try watchSnapshotStore.save(
                IntentWatchSnapshot(nearMatchesByIntentID: nearMatchCountByIntentID),
                nowEpochSeconds: nowEpochSeconds()
            )
            buildRows()
            staleDataState = nil
            saveOfflineSnapshot()

            await track(
                name: "marketplace.intent.created",
                payload: [
                    "actor_id": .string(actorID),
                    "intent_id": .string(intentID)
                ]
            )

            appendJourneyEvent(named: "intent_create_succeeded")
            appendJourneyEvent(named: "intents_watching_visible")
            closeJourneyAsSuccess()

            isComposerPresented = false
            composerIssues = []
            return true
        } catch let error as MarketplaceClientError {
            intentsByID.removeValue(forKey: intentID)
            nearMatchCountByIntentID.removeValue(forKey: intentID)
            mutationPhaseByIntentID[intentID] = .failed
            fallbackState = FallbackState.from(error: error)
            staleDataState = nil
            buildRows()
            return false
        } catch {
            intentsByID.removeValue(forKey: intentID)
            nearMatchCountByIntentID.removeValue(forKey: intentID)
            mutationPhaseByIntentID[intentID] = .failed
            fallbackState = .failure(
                title: "Create failed",
                message: "Could not create intent."
            )
            staleDataState = nil
            buildRows()
            return false
        }
    }

    private func updateIntent(intentID: String) async -> Bool {
        guard let existing = intentsByID[intentID] else {
            return false
        }

        let updated = composerDraft.makeSwapIntent(actorID: actorID, now: now(), existingID: intentID)
        intentsByID[intentID] = updated
        mutationPhaseByIntentID[intentID] = .updating
        buildRows()

        do {
            let committed = try await repository.updateIntent(updated, idempotencyKey: nil)
            intentsByID[intentID] = committed
            mutationPhaseByIntentID[intentID] = .idle
            buildRows()
            staleDataState = nil
            saveOfflineSnapshot()

            await track(
                name: "marketplace.intent.updated",
                payload: [
                    "actor_id": .string(actorID),
                    "intent_id": .string(intentID)
                ]
            )

            isComposerPresented = false
            composerIssues = []
            editingIntentID = nil
            return true
        } catch let error as MarketplaceClientError {
            intentsByID[intentID] = existing
            mutationPhaseByIntentID[intentID] = .failed
            fallbackState = FallbackState.from(error: error)
            staleDataState = nil
            buildRows()
            return false
        } catch {
            intentsByID[intentID] = existing
            mutationPhaseByIntentID[intentID] = .failed
            fallbackState = .failure(
                title: "Update failed",
                message: "Could not update intent."
            )
            staleDataState = nil
            buildRows()
            return false
        }
    }

    private func buildRows() {
        rows = intentsByID.values
            .sorted { $0.id.localizedCaseInsensitiveCompare($1.id) == .orderedAscending }
            .map { intent in
                let intentID = intent.id
                let watchState: IntentWatchState

                if intent.status == "cancelled" {
                    watchState = .cancelled
                } else {
                    let nearMatches = nearMatchCountByIntentID[intentID, default: 0]
                    if nearMatches > 0 {
                        watchState = .matched(nearMatchCount: nearMatches)
                    } else {
                        watchState = .watchingNoMatches
                    }
                }

                return IntentRowModel(
                    id: intentID,
                    giveAssetID: intent.offer.first?.assetID ?? "unknown",
                    wantLabel: intent.wantSpec?.anyOf?.first?.category ?? "unspecified",
                    watchState: watchState,
                    cycleLength: intent.trustConstraints?.maxCycleLength ?? 3,
                    valueTolerance: Int(intent.valueBand?.maxUSD ?? 0),
                    mutationPhase: mutationPhaseByIntentID[intentID, default: .idle]
                )
            }
    }

    private static func nearMatchCounts(proposals: [CycleProposal]) -> [String: Int] {
        var counts: [String: Int] = [:]

        for proposal in proposals {
            for participant in proposal.participants {
                counts[participant.intentID, default: 0] += 1
            }
        }

        return counts
    }

    private func saveOfflineSnapshot() {
        let payload = IntentsOfflineSnapshot(
            intents: Array(intentsByID.values),
            nearMatchesByIntentID: nearMatchCountByIntentID
        )
        try? offlineStore?.save(payload, nowEpochSeconds: nowEpochSeconds())
    }

    @discardableResult
    private func restoreOfflineSnapshot() -> Bool {
        guard let cached = try? offlineStore?.load(nowEpochSeconds: nowEpochSeconds()) else {
            return false
        }

        intentsByID = Dictionary(uniqueKeysWithValues: cached.value.intents.map { ($0.id, $0) })
        nearMatchCountByIntentID = cached.value.nearMatchesByIntentID
        mutationPhaseByIntentID = [:]
        buildRows()
        staleDataState = .cachedFallback(cachedAtEpochSeconds: cached.cachedAtEpochSeconds)
        return true
    }

    private func beginJourneySession() {
        activeJourneySessionID = UUID().uuidString.lowercased()
        activeJourneyStartedAt = now()
        activeJourneyEvents = []
    }

    private func closeJourneyAsSuccess() {
        guard
            let sessionID = activeJourneySessionID,
            let startedAt = activeJourneyStartedAt
        else {
            return
        }

        let elapsed = now().timeIntervalSince(startedAt)
        firstIntentDurationsSeconds.append(elapsed)

        let trace = IntentJourneyTrace(
            sessionID: sessionID,
            elapsedSeconds: elapsed,
            events: activeJourneyEvents
        )

        journeyTraces.append(trace)
        activeJourneySessionID = nil
        activeJourneyStartedAt = nil
        activeJourneyEvents = []
    }

    private func appendJourneyEvent(named name: String) {
        guard activeJourneySessionID != nil else { return }
        let event = IntentJourneyEvent(
            name: name,
            timestampISO8601: ISO8601DateFormatter().string(from: now())
        )
        activeJourneyEvents.append(event)
    }

    private func nowEpochSeconds() -> Int {
        Int(now().timeIntervalSince1970)
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
