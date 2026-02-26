import Foundation

public struct ActorRef: Codable, Sendable, Hashable {
    public let type: String
    public let id: String

    public init(type: String, id: String) {
        self.type = type
        self.id = id
    }
}

public struct AssetRef: Codable, Sendable, Hashable {
    public let platform: String
    public let appID: Int?
    public let contextID: Int?
    public let assetID: String
    public let classID: String?
    public let instanceID: String?

    enum CodingKeys: String, CodingKey {
        case platform
        case appID = "app_id"
        case contextID = "context_id"
        case assetID = "asset_id"
        case classID = "class_id"
        case instanceID = "instance_id"
    }

    public init(
        platform: String,
        appID: Int? = nil,
        contextID: Int? = nil,
        assetID: String,
        classID: String? = nil,
        instanceID: String? = nil
    ) {
        self.platform = platform
        self.appID = appID
        self.contextID = contextID
        self.assetID = assetID
        self.classID = classID
        self.instanceID = instanceID
    }
}

public struct SwapIntent: Codable, Sendable, Equatable {
    public let id: String
    public let actor: ActorRef
    public let offer: [AssetRef]
    public let wantSpec: WantSpec?
    public let valueBand: ValueBand?
    public let trustConstraints: TrustConstraints?
    public let timeConstraints: TimeConstraints?
    public let settlementPreferences: SettlementPreferences?
    public let status: String?

    enum CodingKeys: String, CodingKey {
        case id
        case actor
        case offer
        case wantSpec = "want_spec"
        case valueBand = "value_band"
        case trustConstraints = "trust_constraints"
        case timeConstraints = "time_constraints"
        case settlementPreferences = "settlement_preferences"
        case status
    }

    public init(
        id: String,
        actor: ActorRef,
        offer: [AssetRef],
        wantSpec: WantSpec? = nil,
        valueBand: ValueBand? = nil,
        trustConstraints: TrustConstraints? = nil,
        timeConstraints: TimeConstraints? = nil,
        settlementPreferences: SettlementPreferences? = nil,
        status: String? = nil
    ) {
        self.id = id
        self.actor = actor
        self.offer = offer
        self.wantSpec = wantSpec
        self.valueBand = valueBand
        self.trustConstraints = trustConstraints
        self.timeConstraints = timeConstraints
        self.settlementPreferences = settlementPreferences
        self.status = status
    }
}

public struct WantSpec: Codable, Sendable, Equatable {
    public let type: String?
    public let anyOf: [CategoryConstraint]?

    enum CodingKeys: String, CodingKey {
        case type
        case anyOf = "any_of"
    }

    public init(type: String? = nil, anyOf: [CategoryConstraint]? = nil) {
        self.type = type
        self.anyOf = anyOf
    }
}

public struct CategoryConstraint: Codable, Sendable, Equatable {
    public let type: String?
    public let platform: String?
    public let appID: Int?
    public let category: String?
    public let constraints: [String: JSONValue]?

    enum CodingKeys: String, CodingKey {
        case type
        case platform
        case appID = "app_id"
        case category
        case constraints
    }

    public init(
        type: String? = nil,
        platform: String? = nil,
        appID: Int? = nil,
        category: String? = nil,
        constraints: [String: JSONValue]? = nil
    ) {
        self.type = type
        self.platform = platform
        self.appID = appID
        self.category = category
        self.constraints = constraints
    }
}

public struct ValueBand: Codable, Sendable, Equatable {
    public let minUSD: Double?
    public let maxUSD: Double?
    public let pricingSource: String?

    enum CodingKeys: String, CodingKey {
        case minUSD = "min_usd"
        case maxUSD = "max_usd"
        case pricingSource = "pricing_source"
    }

    public init(minUSD: Double? = nil, maxUSD: Double? = nil, pricingSource: String? = nil) {
        self.minUSD = minUSD
        self.maxUSD = maxUSD
        self.pricingSource = pricingSource
    }
}

public struct TrustConstraints: Codable, Sendable, Equatable {
    public let maxCycleLength: Int?
    public let minCounterpartyReliability: Double?

