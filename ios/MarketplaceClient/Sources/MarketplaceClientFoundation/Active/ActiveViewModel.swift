import Foundation

@MainActor
public final class ActiveViewModel: ObservableObject {
    @Published public private(set) var snapshot: ActiveScreenSnapshot?
    @Published public private(set) var fallbackState: FallbackState?
    @Published public private(set) var staleDataState: StaleDataState?
    @Published public private(set) var isLoading = false
    @Published public private(set) var isMutating = false
    @Published public private(set) var activeCycleID: String?

    public let defaultCycleID: String?

    private let repository: MarketplaceActiveRepositoryProtocol
    private let offlineStore: OfflineSnapshotStore<[String: SettlementTimeline]>?
    private let analyticsClient: AnalyticsClient?
    private let actorType: String
    private let actorID: String
    private let now: () -> Date

    private var cachedTimeline: SettlementTimeline?
    private var cachedReceipt: SwapReceipt?
    private var confirmDepositIdempotencyKey: String?
    private var beginExecutionIdempotencyKey: String?
    private var completeSettlementIdempotencyKey: String?

    public init(
        repository: MarketplaceActiveRepositoryProtocol,
        offlineStore: OfflineSnapshotStore<[String: SettlementTimeline]>? = nil,
        analyticsClient: AnalyticsClient? = nil,
        actorType: String = "user",
        actorID: String = "u1",
        defaultCycleID: String? = nil,
        now: @escaping () -> Date = Date.init
    ) {
        self.repository = repository
        self.offlineStore = offlineStore
        self.analyticsClient = analyticsClient
        self.actorType = actorType
        self.actorID = actorID
        self.defaultCycleID = defaultCycleID
        self.now = now
        self.activeCycleID = defaultCycleID
    }

    public func openCycle(cycleID: String?) async {
        activeCycleID = cycleID ?? defaultCycleID
        await refresh()
    }

    public func refresh() async {
        guard let cycleID = activeCycleID else {
            cachedTimeline = nil
            cachedReceipt = nil
            snapshot = nil
            staleDataState = nil
            fallbackState = .empty(
                title: "No active swap selected",
                message: "Open an active cycle to track settlement progress."
            )
            return
        }

        isLoading = true
        defer { isLoading = false }

        do {
            let timeline = try await repository.settlementStatus(cycleID: cycleID)
            cachedTimeline = timeline
            snapshot = Self.makeSnapshot(
                timeline: timeline,
                actorType: actorType,
                actorID: actorID
            )
            fallbackState = nil
            staleDataState = nil
            saveCachedTimeline(timeline)

            await track(
                name: "marketplace.timeline.viewed",
                payload: [
                    "cycle_id": .string(cycleID),
                    "actor_id": .string(actorID),
                    "state": .string(timeline.state)
                ]
            )
        } catch let error as MarketplaceClientError {
            if restoreCachedTimeline(cycleID: cycleID) {
                fallbackState = nil
                return
            }
            fallbackState = FallbackState.from(error: error)
            staleDataState = nil
        } catch {
            if restoreCachedTimeline(cycleID: cycleID) {
                fallbackState = nil
                return
            }
            fallbackState = .failure(
                title: "Unable to load active swap",
                message: "Please retry in a moment."
            )
            staleDataState = nil
        }
    }

