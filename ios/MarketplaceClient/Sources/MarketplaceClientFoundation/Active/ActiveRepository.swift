import Foundation

public protocol MarketplaceActiveRepositoryProtocol: Sendable {
    func settlementStatus(cycleID: String) async throws -> SettlementTimeline
    func confirmDeposit(
        cycleID: String,
        legID: String,
        depositRef: String,
        idempotencyKey: String?
    ) async throws -> SettlementTimeline
    func beginExecution(cycleID: String, idempotencyKey: String?) async throws -> SettlementTimeline
    func completeSettlement(cycleID: String, idempotencyKey: String?) async throws -> ActiveSettlementCompletion
    func receipt(cycleID: String) async throws -> SwapReceipt
}

public actor MarketplaceActiveRepository: MarketplaceActiveRepositoryProtocol {
    private let apiClient: MarketplaceAPIClient

    public init(apiClient: MarketplaceAPIClient) {
        self.apiClient = apiClient
    }

    public func settlementStatus(cycleID: String) async throws -> SettlementTimeline {
        let response = try await apiClient.settlementStatus(cycleID: cycleID)
        return response.timeline
    }

    public func confirmDeposit(
        cycleID: String,
        legID: String,
        depositRef: String,
        idempotencyKey: String?
    ) async throws -> SettlementTimeline {
        _ = legID
        let response = try await apiClient.confirmDeposit(
            cycleID: cycleID,
            depositRef: depositRef,
            idempotencyKey: idempotencyKey
        )
        return response.timeline
    }

    public func beginExecution(cycleID: String, idempotencyKey: String?) async throws -> SettlementTimeline {
        let response = try await apiClient.beginExecution(cycleID: cycleID, idempotencyKey: idempotencyKey)
        return response.timeline
    }

    public func completeSettlement(cycleID: String, idempotencyKey: String?) async throws -> ActiveSettlementCompletion {
        let response = try await apiClient.completeSettlement(cycleID: cycleID, idempotencyKey: idempotencyKey)
        return ActiveSettlementCompletion(timeline: response.timeline, receipt: response.receipt)
    }

    public func receipt(cycleID: String) async throws -> SwapReceipt {
        let response = try await apiClient.receipt(cycleID: cycleID)
        return response.receipt
    }
}

public struct StaticActiveRepositoryErrors: Sendable {
    public var status: MarketplaceClientError?
    public var confirmDeposit: MarketplaceClientError?
    public var beginExecution: MarketplaceClientError?
    public var completeSettlement: MarketplaceClientError?
    public var receipt: MarketplaceClientError?

    public init(
        status: MarketplaceClientError? = nil,
        confirmDeposit: MarketplaceClientError? = nil,
        beginExecution: MarketplaceClientError? = nil,
        completeSettlement: MarketplaceClientError? = nil,
        receipt: MarketplaceClientError? = nil
    ) {
        self.status = status
        self.confirmDeposit = confirmDeposit
        self.beginExecution = beginExecution
        self.completeSettlement = completeSettlement
        self.receipt = receipt
    }
}