    enum CodingKeys: String, CodingKey {
        case maxCycleLength = "max_cycle_length"
        case minCounterpartyReliability = "min_counterparty_reliability"
    }

    public init(maxCycleLength: Int? = nil, minCounterpartyReliability: Double? = nil) {
        self.maxCycleLength = maxCycleLength
        self.minCounterpartyReliability = minCounterpartyReliability
    }
}

public struct TimeConstraints: Codable, Sendable, Equatable {
    public let expiresAt: String?
    public let urgency: String?

    enum CodingKeys: String, CodingKey {
        case expiresAt = "expires_at"
        case urgency
    }

    public init(expiresAt: String? = nil, urgency: String? = nil) {
        self.expiresAt = expiresAt
        self.urgency = urgency
    }
}

public struct SettlementPreferences: Codable, Sendable, Equatable {
    public let requireEscrow: Bool?

    enum CodingKeys: String, CodingKey {
        case requireEscrow = "require_escrow"
    }

    public init(requireEscrow: Bool? = nil) {
        self.requireEscrow = requireEscrow
    }
}

public struct CycleProposal: Codable, Sendable, Equatable {
    public let id: String
    public let expiresAt: String?
    public let participants: [ProposalParticipant]
    public let confidenceScore: Double?
    public let valueSpread: Double?
    public let explainability: [String]?

    enum CodingKeys: String, CodingKey {
        case id
        case expiresAt = "expires_at"
        case participants
        case confidenceScore = "confidence_score"
        case valueSpread = "value_spread"
        case explainability
    }

    public init(
        id: String,
        expiresAt: String? = nil,
        participants: [ProposalParticipant],
        confidenceScore: Double? = nil,
        valueSpread: Double? = nil,
        explainability: [String]? = nil
    ) {
        self.id = id
        self.expiresAt = expiresAt
        self.participants = participants
        self.confidenceScore = confidenceScore
        self.valueSpread = valueSpread
        self.explainability = explainability
    }
}

public struct ProposalParticipant: Codable, Sendable, Equatable {
    public let intentID: String
    public let actor: ActorRef
    public let give: [AssetRef]
    public let get: [AssetRef]

    enum CodingKeys: String, CodingKey {
        case intentID = "intent_id"
        case actor
        case give
        case get
    }

    public init(intentID: String, actor: ActorRef, give: [AssetRef], get: [AssetRef]) {
        self.intentID = intentID
        self.actor = actor
        self.give = give
        self.get = get
    }
}

public struct SettlementTimeline: Codable, Sendable, Equatable {
    public let cycleID: String
    public let state: String
    public let legs: [SettlementLeg]
    public let updatedAt: String

    enum CodingKeys: String, CodingKey {
        case cycleID = "cycle_id"
        case state
        case legs
        case updatedAt = "updated_at"
    }

    public init(cycleID: String, state: String, legs: [SettlementLeg], updatedAt: String) {
        self.cycleID = cycleID
        self.state = state
        self.legs = legs
        self.updatedAt = updatedAt
    }
}

public struct SettlementLeg: Codable, Sendable, Equatable {
    public let legID: String
    public let intentID: String
    public let fromActor: ActorRef
    public let toActor: ActorRef
    public let assets: [AssetRef]
    public let status: String
    public let depositDeadlineAt: String
    public let depositMode: String?
    public let depositRef: String?
    public let depositedAt: String?
    public let releaseRef: String?
    public let releasedAt: String?
    public let refundRef: String?
    public let refundedAt: String?

    enum CodingKeys: String, CodingKey {
        case legID = "leg_id"
        case intentID = "intent_id"
        case fromActor = "from_actor"
        case toActor = "to_actor"
        case assets
        case status
        case depositDeadlineAt = "deposit_deadline_at"
        case depositMode = "deposit_mode"
        case depositRef = "deposit_ref"
        case depositedAt = "deposited_at"
        case releaseRef = "release_ref"
        case releasedAt = "released_at"
        case refundRef = "refund_ref"
        case refundedAt = "refunded_at"
    }