    @discardableResult
    public func performPrimaryAction() async -> Bool {
        guard let currentSnapshot = snapshot, let action = currentSnapshot.primaryAction else {
            fallbackState = .blocked(
                title: "Action unavailable",
                message: "No action is available for this state."
            )
            return false
        }

        guard action.isEnabled else {
            let reason = action.disabledReason ?? "This action is currently blocked."
            fallbackState = .blocked(title: "Action unavailable", message: reason)
            await trackBlockedAction(action: action.kind, reason: reason)
            return false
        }

        guard let cycleID = activeCycleID else { return false }

        isMutating = true
        defer { isMutating = false }

        do {
            switch action.kind {
            case .confirmDeposit:
                guard let timeline = cachedTimeline,
                      let leg = Self.pendingLegForActor(timeline: timeline, actorID: actorID)
                else {
                    let reason = "Your deposit is already confirmed or no pending leg exists."
                    fallbackState = .blocked(title: "Action unavailable", message: reason)
                    await trackBlockedAction(action: .confirmDeposit, reason: reason)
                    return false
                }

                let idempotencyKey = confirmDepositIdempotencyKey ?? UUID().uuidString.lowercased()
                confirmDepositIdempotencyKey = idempotencyKey
                let depositRef = "dep_\(cycleID)_\(leg.intentID)"
                let updated = try await repository.confirmDeposit(
                    cycleID: cycleID,
                    legID: leg.legID,
                    depositRef: depositRef,
                    idempotencyKey: idempotencyKey
                )
                cachedTimeline = updated
                snapshot = Self.makeSnapshot(timeline: updated, actorType: actorType, actorID: actorID)
                fallbackState = nil
                staleDataState = nil
                saveCachedTimeline(updated)

                await track(
                    name: "marketplace.timeline.deposit_confirmed",
                    payload: [
                        "cycle_id": .string(cycleID),
                        "actor_id": .string(actorID),
                        "leg_id": .string(leg.legID)
                    ]
                )
                return true
            case .beginExecution:
                let idempotencyKey = beginExecutionIdempotencyKey ?? UUID().uuidString.lowercased()
                beginExecutionIdempotencyKey = idempotencyKey
                let updated = try await repository.beginExecution(
                    cycleID: cycleID,
                    idempotencyKey: idempotencyKey
                )
                cachedTimeline = updated
                snapshot = Self.makeSnapshot(timeline: updated, actorType: actorType, actorID: actorID)
                fallbackState = nil
                staleDataState = nil
                saveCachedTimeline(updated)
                return true
            case .completeSettlement:
                let idempotencyKey = completeSettlementIdempotencyKey ?? UUID().uuidString.lowercased()
                completeSettlementIdempotencyKey = idempotencyKey
                let result = try await repository.completeSettlement(
                    cycleID: cycleID,
                    idempotencyKey: idempotencyKey
                )
                cachedTimeline = result.timeline
                cachedReceipt = result.receipt
                snapshot = Self.makeSnapshot(timeline: result.timeline, actorType: actorType, actorID: actorID)
                fallbackState = nil
                staleDataState = nil
                saveCachedTimeline(result.timeline)
                return true
            case .openReceipt:
                do {
                    cachedReceipt = try await repository.receipt(cycleID: cycleID)
                } catch {
                    // Receipt fetch is best-effort here; navigation still uses cycle id.
                }
                return true
            }
        } catch let error as MarketplaceClientError {
            fallbackState = Self.fallbackStateForActionError(error)
            staleDataState = nil
            return false
        } catch {
            fallbackState = .failure(
                title: "Action failed",
                message: "Please retry in a moment."
            )
            staleDataState = nil
            return false
        }
    }

    public static func preview() -> ActiveViewModel {
        let timeline = ActivePreviewFixtures.sampleTimeline()
        let repository = StaticActiveRepository(
            timelines: [timeline],
            receipts: [ActivePreviewFixtures.sampleReceipt(cycleID: timeline.cycleID)]
        )

        let model = ActiveViewModel(
            repository: repository,
            actorType: "user",
            actorID: "u1",
            defaultCycleID: timeline.cycleID
        )
        model.cachedTimeline = timeline
        model.snapshot = makeSnapshot(timeline: timeline, actorType: "user", actorID: "u1")
        return model
    }

    private static func makeSnapshot(
        timeline: SettlementTimeline,
        actorType: String,
        actorID: String
    ) -> ActiveScreenSnapshot {
        let state = ActiveSettlementState(rawState: timeline.state)
        let waitReason = waitReason(timeline: timeline, state: state, actorType: actorType, actorID: actorID)
        let header = headerModel(timeline: timeline, state: state, actorID: actorID, waitReason: waitReason)
        let primaryAction = primaryAction(
            timeline: timeline,
            state: state,
            actorType: actorType,
            actorID: actorID,
            waitReason: waitReason
        )
        let timelineEvents = buildTimelineEvents(timeline: timeline, state: state)

        return ActiveScreenSnapshot(
            cycleID: timeline.cycleID,
            state: state,
            header: header,
            waitReason: waitReason,
            timelineEvents: timelineEvents,
            primaryAction: primaryAction
        )
    }