public actor StaticActiveRepository: MarketplaceActiveRepositoryProtocol {
    private var timelinesByCycleID: [String: SettlementTimeline]
    private var receiptsByCycleID: [String: SwapReceipt]
    private let errors: StaticActiveRepositoryErrors
    private let nowISO8601: @Sendable () -> String

    public init(
        timelines: [SettlementTimeline],
        receipts: [SwapReceipt] = [],
        errors: StaticActiveRepositoryErrors = .init(),
        nowISO8601: @escaping @Sendable () -> String = { ISO8601DateFormatter().string(from: Date()) }
    ) {
        self.timelinesByCycleID = Dictionary(uniqueKeysWithValues: timelines.map { ($0.cycleID, $0) })
        self.receiptsByCycleID = Dictionary(uniqueKeysWithValues: receipts.map { ($0.cycleID, $0) })
        self.errors = errors
        self.nowISO8601 = nowISO8601
    }

    public func settlementStatus(cycleID: String) async throws -> SettlementTimeline {
        if let error = errors.status { throw error }
        return try timelineOrThrow(cycleID: cycleID)
    }

    public func confirmDeposit(
        cycleID: String,
        legID: String,
        depositRef: String,
        idempotencyKey: String?
    ) async throws -> SettlementTimeline {
        _ = idempotencyKey
        if let error = errors.confirmDeposit { throw error }

        var timeline = try timelineOrThrow(cycleID: cycleID)
        guard let legIndex = timeline.legs.firstIndex(where: { $0.legID == legID }) else {
            throw conflictError(
                cycleID: cycleID,
                message: "deposit leg not found",
                details: [
                    "cycle_id": .string(cycleID),
                    "leg_id": .string(legID)
                ]
            )
        }

        let existing = timeline.legs[legIndex]
        if existing.status == "deposited" && existing.depositRef == depositRef {
            return timeline
        }

        if existing.status != "pending" {
            throw conflictError(
                cycleID: cycleID,
                message: "cannot confirm deposit in this state",
                details: [
                    "cycle_id": .string(cycleID),
                    "leg_id": .string(existing.legID),
                    "leg_status": .string(existing.status)
                ]
            )
        }

        let updatedLeg = SettlementLeg(
            legID: existing.legID,
            intentID: existing.intentID,
            fromActor: existing.fromActor,
            toActor: existing.toActor,
            assets: existing.assets,
            status: "deposited",
            depositDeadlineAt: existing.depositDeadlineAt,
            depositMode: existing.depositMode,
            depositRef: depositRef,
            depositedAt: nowISO8601(),
            releaseRef: existing.releaseRef,
            releasedAt: existing.releasedAt,
            refundRef: existing.refundRef,
            refundedAt: existing.refundedAt
        )

        var nextLegs = timeline.legs
        nextLegs[legIndex] = updatedLeg

        let allDeposited = nextLegs.allSatisfy { ["deposited", "released"].contains($0.status) }
        timeline = SettlementTimeline(
            cycleID: timeline.cycleID,
            state: allDeposited ? "escrow.ready" : timeline.state,
            legs: nextLegs,
            updatedAt: nowISO8601()
        )

        timelinesByCycleID[cycleID] = timeline
        return timeline
    }

    public func beginExecution(cycleID: String, idempotencyKey: String?) async throws -> SettlementTimeline {
        _ = idempotencyKey
        if let error = errors.beginExecution { throw error }

        let timeline = try timelineOrThrow(cycleID: cycleID)
        guard timeline.state == "escrow.ready" else {
            throw conflictError(
                cycleID: cycleID,
                message: "cycle is not escrow.ready",
                details: [
                    "cycle_id": .string(cycleID),
                    "state": .string(timeline.state)
                ]
            )
        }

        let updated = SettlementTimeline(
            cycleID: timeline.cycleID,
            state: "executing",
            legs: timeline.legs,
            updatedAt: nowISO8601()
        )

        timelinesByCycleID[cycleID] = updated
        return updated
    }

    public func completeSettlement(cycleID: String, idempotencyKey: String?) async throws -> ActiveSettlementCompletion {
        _ = idempotencyKey
        if let error = errors.completeSettlement { throw error }

        let timeline = try timelineOrThrow(cycleID: cycleID)
        guard timeline.state == "executing" else {
            throw conflictError(
                cycleID: cycleID,
                message: "cycle is not executing",
                details: [
                    "cycle_id": .string(cycleID),
                    "state": .string(timeline.state)
                ]
            )
        }

        let releasedLegs = timeline.legs.map { leg in
            SettlementLeg(
                legID: leg.legID,
                intentID: leg.intentID,
                fromActor: leg.fromActor,
                toActor: leg.toActor,
                assets: leg.assets,
                status: "released",
                depositDeadlineAt: leg.depositDeadlineAt,
                depositMode: leg.depositMode,
                depositRef: leg.depositRef,
                depositedAt: leg.depositedAt,
                releaseRef: leg.releaseRef ?? "release_\(leg.legID)",
                releasedAt: nowISO8601(),
                refundRef: leg.refundRef,
                refundedAt: leg.refundedAt
            )
        }

        let updatedTimeline = SettlementTimeline(
            cycleID: timeline.cycleID,
            state: "completed",
            legs: releasedLegs,
            updatedAt: nowISO8601()
        )
        timelinesByCycleID[cycleID] = updatedTimeline

        let receipt = receiptsByCycleID[cycleID] ?? SwapReceipt(
            id: "receipt_\(cycleID)",
            cycleID: cycleID,
            finalState: "completed",
            intentIDs: releasedLegs.map(\.intentID),
            assetIDs: releasedLegs.flatMap(\.assets).map(\.assetID),
            createdAt: nowISO8601(),
            signature: SwapReceiptSignature(
                keyID: "receipt_signing_dev_k1",
                alg: "ed25519",
                sig: "sig_\(cycleID)"
            )
        )
        receiptsByCycleID[cycleID] = receipt

        return ActiveSettlementCompletion(timeline: updatedTimeline, receipt: receipt)
    }

    public func receipt(cycleID: String) async throws -> SwapReceipt {
        if let error = errors.receipt { throw error }
        if let receipt = receiptsByCycleID[cycleID] {
            return receipt
        }

        throw MarketplaceClientError.notFound(
            MarketplaceAPIErrorEnvelope(
                correlationID: "corr_\(cycleID)",
                error: MarketplaceAPIErrorBody(
                    code: "NOT_FOUND",
                    message: "receipt not found",
                    details: .object([
                        "cycle_id": .string(cycleID)
                    ])
                )
            )
        )
    }

    private func timelineOrThrow(cycleID: String) throws -> SettlementTimeline {
        if let timeline = timelinesByCycleID[cycleID] {
            return timeline
        }

        throw MarketplaceClientError.notFound(
            MarketplaceAPIErrorEnvelope(
                correlationID: "corr_\(cycleID)",
                error: MarketplaceAPIErrorBody(
                    code: "NOT_FOUND",
                    message: "timeline not found",
                    details: .object([
                        "cycle_id": .string(cycleID)
                    ])
                )
            )
        )
    }

    private func conflictError(
        cycleID: String,
        message: String,
        details: [String: JSONValue]
    ) -> MarketplaceClientError {
        .conflict(
            MarketplaceAPIErrorEnvelope(
                correlationID: "corr_\(cycleID)",
                error: MarketplaceAPIErrorBody(
                    code: "CONFLICT",
                    message: message,
                    details: .object(details)
                )
            )
        )
    }
}