    public init(
        legID: String,
        intentID: String,
        fromActor: ActorRef,
        toActor: ActorRef,
        assets: [AssetRef],
        status: String,
        depositDeadlineAt: String,
        depositMode: String? = nil,
        depositRef: String? = nil,
        depositedAt: String? = nil,
        releaseRef: String? = nil,
        releasedAt: String? = nil,
        refundRef: String? = nil,
        refundedAt: String? = nil
    ) {
        self.legID = legID
        self.intentID = intentID
        self.fromActor = fromActor
        self.toActor = toActor
        self.assets = assets
        self.status = status
        self.depositDeadlineAt = depositDeadlineAt
        self.depositMode = depositMode
        self.depositRef = depositRef
        self.depositedAt = depositedAt
        self.releaseRef = releaseRef
        self.releasedAt = releasedAt
        self.refundRef = refundRef
        self.refundedAt = refundedAt
    }
}

public struct SwapReceiptFee: Codable, Sendable, Equatable {
    public let actor: ActorRef
    public let feeUSD: Double

    enum CodingKeys: String, CodingKey {
        case actor
        case feeUSD = "fee_usd"
    }

    public init(actor: ActorRef, feeUSD: Double) {
        self.actor = actor
        self.feeUSD = feeUSD
    }
}

public struct SwapReceiptLiquidityProviderSummary: Codable, Sendable, Equatable {
    public let provider: JSONValue
    public let participantCount: Int
    public let counterpartyIntentIDs: [String]?

    enum CodingKeys: String, CodingKey {
        case provider
        case participantCount = "participant_count"
        case counterpartyIntentIDs = "counterparty_intent_ids"
    }

    public init(
        provider: JSONValue,
        participantCount: Int,
        counterpartyIntentIDs: [String]? = nil
    ) {
        self.provider = provider
        self.participantCount = participantCount
        self.counterpartyIntentIDs = counterpartyIntentIDs
    }
}

public struct SwapReceiptSignature: Codable, Sendable, Equatable {
    public let keyID: String
    public let alg: String
    public let sig: String

    enum CodingKeys: String, CodingKey {
        case keyID = "key_id"
        case alg
        case sig
    }

    public init(keyID: String, alg: String, sig: String) {
        self.keyID = keyID
        self.alg = alg
        self.sig = sig
    }
}

public struct SwapReceipt: Codable, Sendable, Equatable {
    public let id: String
    public let cycleID: String
    public let finalState: String
    public let intentIDs: [String]
    public let assetIDs: [String]
    public let fees: [SwapReceiptFee]?
    public let liquidityProviderSummary: [SwapReceiptLiquidityProviderSummary]?
    public let createdAt: String
    public let signature: SwapReceiptSignature
    public let transparency: JSONValue?

    enum CodingKeys: String, CodingKey {
        case id
        case cycleID = "cycle_id"
        case finalState = "final_state"
        case intentIDs = "intent_ids"
        case assetIDs = "asset_ids"
        case fees
        case liquidityProviderSummary = "liquidity_provider_summary"
        case createdAt = "created_at"
        case signature
        case transparency
    }

    public init(
        id: String,
        cycleID: String,
        finalState: String,
        intentIDs: [String],
        assetIDs: [String],
        fees: [SwapReceiptFee]? = nil,
        liquidityProviderSummary: [SwapReceiptLiquidityProviderSummary]? = nil,
        createdAt: String,
        signature: SwapReceiptSignature,
        transparency: JSONValue? = nil
    ) {
        self.id = id
        self.cycleID = cycleID
        self.finalState = finalState
        self.intentIDs = intentIDs
        self.assetIDs = assetIDs
        self.fees = fees
        self.liquidityProviderSummary = liquidityProviderSummary
        self.createdAt = createdAt
        self.signature = signature
        self.transparency = transparency
    }
}

public struct CommitView: Codable, Sendable, Equatable {
    public let id: String
    public let cycleID: String
    public let phase: String