    private static func waitReason(
        timeline: SettlementTimeline,
        state: ActiveSettlementState,
        actorType: String,
        actorID: String
    ) -> String? {
        switch state {
        case .proposed:
            return "Waiting for every participant to accept before settlement can begin."
        case .accepted:
            return "Waiting for partner to start escrow and publish deposit instructions."
        case .escrowPending:
            if pendingLegForActor(timeline: timeline, actorID: actorID) != nil {
                return nil
            }
            if let nextPending = timeline.legs.first(where: { $0.status == "pending" }) {
                return "Awaiting @\(nextPending.fromActor.id)'s deposit before \(timestampLabel(nextPending.depositDeadlineAt))."
            }
            return "Waiting for pending deposits to be confirmed."
        case .escrowReady:
            if actorType == "partner" {
                return nil
            }
            return "All deposits are confirmed. Waiting for partner to begin execution."
        case .executing:
            if actorType == "partner" {
                return nil
            }
            return "Settlement is executing. Waiting for partner completion."
        case .completed:
            return nil
        case .failed:
            let refundedCount = timeline.legs.filter { $0.status == "refunded" }.count
            if refundedCount > 0 {
                return "Deposit window expired. Refunded legs are listed below."
            }
            return "Settlement failed. Review timeline details for outcome."
        }
    }

    private static func headerModel(
        timeline: SettlementTimeline,
        state: ActiveSettlementState,
        actorID: String,
        waitReason: String?
    ) -> ActiveProgressHeaderModel {
        let actorPendingLeg = pendingLegForActor(timeline: timeline, actorID: actorID)

        let headline: String
        let detail: String

        switch state {
        case .escrowPending where actorPendingLeg != nil:
            headline = "Your deposit is required"
            detail = "Confirm deposit before \(timestampLabel(actorPendingLeg?.depositDeadlineAt))."
        case .escrowPending:
            if let nextPending = timeline.legs.first(where: { $0.status == "pending" }) {
                headline = "Awaiting @\(nextPending.fromActor.id)'s deposit"
                detail = "Deadline \(timestampLabel(nextPending.depositDeadlineAt))."
            } else {
                headline = "Awaiting deposit confirmations"
                detail = waitReason ?? "Pending updates from counterparties."
            }
        case .escrowReady:
            headline = "Escrow confirmed"
            detail = waitReason ?? "Ready for execution."
        case .executing:
            headline = "Settlement executing"
            detail = waitReason ?? "Assets are being released."
        case .completed:
            headline = "Receipt issued"
            detail = "Settlement completed successfully."
        case .failed:
            headline = "Settlement failed"
            detail = waitReason ?? "Cycle ended with a failure outcome."
        case .accepted:
            headline = "Cycle accepted"
            detail = waitReason ?? "Settlement start pending."
        case .proposed:
            headline = "Proposal in progress"
            detail = waitReason ?? "Awaiting participant acceptance."
        }

        return ActiveProgressHeaderModel(
            cycleID: timeline.cycleID,
            stateLabel: state.stateLabel,
            headline: headline,
            detail: detail,
            completedSteps: state.progressStep,
            totalSteps: 5
        )
    }

    private static func primaryAction(
        timeline: SettlementTimeline,
        state: ActiveSettlementState,
        actorType: String,
        actorID: String,
        waitReason: String?
    ) -> ActiveActionModel? {
        switch state {
        case .escrowPending:
            let actorPending = pendingLegForActor(timeline: timeline, actorID: actorID)
            if actorPending != nil {
                return ActiveActionModel(
                    kind: .confirmDeposit,
                    title: "Confirm deposit",
                    subtitle: "Marks your leg as deposited.",
                    isEnabled: true
                )
            }

            let reason = waitReason ?? "Waiting for another participant deposit."
            return ActiveActionModel(
                kind: .confirmDeposit,
                title: "Confirm deposit",
                subtitle: "Deposit confirmation is locked for this state.",
                isEnabled: false,
                disabledReason: reason
            )
        case .escrowReady:
            if actorType == "partner" {
                return ActiveActionModel(
                    kind: .beginExecution,
                    title: "Begin execution",
                    subtitle: "Moves cycle from escrow to execution.",
                    isEnabled: true
                )
            }
            return ActiveActionModel(
                kind: .beginExecution,
                title: "Begin execution",
                subtitle: "Partner action required.",
                isEnabled: false,
                disabledReason: waitReason ?? "Only partner accounts can begin execution."
            )
        case .executing:
            if actorType == "partner" {
                return ActiveActionModel(
                    kind: .completeSettlement,
                    title: "Complete settlement",
                    subtitle: "Finalize release and issue receipt.",
                    isEnabled: true
                )
            }
            return ActiveActionModel(
                kind: .completeSettlement,
                title: "Complete settlement",
                subtitle: "Partner action required.",
                isEnabled: false,
                disabledReason: waitReason ?? "Only partner accounts can complete settlement."
            )
        case .completed, .failed:
            return ActiveActionModel(
                kind: .openReceipt,
                title: "Open receipt",
                subtitle: state == .completed ? "Review completion details." : "Review failure details.",
                isEnabled: true
            )
        case .proposed, .accepted:
            return nil
        }
    }