public enum ActivePreviewFixtures {
    public static func sampleTimeline(cycleID: String = "cycle_active_preview") -> SettlementTimeline {
        SettlementTimeline(
            cycleID: cycleID,
            state: "escrow.pending",
            legs: [
                SettlementLeg(
                    legID: "leg_1",
                    intentID: "intent_a",
                    fromActor: ActorRef(type: "user", id: "u1"),
                    toActor: ActorRef(type: "user", id: "u2"),
                    assets: [AssetRef(platform: "steam", assetID: "m9_bayonet")],
                    status: "pending",
                    depositDeadlineAt: "2026-02-25T08:00:00Z"
                ),
                SettlementLeg(
                    legID: "leg_2",
                    intentID: "intent_b",
                    fromActor: ActorRef(type: "user", id: "u2"),
                    toActor: ActorRef(type: "user", id: "u1"),
                    assets: [AssetRef(platform: "steam", assetID: "ak_vulcan")],
                    status: "deposited",
                    depositDeadlineAt: "2026-02-25T08:00:00Z",
                    depositRef: "dep_leg_2",
                    depositedAt: "2026-02-24T08:10:00Z"
                )
            ],
            updatedAt: "2026-02-24T08:12:00Z"
        )
    }

    public static func sampleReceipt(cycleID: String = "cycle_active_preview") -> SwapReceipt {
        SwapReceipt(
            id: "receipt_\(cycleID)",
            cycleID: cycleID,
            finalState: "completed",
            intentIDs: ["intent_a", "intent_b"],
            assetIDs: ["m9_bayonet", "ak_vulcan"],
            createdAt: "2026-02-24T08:30:00Z",
            signature: SwapReceiptSignature(
                keyID: "receipt_signing_dev_k1",
                alg: "ed25519",
                sig: "sig_\(cycleID)"
            )
        )
    }
}