    enum CodingKeys: String, CodingKey {
        case id
        case cycleID = "cycle_id"
        case phase
    }

    public init(id: String, cycleID: String, phase: String) {
        self.id = id
        self.cycleID = cycleID
        self.phase = phase
    }
}

public struct HealthResponse: Codable, Sendable, Equatable {
    public let correlationID: String
    public let ok: Bool

    enum CodingKeys: String, CodingKey {
        case correlationID = "correlation_id"
        case ok
    }

    public init(correlationID: String, ok: Bool) {
        self.correlationID = correlationID
        self.ok = ok
    }
}

public struct SwapIntentListResponse: Codable, Sendable, Equatable {
    public let correlationID: String
    public let intents: [SwapIntent]

    enum CodingKeys: String, CodingKey {
        case correlationID = "correlation_id"
        case intents
    }

    public init(correlationID: String, intents: [SwapIntent]) {
        self.correlationID = correlationID
        self.intents = intents
    }
}

public struct CycleProposalListResponse: Codable, Sendable, Equatable {
    public let correlationID: String
    public let proposals: [CycleProposal]

    enum CodingKeys: String, CodingKey {
        case correlationID = "correlation_id"
        case proposals
    }

    public init(correlationID: String, proposals: [CycleProposal]) {
        self.correlationID = correlationID
        self.proposals = proposals
    }
}

public struct CycleProposalGetResponse: Codable, Sendable, Equatable {
    public let correlationID: String
    public let proposal: CycleProposal

    enum CodingKeys: String, CodingKey {
        case correlationID = "correlation_id"
        case proposal
    }

    public init(correlationID: String, proposal: CycleProposal) {
        self.correlationID = correlationID
        self.proposal = proposal
    }
}

public struct SettlementStatusResponse: Codable, Sendable, Equatable {
    public let correlationID: String
    public let timeline: SettlementTimeline

    enum CodingKeys: String, CodingKey {
        case correlationID = "correlation_id"
        case timeline
    }

    public init(correlationID: String, timeline: SettlementTimeline) {
        self.correlationID = correlationID
        self.timeline = timeline
    }
}

public struct SettlementDepositConfirmedResponse: Codable, Sendable, Equatable {
    public let correlationID: String
    public let timeline: SettlementTimeline

    enum CodingKeys: String, CodingKey {
        case correlationID = "correlation_id"
        case timeline
    }

    public init(correlationID: String, timeline: SettlementTimeline) {
        self.correlationID = correlationID
        self.timeline = timeline
    }
}

public struct SettlementBeginExecutionResponse: Codable, Sendable, Equatable {
    public let correlationID: String
    public let timeline: SettlementTimeline

    enum CodingKeys: String, CodingKey {
        case correlationID = "correlation_id"
        case timeline
    }

    public init(correlationID: String, timeline: SettlementTimeline) {
        self.correlationID = correlationID
        self.timeline = timeline
    }
}

public struct SettlementCompleteResponse: Codable, Sendable, Equatable {
    public let correlationID: String
    public let timeline: SettlementTimeline
    public let receipt: SwapReceipt

    enum CodingKeys: String, CodingKey {
        case correlationID = "correlation_id"
        case timeline
        case receipt
    }

    public init(correlationID: String, timeline: SettlementTimeline, receipt: SwapReceipt) {
        self.correlationID = correlationID
        self.timeline = timeline
        self.receipt = receipt
    }
}

public struct ReceiptGetResponse: Codable, Sendable, Equatable {
    public let correlationID: String
    public let receipt: SwapReceipt

    enum CodingKeys: String, CodingKey {
        case correlationID = "correlation_id"
        case receipt
    }

    public init(correlationID: String, receipt: SwapReceipt) {
        self.correlationID = correlationID
        self.receipt = receipt
    }
}

public struct ReceiptShareProjectionResponse: Codable, Sendable, Equatable {
    public let correlationID: String
    public let receiptShare: ReceiptShareProjection

    enum CodingKeys: String, CodingKey {
        case correlationID = "correlation_id"
        case receiptShare = "receipt_share"
    }