    private static func buildTimelineEvents(
        timeline: SettlementTimeline,
        state: ActiveSettlementState
    ) -> [ActiveTimelineEventModel] {
        let currentStep = state.progressStep
        let stepEvents: [ActiveTimelineEventModel] = [
            ActiveTimelineEventModel(
                id: "step.accepted",
                title: "Cycle accepted",
                description: "Participants committed to this cycle.",
                timestampLabel: timestampLabel(currentStep >= 1 ? timeline.updatedAt : nil),
                timestampISO8601: currentStep >= 1 ? timeline.updatedAt : nil,
                marker: marker(step: 1, currentStep: currentStep)
            ),
            ActiveTimelineEventModel(
                id: "step.escrow_pending",
                title: "Escrow pending",
                description: "Deposit confirmations are in progress.",
                timestampLabel: timestampLabel(currentStep >= 2 ? timeline.updatedAt : nil),
                timestampISO8601: currentStep >= 2 ? timeline.updatedAt : nil,
                marker: marker(step: 2, currentStep: currentStep)
            ),
            ActiveTimelineEventModel(
                id: "step.escrow_ready",
                title: "Escrow ready",
                description: "All required deposits confirmed.",
                timestampLabel: timestampLabel(currentStep >= 3 ? timeline.updatedAt : nil),
                timestampISO8601: currentStep >= 3 ? timeline.updatedAt : nil,
                marker: marker(step: 3, currentStep: currentStep)
            ),
            ActiveTimelineEventModel(
                id: "step.executing",
                title: "Execution started",
                description: "Settlement release is now running.",
                timestampLabel: timestampLabel(currentStep >= 4 ? timeline.updatedAt : nil),
                timestampISO8601: currentStep >= 4 ? timeline.updatedAt : nil,
                marker: marker(step: 4, currentStep: currentStep)
            ),
            ActiveTimelineEventModel(
                id: "step.terminal",
                title: state == .failed ? "Settlement failed" : "Receipt issued",
                description: state == .failed
                    ? "Cycle moved to terminal failed state."
                    : "Cycle moved to terminal completed state.",
                timestampLabel: timestampLabel(currentStep >= 5 ? timeline.updatedAt : nil),
                timestampISO8601: currentStep >= 5 ? timeline.updatedAt : nil,
                marker: marker(step: 5, currentStep: currentStep)
            )
        ]

        let legEvents = timeline.legs.map { leg in
            let description: String
            let title: String
            let marker: ActiveTimelineMarker
            let timestampISO: String?

            switch leg.status {
            case "deposited":
                title = "Deposit confirmed · @\(leg.fromActor.id)"
                description = "Leg \(leg.legID) deposited."
                marker = .completed
                timestampISO = leg.depositedAt ?? timeline.updatedAt
            case "released":
                title = "Assets released · @\(leg.fromActor.id)"
                description = "Leg \(leg.legID) released."
                marker = .completed
                timestampISO = leg.releasedAt ?? timeline.updatedAt
            case "refunded":
                title = "Refund issued · @\(leg.fromActor.id)"
                description = "Leg \(leg.legID) refunded."
                marker = .completed
                timestampISO = leg.refundedAt ?? timeline.updatedAt
            default:
                title = "Awaiting @\(leg.fromActor.id) deposit"
                description = "Deadline \(timestampLabel(leg.depositDeadlineAt))."
                marker = .pending
                timestampISO = leg.depositDeadlineAt
            }

            return ActiveTimelineEventModel(
                id: "leg.\(leg.legID)",
                title: title,
                description: description,
                timestampLabel: timestampLabel(timestampISO),
                timestampISO8601: timestampISO,
                marker: marker
            )
        }

        let all = stepEvents + legEvents
        return all.sorted(by: timelineEventSort)
    }

