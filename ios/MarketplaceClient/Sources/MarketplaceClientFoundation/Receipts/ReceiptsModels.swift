import Foundation

public enum ReceiptOutcomeKind: String, Sendable, Equatable {
    case completed
    case failed
    case unwound

    public var typeLabel: String {
        switch self {
        case .completed:
            return "Completed"
        case .failed:
            return "Failed"
        case .unwound:
            return "Unwound"
        }
    }

    public var symbolName: String {
        switch self {
        case .completed:
            return "checkmark.circle.fill"
        case .failed:
            return "xmark.circle.fill"
        case .unwound:
            return "arrow.uturn.backward.circle.fill"
        }
    }
}

public struct ReceiptListRowModel: Identifiable, Sendable, Equatable {
    public let id: String
    public let receiptID: String
    public let cycleID: String
    public let outcome: ReceiptOutcomeKind
    public let flowTitle: String
    public let dateLabel: String
    public let typeLabel: String
    public let verificationLabel: String
    public let valueDeltaLabel: String

    public init(
        id: String,
        receiptID: String,
        cycleID: String,
        outcome: ReceiptOutcomeKind,
        flowTitle: String,
        dateLabel: String,
        typeLabel: String,
        verificationLabel: String,
        valueDeltaLabel: String
    ) {
        self.id = id
        self.receiptID = receiptID
        self.cycleID = cycleID
        self.outcome = outcome
        self.flowTitle = flowTitle
        self.dateLabel = dateLabel
        self.typeLabel = typeLabel
        self.verificationLabel = verificationLabel
        self.valueDeltaLabel = valueDeltaLabel
    }
}

public struct ReceiptsScreenSnapshot: Sendable, Equatable {
    public let rows: [ReceiptListRowModel]

    public init(rows: [ReceiptListRowModel]) {
        self.rows = rows
    }
}

public struct ReceiptShareContextModel: Sendable, Equatable {
    public let shareTitle: String
    public let shareSubtitle: String
    public let badge: String
    public let publicSummary: String
    public let privacyMode: String
    public let redactionSummary: String

    public init(
        shareTitle: String,
        shareSubtitle: String,
        badge: String,
        publicSummary: String,
        privacyMode: String,
        redactionSummary: String
    ) {
        self.shareTitle = shareTitle
        self.shareSubtitle = shareSubtitle
        self.badge = badge
        self.publicSummary = publicSummary
        self.privacyMode = privacyMode
        self.redactionSummary = redactionSummary
    }
}

public struct ReceiptDetailSnapshot: Sendable, Equatable {
    public let receiptID: String
    public let cycleID: String
    public let outcome: ReceiptOutcomeKind
    public let flowTitle: String
    public let dateLabel: String
    public let typeLabel: String
    public let verificationLabel: String
    public let valueDeltaLabel: String
    public let intentCountLabel: String
    public let assetCountLabel: String
    public let signatureKeyID: String
    public let signatureAlgorithm: String
    public let signaturePreview: String
    public let shareContext: ReceiptShareContextModel?

    public init(
        receiptID: String,
        cycleID: String,
        outcome: ReceiptOutcomeKind,
        flowTitle: String,
        dateLabel: String,
        typeLabel: String,
        verificationLabel: String,
        valueDeltaLabel: String,
        intentCountLabel: String,
        assetCountLabel: String,
        signatureKeyID: String,
        signatureAlgorithm: String,
        signaturePreview: String,
        shareContext: ReceiptShareContextModel?
    ) {
        self.receiptID = receiptID
        self.cycleID = cycleID
        self.outcome = outcome
        self.flowTitle = flowTitle
        self.dateLabel = dateLabel
        self.typeLabel = typeLabel
        self.verificationLabel = verificationLabel
        self.valueDeltaLabel = valueDeltaLabel
        self.intentCountLabel = intentCountLabel
        self.assetCountLabel = assetCountLabel
        self.signatureKeyID = signatureKeyID
        self.signatureAlgorithm = signatureAlgorithm
        self.signaturePreview = signaturePreview
        self.shareContext = shareContext
    }
}