    public init(correlationID: String, receiptShare: ReceiptShareProjection) {
        self.correlationID = correlationID
        self.receiptShare = receiptShare
    }
}

public struct ReceiptShareProjection: Codable, Sendable, Equatable {
    public let receiptID: String
    public let cycleID: String
    public let finalState: String
    public let createdAt: String
    public let publicSummary: ReceiptSharePublicSummary
    public let sharePayload: ReceiptSharePayload
    public let privacy: ReceiptSharePrivacy

    enum CodingKeys: String, CodingKey {
        case receiptID = "receipt_id"
        case cycleID = "cycle_id"
        case finalState = "final_state"
        case createdAt = "created_at"
        case publicSummary = "public_summary"
        case sharePayload = "share_payload"
        case privacy
    }

    public init(
        receiptID: String,
        cycleID: String,
        finalState: String,
        createdAt: String,
        publicSummary: ReceiptSharePublicSummary,
        sharePayload: ReceiptSharePayload,
        privacy: ReceiptSharePrivacy
    ) {
        self.receiptID = receiptID
        self.cycleID = cycleID
        self.finalState = finalState
        self.createdAt = createdAt
        self.publicSummary = publicSummary
        self.sharePayload = sharePayload
        self.privacy = privacy
    }
}

public struct ReceiptSharePublicSummary: Codable, Sendable, Equatable {
    public let assetCount: Int
    public let intentCount: Int
    public let finalState: String

    enum CodingKeys: String, CodingKey {
        case assetCount = "asset_count"
        case intentCount = "intent_count"
        case finalState = "final_state"
    }

    public init(assetCount: Int, intentCount: Int, finalState: String) {
        self.assetCount = assetCount
        self.intentCount = intentCount
        self.finalState = finalState
    }
}

public struct ReceiptSharePayload: Codable, Sendable, Equatable {
    public let title: String
    public let subtitle: String
    public let badge: String

    public init(title: String, subtitle: String, badge: String) {
        self.title = title
        self.subtitle = subtitle
        self.badge = badge
    }
}

public struct ReceiptSharePrivacy: Codable, Sendable, Equatable {
    public let defaultMode: String
    public let modes: [String]
    public let redactedFields: [String]
    public let toggleAllowed: Bool

    enum CodingKeys: String, CodingKey {
        case defaultMode = "default_mode"
        case modes
        case redactedFields = "redacted_fields"
        case toggleAllowed = "toggle_allowed"
    }

    public init(defaultMode: String, modes: [String], redactedFields: [String], toggleAllowed: Bool) {
        self.defaultMode = defaultMode
        self.modes = modes
        self.redactedFields = redactedFields
        self.toggleAllowed = toggleAllowed
    }
}

public struct CommitAcceptResponse: Codable, Sendable, Equatable {
    public let correlationID: String
    public let commit: CommitView

    enum CodingKeys: String, CodingKey {
        case correlationID = "correlation_id"
        case commit
    }

    public init(correlationID: String, commit: CommitView) {
        self.correlationID = correlationID
        self.commit = commit
    }
}

public struct CommitAcceptRequest: Codable, Sendable, Equatable {
    public let proposalID: String
    public let occurredAt: String

    enum CodingKeys: String, CodingKey {
        case proposalID = "proposal_id"
        case occurredAt = "occurred_at"
    }

    public init(proposalID: String, occurredAt: String) {
        self.proposalID = proposalID
        self.occurredAt = occurredAt
    }
}

public struct CommitDeclineRequest: Codable, Sendable, Equatable {
    public let proposalID: String
    public let occurredAt: String

    enum CodingKeys: String, CodingKey {
        case proposalID = "proposal_id"
        case occurredAt = "occurred_at"
    }

    public init(proposalID: String, occurredAt: String) {
        self.proposalID = proposalID
        self.occurredAt = occurredAt
    }
}

public struct CommitDeclineResponse: Codable, Sendable, Equatable {
    public let correlationID: String
    public let commit: CommitView

    enum CodingKeys: String, CodingKey {
        case correlationID = "correlation_id"
        case commit
    }

