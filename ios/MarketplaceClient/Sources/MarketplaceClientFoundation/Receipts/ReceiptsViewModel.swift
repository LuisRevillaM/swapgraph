import Foundation

public struct ReceiptDetailPresentation: Identifiable, Equatable {
    public let id: String
    public let snapshot: ReceiptDetailSnapshot

    public init(id: String, snapshot: ReceiptDetailSnapshot) {
        self.id = id
        self.snapshot = snapshot
    }
}

@MainActor
public final class ReceiptsViewModel: ObservableObject {
    @Published public private(set) var snapshot: ReceiptsScreenSnapshot?
    @Published public private(set) var fallbackState: FallbackState?
    @Published public private(set) var staleDataState: StaleDataState?
    @Published public private(set) var isLoading = false
    @Published public var detailPresentation: ReceiptDetailPresentation?

    private let repository: MarketplaceReceiptsRepositoryProtocol
    private let offlineStore: OfflineSnapshotStore<[SwapReceipt]>?
    private let analyticsClient: AnalyticsClient?
    private let actorID: String
    private let now: () -> Date

    private var knownCycleIDs: [String]
    private var receiptsByCycleID: [String: SwapReceipt] = [:]

    public init(
        repository: MarketplaceReceiptsRepositoryProtocol,
        offlineStore: OfflineSnapshotStore<[SwapReceipt]>? = nil,
        analyticsClient: AnalyticsClient? = nil,
        actorID: String = "u1",
        knownCycleIDs: [String] = [],
        now: @escaping () -> Date = Date.init
    ) {
        self.repository = repository
        self.offlineStore = offlineStore
        self.analyticsClient = analyticsClient
        self.actorID = actorID
        self.knownCycleIDs = []
        self.now = now

        for cycleID in knownCycleIDs {
            rememberCycleID(cycleID)
        }
    }

    public func refresh() async {
        await refresh(selectedCycleID: nil)
    }

