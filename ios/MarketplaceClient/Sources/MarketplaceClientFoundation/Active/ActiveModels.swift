import Foundation

public enum ActiveSettlementState: String, Sendable, Equatable {
    case proposed
    case accepted
    case escrowPending = "escrow.pending"
    case escrowReady = "escrow.ready"
    case executing
    case completed
    case failed

    public init(rawState: String) {
        self = ActiveSettlementState(rawValue: rawState) ?? .proposed
    }

    public var stateLabel: String {
        switch self {
        case .proposed:
            return "Proposed"
        case .accepted:
            return "Accepted"
        case .escrowPending:
            return "Awaiting deposits"
        case .escrowReady:
            return "Ready for execution"
        case .executing:
            return "Executing"
        case .completed:
            return "Completed"
        case .failed:
            return "Failed"
        }
    }

    public var progressStep: Int {
        switch self {
        case .proposed:
            return 0
        case .accepted:
            return 1
        case .escrowPending:
            return 2
        case .escrowReady:
            return 3
        case .executing:
            return 4
        case .completed, .failed:
            return 5
        }
    }
}

public enum ActiveTimelineMarker: String, Sendable, Equatable {
    case completed
    case active
    case pending
}

public struct ActiveProgressHeaderModel: Sendable, Equatable {
    public let cycleID: String
    public let stateLabel: String
    public let headline: String
    public let detail: String
    public let completedSteps: Int
    public let totalSteps: Int

    public init(
        cycleID: String,
        stateLabel: String,
        headline: String,
        detail: String,
        completedSteps: Int,
        totalSteps: Int
    ) {
        self.cycleID = cycleID
        self.stateLabel = stateLabel
        self.headline = headline
        self.detail = detail
        self.completedSteps = completedSteps
        self.totalSteps = max(totalSteps, 1)
    }

    public var progressFraction: Double {
        min(1, max(0, Double(completedSteps) / Double(totalSteps)))
    }
}

public struct ActiveTimelineEventModel: Identifiable, Sendable, Equatable {
    public let id: String
    public let title: String
    public let description: String
    public let timestampLabel: String
    public let timestampISO8601: String?
    public let marker: ActiveTimelineMarker

    public init(
        id: String,
        title: String,
        description: String,
        timestampLabel: String,
        timestampISO8601: String?,
        marker: ActiveTimelineMarker
    ) {
        self.id = id
        self.title = title
        self.description = description
        self.timestampLabel = timestampLabel
        self.timestampISO8601 = timestampISO8601
        self.marker = marker
    }
}

public enum ActiveActionKind: String, Sendable, Equatable {
    case confirmDeposit = "confirm_deposit"
    case beginExecution = "begin_execution"
    case completeSettlement = "complete_settlement"
    case openReceipt = "open_receipt"
}

public struct ActiveActionModel: Sendable, Equatable {
    public let kind: ActiveActionKind
    public let title: String
    public let subtitle: String
    public let isEnabled: Bool
    public let disabledReason: String?

    public init(
        kind: ActiveActionKind,
        title: String,
        subtitle: String,
        isEnabled: Bool,
        disabledReason: String? = nil
    ) {
        self.kind = kind
        self.title = title
        self.subtitle = subtitle
        self.isEnabled = isEnabled
        self.disabledReason = disabledReason
    }
}

public struct ActiveScreenSnapshot: Sendable, Equatable {
    public let cycleID: String
    public let state: ActiveSettlementState
    public let header: ActiveProgressHeaderModel
    public let waitReason: String?
    public let timelineEvents: [ActiveTimelineEventModel]
    public let primaryAction: ActiveActionModel?

    public init(
        cycleID: String,
        state: ActiveSettlementState,
        header: ActiveProgressHeaderModel,
        waitReason: String?,
        timelineEvents: [ActiveTimelineEventModel],
        primaryAction: ActiveActionModel?
    ) {
        self.cycleID = cycleID
        self.state = state
        self.header = header
        self.waitReason = waitReason
        self.timelineEvents = timelineEvents
        self.primaryAction = primaryAction
    }

    public var hasActionOrWaitReason: Bool {
        if let primaryAction {
            if primaryAction.isEnabled { return true }
            if let disabledReason = primaryAction.disabledReason, !disabledReason.isEmpty { return true }
        }
        if let waitReason, !waitReason.isEmpty {
            return true
        }
        return false
    }
}

public struct ActiveSettlementCompletion: Sendable, Equatable {
    public let timeline: SettlementTimeline
    public let receipt: SwapReceipt

    public init(timeline: SettlementTimeline, receipt: SwapReceipt) {
        self.timeline = timeline
        self.receipt = receipt
    }
}