    public init(correlationID: String, commit: CommitView) {
        self.correlationID = correlationID
        self.commit = commit
    }
}

public struct SwapIntentUpsertResponse: Codable, Sendable, Equatable {
    public let correlationID: String
    public let intent: SwapIntent

    enum CodingKeys: String, CodingKey {
        case correlationID = "correlation_id"
        case intent
    }

    public init(correlationID: String, intent: SwapIntent) {
        self.correlationID = correlationID
        self.intent = intent
    }
}

public struct SwapIntentCancelRequest: Codable, Sendable, Equatable {
    public let id: String

    public init(id: String) {
        self.id = id
    }
}

public struct SwapIntentCancelResponse: Codable, Sendable, Equatable {
    public let correlationID: String
    public let id: String
    public let status: String

    enum CodingKeys: String, CodingKey {
        case correlationID = "correlation_id"
        case id
        case status
    }

    public init(correlationID: String, id: String, status: String) {
        self.correlationID = correlationID
        self.id = id
        self.status = status
    }
}

public struct InventoryAwakeningProjectionResponse: Codable, Sendable, Equatable {
    public let correlationID: String
    public let projection: InventoryAwakeningProjection

    enum CodingKeys: String, CodingKey {
        case correlationID = "correlation_id"
        case projection
    }

    public init(correlationID: String, projection: InventoryAwakeningProjection) {
        self.correlationID = correlationID
        self.projection = projection
    }
}

public struct InventoryAwakeningProjection: Codable, Sendable, Equatable {
    public let swappabilitySummary: SwappabilitySummary
    public let recommendedFirstIntents: [InventoryAwakeningRecommendation]

    enum CodingKeys: String, CodingKey {
        case swappabilitySummary = "swappability_summary"
        case recommendedFirstIntents = "recommended_first_intents"
    }

    public init(
        swappabilitySummary: SwappabilitySummary,
        recommendedFirstIntents: [InventoryAwakeningRecommendation]
    ) {
        self.swappabilitySummary = swappabilitySummary
        self.recommendedFirstIntents = recommendedFirstIntents
    }
}

public struct SwappabilitySummary: Codable, Sendable, Equatable {
    public let intentsTotal: Int
    public let activeIntents: Int
    public let cycleOpportunities: Int
    public let averageConfidenceBps: Int

    enum CodingKeys: String, CodingKey {
        case intentsTotal = "intents_total"
        case activeIntents = "active_intents"
        case cycleOpportunities = "cycle_opportunities"
        case averageConfidenceBps = "average_confidence_bps"
    }

    public init(
        intentsTotal: Int,
        activeIntents: Int,
        cycleOpportunities: Int,
        averageConfidenceBps: Int
    ) {
        self.intentsTotal = intentsTotal
        self.activeIntents = activeIntents
        self.cycleOpportunities = cycleOpportunities
        self.averageConfidenceBps = averageConfidenceBps
    }
}

public struct InventoryAwakeningRecommendation: Codable, Sendable, Equatable {
    public let recommendationID: String
    public let cycleID: String
    public let suggestedGiveAssetID: String?
    public let suggestedGetAssetID: String?
    public let confidenceBps: Int
    public let rationale: String

    enum CodingKeys: String, CodingKey {
        case recommendationID = "recommendation_id"
        case cycleID = "cycle_id"
        case suggestedGiveAssetID = "suggested_give_asset_id"
        case suggestedGetAssetID = "suggested_get_asset_id"
        case confidenceBps = "confidence_bps"
        case rationale
    }

    public init(
        recommendationID: String,
        cycleID: String,
        suggestedGiveAssetID: String?,
        suggestedGetAssetID: String?,
        confidenceBps: Int,
        rationale: String
    ) {
        self.recommendationID = recommendationID
        self.cycleID = cycleID
        self.suggestedGiveAssetID = suggestedGiveAssetID
        self.suggestedGetAssetID = suggestedGetAssetID
        self.confidenceBps = confidenceBps
        self.rationale = rationale
    }
}