    public func refresh(selectedCycleID: String?) async {
        if let selectedCycleID {
            rememberCycleID(selectedCycleID)
        }

        isLoading = true
        defer { isLoading = false }

        do {
            let receipts = try await repository.loadReceipts(candidateCycleIDs: knownCycleIDs)
            for receipt in receipts {
                receiptsByCycleID[receipt.cycleID] = receipt
                rememberCycleID(receipt.cycleID)
            }

            snapshot = Self.makeSnapshot(receipts: Array(receiptsByCycleID.values))
            fallbackState = nil
            staleDataState = nil
            try? offlineStore?.save(Array(receiptsByCycleID.values), nowEpochSeconds: nowEpochSeconds())
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
                title: "Unable to load receipts",
                message: "Please retry in a moment."
            )
            staleDataState = nil
        }
    }

    public func openIfNeeded(cycleID: String?) async {
        guard let cycleID else { return }
        guard detailPresentation?.id != cycleID else { return }

        rememberCycleID(cycleID)
        if snapshot == nil, !isLoading {
            await refresh(selectedCycleID: cycleID)
        }
        await openReceipt(cycleID: cycleID)
    }

    public func openReceipt(cycleID: String) async {
        rememberCycleID(cycleID)

        do {
            let receipt: SwapReceipt
            if let cached = receiptsByCycleID[cycleID] {
                receipt = cached
            } else {
                receipt = try await repository.receipt(cycleID: cycleID)
                receiptsByCycleID[cycleID] = receipt
            }

            let shareProjection = try await repository.receiptShare(receiptID: receipt.id)
            let detailSnapshot = Self.makeDetailSnapshot(receipt: receipt, share: shareProjection)
            detailPresentation = ReceiptDetailPresentation(id: cycleID, snapshot: detailSnapshot)
            snapshot = Self.makeSnapshot(receipts: Array(receiptsByCycleID.values))
            fallbackState = nil
            staleDataState = nil

            await trackReceiptViewed(receiptID: receipt.id)
        } catch let error as MarketplaceClientError {
            fallbackState = FallbackState.from(error: error)
            staleDataState = nil
        } catch {
            fallbackState = .failure(
                title: "Unable to open receipt",
                message: "Please retry in a moment."
            )
            staleDataState = nil
        }
    }

    public func closeDetail() {
        detailPresentation = nil
    }

    public static func preview() -> ReceiptsViewModel {
        let repository = StaticReceiptsRepository(
            receipts: ReceiptsPreviewFixtures.sampleReceipts(),
            shares: ReceiptsPreviewFixtures.sampleShares()
        )
        let viewModel = ReceiptsViewModel(repository: repository, knownCycleIDs: ["cycle_completed", "cycle_unwound"])
        viewModel.receiptsByCycleID = Dictionary(
            uniqueKeysWithValues: ReceiptsPreviewFixtures.sampleReceipts().map { ($0.cycleID, $0) }
        )
        viewModel.snapshot = Self.makeSnapshot(receipts: ReceiptsPreviewFixtures.sampleReceipts())
        return viewModel
    }

    private func rememberCycleID(_ cycleID: String) {
        let normalized = cycleID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return }
        guard !knownCycleIDs.contains(normalized) else { return }
        knownCycleIDs.append(normalized)
    }

    private static func makeSnapshot(receipts: [SwapReceipt]) -> ReceiptsScreenSnapshot {
        let sorted = receipts.sorted { lhs, rhs in
            let left = parseDate(lhs.createdAt) ?? .distantPast
            let right = parseDate(rhs.createdAt) ?? .distantPast
            if left != right {
                return left > right
            }
            return lhs.id < rhs.id
        }

        let rows = sorted.map(makeRow)
        return ReceiptsScreenSnapshot(rows: rows)
    }

    private static func makeRow(receipt: SwapReceipt) -> ReceiptListRowModel {
        let outcome = outcomeKind(for: receipt)
        return ReceiptListRowModel(
            id: receipt.id,
            receiptID: receipt.id,
            cycleID: receipt.cycleID,
            outcome: outcome,
            flowTitle: flowTitle(for: receipt),
            dateLabel: timestampLabel(receipt.createdAt),
            typeLabel: outcome.typeLabel,
            verificationLabel: verificationLabel(for: receipt),
            valueDeltaLabel: valueDeltaLabel(for: receipt, outcome: outcome)
        )
    }

    private static func makeDetailSnapshot(
        receipt: SwapReceipt,
        share: ReceiptShareProjection?
    ) -> ReceiptDetailSnapshot {
        let outcome = outcomeKind(for: receipt)
        let shareContext: ReceiptShareContextModel? = share.map { projection in
            let summary = "\(projection.publicSummary.assetCount) assets · \(projection.publicSummary.intentCount) intents"
            let privacyMode = projection.privacy.defaultMode.replacingOccurrences(of: "_", with: " ")
            let redactions = projection.privacy.redactedFields.isEmpty
                ? "No redactions"
                : projection.privacy.redactedFields.joined(separator: ", ")

            return ReceiptShareContextModel(
                shareTitle: projection.sharePayload.title,
                shareSubtitle: projection.sharePayload.subtitle,
                badge: projection.sharePayload.badge.uppercased(),
                publicSummary: summary,
                privacyMode: "Mode: \(privacyMode)",
                redactionSummary: "Redactions: \(redactions)"
            )
        }

        return ReceiptDetailSnapshot(
            receiptID: receipt.id,
            cycleID: receipt.cycleID,
            outcome: outcome,
            flowTitle: flowTitle(for: receipt),
            dateLabel: timestampLabel(receipt.createdAt),
            typeLabel: outcome.typeLabel,
            verificationLabel: verificationLabel(for: receipt),
            valueDeltaLabel: valueDeltaLabel(for: receipt, outcome: outcome),
            intentCountLabel: "\(receipt.intentIDs.count) intents",
            assetCountLabel: "\(receipt.assetIDs.count) assets",
            signatureKeyID: receipt.signature.keyID,
            signatureAlgorithm: receipt.signature.alg,
            signaturePreview: signaturePreview(receipt.signature.sig),
            shareContext: shareContext
        )
    }

    private static func outcomeKind(for receipt: SwapReceipt) -> ReceiptOutcomeKind {
        if receipt.finalState == "completed" {
            return .completed
        }

        if transparencyString(receipt.transparency, key: "reason_code") == "deposit_timeout" {
            return .unwound
        }

        return .failed
    }

    private static func flowTitle(for receipt: SwapReceipt) -> String {
        let normalized = receipt.assetIDs.prefix(2).map(displayName(for:))
        if normalized.count >= 2 {
            return "\(normalized[0]) -> \(normalized[1])"
        }
        if let only = normalized.first {
            return "\(only) settlement"
        }
        return "Cycle \(receipt.cycleID)"
    }

    private static func verificationLabel(for receipt: SwapReceipt) -> String {
        if receipt.signature.keyID.isEmpty || receipt.signature.alg.isEmpty || receipt.signature.sig.isEmpty {
            return "Signature missing"
        }
        return "Signed (\(receipt.signature.alg))"
    }

    private static func valueDeltaLabel(for receipt: SwapReceipt, outcome: ReceiptOutcomeKind) -> String {
        if let bps = transparencyNumber(receipt.transparency, key: "value_delta_bps") {
            let percent = bps / 100
            let sign = percent >= 0 ? "+" : ""
            return "\(sign)\(String(format: "%.1f", percent))%"
        }

        if let usd = transparencyNumber(receipt.transparency, key: "value_delta_usd") {
            return currencyLabel(usd)
        }

        if let fees = receipt.fees, !fees.isEmpty {
            let totalFees = fees.map(\.feeUSD).reduce(0, +)
            return "Fees \(currencyLabel(-totalFees))"
        }

        switch outcome {
        case .completed:
            return "Balanced"
        case .failed:
            return "No fill"
        case .unwound:
            return "Refunded"
        }
    }

    private static func currencyLabel(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        formatter.maximumFractionDigits = 2
        formatter.minimumFractionDigits = 2

        let absolute = abs(value)
        let label = formatter.string(from: NSNumber(value: absolute)) ?? "$0.00"
        if value > 0 {
            return "+\(label)"
        }
        if value < 0 {
            return "-\(label)"
        }
        return label
    }

    private static func signaturePreview(_ signature: String) -> String {
        guard signature.count > 16 else { return signature }
        return "\(signature.prefix(10))...\(signature.suffix(6))"
    }

    private static func parseDate(_ iso8601: String) -> Date? {
        ISO8601DateFormatter().date(from: iso8601)
    }

    private static func timestampLabel(_ iso8601: String?) -> String {
        guard let iso8601, let date = parseDate(iso8601) else {
            return "Unknown"
        }

        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "MMM d, yyyy · HH:mm"
        return formatter.string(from: date)
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

    private static func transparencyString(_ transparency: JSONValue?, key: String) -> String? {
        guard case .object(let object) = transparency else { return nil }
        guard case .string(let value)? = object[key] else { return nil }
        return value
    }

    private static func transparencyNumber(_ transparency: JSONValue?, key: String) -> Double? {
        guard case .object(let object) = transparency else { return nil }
        guard case .number(let value)? = object[key] else { return nil }
        return value
    }

    private func trackReceiptViewed(receiptID: String) async {
        guard let analyticsClient else { return }

        let event = AnalyticsEvent(
            name: "marketplace.receipt.viewed",
            correlationID: UUID().uuidString.lowercased(),
            occurredAt: ISO8601DateFormatter().string(from: now()),
            payload: [
                "receipt_id": .string(receiptID),
                "actor_id": .string(actorID)
            ]
        )

        try? await analyticsClient.track(event)
    }

    @discardableResult
    private func restoreOfflineSnapshot() -> Bool {
        guard let cached = try? offlineStore?.load(nowEpochSeconds: nowEpochSeconds()) else {
            return false
        }

        let receipts = cached.value
        receiptsByCycleID = Dictionary(uniqueKeysWithValues: receipts.map { ($0.cycleID, $0) })
        snapshot = Self.makeSnapshot(receipts: receipts)
        staleDataState = .cachedFallback(cachedAtEpochSeconds: cached.cachedAtEpochSeconds)
        return true
    }

    private func nowEpochSeconds() -> Int {
        Int(now().timeIntervalSince1970)
    }
}