    private static func marker(step: Int, currentStep: Int) -> ActiveTimelineMarker {
        if currentStep > step {
            return .completed
        }
        if currentStep == step {
            return .active
        }
        return .pending
    }

    private static func timelineEventSort(lhs: ActiveTimelineEventModel, rhs: ActiveTimelineEventModel) -> Bool {
        let lhsDate = parseISO(lhs.timestampISO8601)
        let rhsDate = parseISO(rhs.timestampISO8601)

        switch (lhsDate, rhsDate) {
        case let (l?, r?):
            if l != r { return l > r }
            return lhs.id < rhs.id
        case (_?, nil):
            return true
        case (nil, _?):
            return false
        case (nil, nil):
            return lhs.id < rhs.id
        }
    }

    private static func pendingLegForActor(timeline: SettlementTimeline, actorID: String) -> SettlementLeg? {
        timeline.legs.first(where: { $0.fromActor.id == actorID && $0.status == "pending" })
    }

    private static func timestampLabel(_ iso8601: String?) -> String {
        guard let iso8601, let date = parseISO(iso8601) else {
            return "Pending"
        }

        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "MMM d, HH:mm"
        return formatter.string(from: date)
    }

    private static func parseISO(_ value: String?) -> Date? {
        guard let value else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) {
            return date
        }

        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }

    private static func fallbackStateForActionError(_ error: MarketplaceClientError) -> FallbackState {
        switch error {
        case .conflict(let envelope):
            return .blocked(
                title: "Action unavailable",
                message: conflictMessage(from: envelope)
            )
        default:
            return FallbackState.from(error: error)
        }
    }

    private static func conflictMessage(from envelope: MarketplaceAPIErrorEnvelope) -> String {
        if let details = objectValue(envelope.error.details),
           let reasonCode = stringValue(details["reason_code"]) {
            return "Blocked (\(reasonCode)). \(envelope.error.message)"
        }

        if let details = objectValue(envelope.error.details),
           let state = stringValue(details["state"]) {
            return "Current state is \(state). \(envelope.error.message)"
        }

        return envelope.error.message
    }

    private static func objectValue(_ value: JSONValue?) -> [String: JSONValue]? {
        guard case let .object(object)? = value else {
            return nil
        }
        return object
    }

    private static func stringValue(_ value: JSONValue?) -> String? {
        guard case let .string(text)? = value else {
            return nil
        }
        return text
    }

    private func trackBlockedAction(action: ActiveActionKind, reason: String) async {
        guard let cycleID = activeCycleID else { return }

        await track(
            name: "marketplace.timeline.action_blocked",
            payload: [
                "cycle_id": .string(cycleID),
                "actor_id": .string(actorID),
                "action": .string(action.rawValue),
                "reason": .string(reason)
            ]
        )
    }

    private func saveCachedTimeline(_ timeline: SettlementTimeline) {
        let nowEpoch = nowEpochSeconds()
        var payload = (try? offlineStore?.load(nowEpochSeconds: nowEpoch)?.value) ?? [:]
        payload[timeline.cycleID] = timeline
        try? offlineStore?.save(payload, nowEpochSeconds: nowEpoch)
    }

    @discardableResult
    private func restoreCachedTimeline(cycleID: String) -> Bool {
        guard let cached = try? offlineStore?.load(nowEpochSeconds: nowEpochSeconds()) else {
            return false
        }
        guard let timeline = cached.value[cycleID] else {
            return false
        }

        cachedTimeline = timeline
        snapshot = Self.makeSnapshot(timeline: timeline, actorType: actorType, actorID: actorID)
        staleDataState = .cachedFallback(cachedAtEpochSeconds: cached.cachedAtEpochSeconds)
        return true
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
