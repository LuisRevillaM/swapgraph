import Foundation

public enum ProposalDecisionState: Sendable, Equatable {
    case idle
    case accepting
    case accepted(commitID: String)
    case declining
    case declined(commitID: String)
    case failed(message: String)
}

public struct ProposalParticipantNodeModel: Identifiable, Sendable, Equatable {
    public let id: String
    public let actorLabel: String
    public let givesLabel: String
    public let getsLabel: String

    public init(id: String, actorLabel: String, givesLabel: String, getsLabel: String) {
        self.id = id
        self.actorLabel = actorLabel
        self.givesLabel = givesLabel
        self.getsLabel = getsLabel
    }
}

public struct ProposalExplainabilityCardModel: Identifiable, Sendable, Equatable {
    public let id: String
    public let title: String
    public let valueText: String
    public let descriptionText: String

    public init(id: String, title: String, valueText: String, descriptionText: String) {
        self.id = id
        self.title = title
        self.valueText = valueText
        self.descriptionText = descriptionText
    }
}

public struct ProposalDetailSnapshot: Sendable, Equatable {
    public let proposalID: String
    public let cycleTypeLabel: String
    public let giveTitle: String
    public let getTitle: String
    public let confidenceText: String
    public let valueDeltaText: String
    public let participantNodes: [ProposalParticipantNodeModel]
    public let explainabilityCards: [ProposalExplainabilityCardModel]

    public init(
        proposalID: String,
        cycleTypeLabel: String,
        giveTitle: String,
        getTitle: String,
        confidenceText: String,
        valueDeltaText: String,
        participantNodes: [ProposalParticipantNodeModel],
        explainabilityCards: [ProposalExplainabilityCardModel]
    ) {
        self.proposalID = proposalID
        self.cycleTypeLabel = cycleTypeLabel
        self.giveTitle = giveTitle
        self.getTitle = getTitle
        self.confidenceText = confidenceText
        self.valueDeltaText = valueDeltaText
        self.participantNodes = participantNodes
        self.explainabilityCards = explainabilityCards
    }
}
