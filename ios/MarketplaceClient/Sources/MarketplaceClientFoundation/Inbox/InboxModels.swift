import Foundation

public enum ProposalUrgencyBand: String, Sendable, Equatable {
    case actNow
    case highConfidence
    case standard

    public var title: String {
        switch self {
        case .actNow:
            return "Act now"
        case .highConfidence:
            return "High confidence"
        case .standard:
            return "More opportunities"
        }
    }
}

public struct ProposalInboxRowModel: Identifiable, Sendable, Equatable {
    public let id: String
    public let giveLabel: String
    public let getLabel: String
    public let confidenceScore: Double
    public let valueSpread: Double
    public let participantCount: Int
    public let statusCue: String
    public let urgencyBand: ProposalUrgencyBand
    public let apiOrderIndex: Int

    public init(
        id: String,
        giveLabel: String,
        getLabel: String,
        confidenceScore: Double,
        valueSpread: Double,
        participantCount: Int,
        statusCue: String,
        urgencyBand: ProposalUrgencyBand,
        apiOrderIndex: Int
    ) {
        self.id = id
        self.giveLabel = giveLabel
        self.getLabel = getLabel
        self.confidenceScore = confidenceScore
        self.valueSpread = valueSpread
        self.participantCount = participantCount
        self.statusCue = statusCue
        self.urgencyBand = urgencyBand
        self.apiOrderIndex = apiOrderIndex
    }
}

public struct ProposalInboxSectionModel: Identifiable, Sendable, Equatable {
    public let id: String
    public let title: String
    public let rows: [ProposalInboxRowModel]

    public init(id: String, title: String, rows: [ProposalInboxRowModel]) {
        self.id = id
        self.title = title
        self.rows = rows
    }
}

public struct ProposalInboxSnapshot: Sendable, Equatable {
    public let sections: [ProposalInboxSectionModel]

    public init(sections: [ProposalInboxSectionModel]) {
        self.sections = sections
    }
}
