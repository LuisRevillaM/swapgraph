import Foundation

public protocol MarketplaceReceiptsRepositoryProtocol: Sendable {
    func loadReceipts(candidateCycleIDs: [String]) async throws -> [SwapReceipt]
    func receipt(cycleID: String) async throws -> SwapReceipt
    func receiptShare(receiptID: String) async throws -> ReceiptShareProjection?
}

public actor MarketplaceReceiptsRepository: MarketplaceReceiptsRepositoryProtocol {
    private let apiClient: MarketplaceAPIClient

    public init(apiClient: MarketplaceAPIClient) {
        self.apiClient = apiClient
    }

    public func loadReceipts(candidateCycleIDs: [String]) async throws -> [SwapReceipt] {
        let uniqueCycleIDs = Array(
            Set(
                candidateCycleIDs
                    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .filter { !$0.isEmpty }
            )
        )

        guard !uniqueCycleIDs.isEmpty else { return [] }

        var receipts: [SwapReceipt] = []
        var firstError: MarketplaceClientError?

        for cycleID in uniqueCycleIDs {
            do {
                let result = try await receipt(cycleID: cycleID)
                receipts.append(result)
            } catch let error as MarketplaceClientError {
                if case .notFound = error {
                    continue
                }
                if firstError == nil {
                    firstError = error
                }
            }
        }

        if receipts.isEmpty, let firstError {
            throw firstError
        }

        return receipts
    }

    public func receipt(cycleID: String) async throws -> SwapReceipt {
        let response = try await apiClient.receipt(cycleID: cycleID)
        return response.receipt
    }

    public func receiptShare(receiptID: String) async throws -> ReceiptShareProjection? {
        do {
            let response = try await apiClient.receiptShareProjection(receiptID: receiptID)
            return response.receiptShare
        } catch let error as MarketplaceClientError {
            if case .notFound = error {
                return nil
            }
            throw error
        }
    }
}

public struct StaticReceiptsRepositoryErrors: Sendable {
    public var list: MarketplaceClientError?
    public var get: MarketplaceClientError?
    public var share: MarketplaceClientError?

    public init(
        list: MarketplaceClientError? = nil,
        get: MarketplaceClientError? = nil,
        share: MarketplaceClientError? = nil
    ) {
        self.list = list
        self.get = get
        self.share = share
    }
}

public actor StaticReceiptsRepository: MarketplaceReceiptsRepositoryProtocol {
    private let receiptsByCycleID: [String: SwapReceipt]
    private let sharesByReceiptID: [String: ReceiptShareProjection]
    private let errors: StaticReceiptsRepositoryErrors

    public init(
        receipts: [SwapReceipt],
        shares: [ReceiptShareProjection] = [],
        errors: StaticReceiptsRepositoryErrors = .init()
    ) {
        self.receiptsByCycleID = Dictionary(uniqueKeysWithValues: receipts.map { ($0.cycleID, $0) })
        self.sharesByReceiptID = Dictionary(uniqueKeysWithValues: shares.map { ($0.receiptID, $0) })
        self.errors = errors
    }

    public func loadReceipts(candidateCycleIDs: [String]) async throws -> [SwapReceipt] {
        if let error = errors.list { throw error }

        if candidateCycleIDs.isEmpty {
            return Array(receiptsByCycleID.values)
        }

        return candidateCycleIDs.compactMap { receiptsByCycleID[$0] }
    }

    public func receipt(cycleID: String) async throws -> SwapReceipt {
        if let error = errors.get { throw error }

        guard let receipt = receiptsByCycleID[cycleID] else {
            throw MarketplaceClientError.notFound(
                MarketplaceAPIErrorEnvelope(
                    correlationID: "corr_\(cycleID)",
                    error: MarketplaceAPIErrorBody(
                        code: "NOT_FOUND",
                        message: "receipt not found",
                        details: .object(["cycle_id": .string(cycleID)])
                    )
                )
            )
        }

        return receipt
    }

    public func receiptShare(receiptID: String) async throws -> ReceiptShareProjection? {
        if let error = errors.share { throw error }
        return sharesByReceiptID[receiptID]
    }
}

public enum ReceiptsPreviewFixtures {
    public static func sampleReceipts() -> [SwapReceipt] {
        [
            SwapReceipt(
                id: "receipt_cycle_completed",
                cycleID: "cycle_completed",
                finalState: "completed",
                intentIDs: ["intent_a", "intent_b"],
                assetIDs: ["m9_bayonet", "ak_vulcan"],
                fees: [
                    SwapReceiptFee(actor: ActorRef(type: "partner", id: "partner_demo"), feeUSD: 2.5)
                ],
                createdAt: "2026-02-24T09:40:00Z",
                signature: SwapReceiptSignature(
                    keyID: "receipt_signing_dev_k1",
                    alg: "ed25519",
                    sig: "abcdef1234567890abcdef1234567890"
                ),
                transparency: .object([
                    "value_delta_bps": .number(620)
                ])
            ),
            SwapReceipt(
                id: "receipt_cycle_unwound",
                cycleID: "cycle_unwound",
                finalState: "failed",
                intentIDs: ["intent_c", "intent_d"],
                assetIDs: ["karambit_doppler", "awp_asiimov"],
                createdAt: "2026-02-24T08:10:00Z",
                signature: SwapReceiptSignature(
                    keyID: "receipt_signing_dev_k1",
                    alg: "ed25519",
                    sig: "1234567890abcdef1234567890abcdef"
                ),
                transparency: .object([
                    "reason_code": .string("deposit_timeout")
                ])
            )
        ]
    }

    public static func sampleShares() -> [ReceiptShareProjection] {
        [
            ReceiptShareProjection(
                receiptID: "receipt_cycle_completed",
                cycleID: "cycle_completed",
                finalState: "completed",
                createdAt: "2026-02-24T09:40:00Z",
                publicSummary: ReceiptSharePublicSummary(
                    assetCount: 2,
                    intentCount: 2,
                    finalState: "completed"
                ),
                sharePayload: ReceiptSharePayload(
                    title: "Swap cycle cycle_completed",
                    subtitle: "Final state: completed",
                    badge: "completed"
                ),
                privacy: ReceiptSharePrivacy(
                    defaultMode: "public_safe",
                    modes: ["public_safe", "private"],
                    redactedFields: ["intent_ids", "asset_ids"],
                    toggleAllowed: true
                )
            ),
            ReceiptShareProjection(
                receiptID: "receipt_cycle_unwound",
                cycleID: "cycle_unwound",
                finalState: "failed",
                createdAt: "2026-02-24T08:10:00Z",
                publicSummary: ReceiptSharePublicSummary(
                    assetCount: 2,
                    intentCount: 2,
                    finalState: "failed"
                ),
                sharePayload: ReceiptSharePayload(
                    title: "Swap cycle cycle_unwound",
                    subtitle: "Final state: failed",
                    badge: "failed"
                ),
                privacy: ReceiptSharePrivacy(
                    defaultMode: "public_safe",
                    modes: ["public_safe", "private"],
                    redactedFields: ["intent_ids", "asset_ids"],
                    toggleAllowed: true
                )
            )
        ]
    }
}
