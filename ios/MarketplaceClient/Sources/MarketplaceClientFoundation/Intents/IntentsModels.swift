import Foundation

public enum WearOption: String, CaseIterable, Codable, Sendable {
    case fn = "FN"
    case mw = "MW"
    case ft = "FT"
    case ww = "WW"
    case bs = "BS"

    public var displayName: String { rawValue }
}

public enum ValueToleranceOption: Int, CaseIterable, Codable, Sendable {
    case usd20 = 20
    case usd50 = 50
    case usd100 = 100
    case usd200 = 200

    public var label: String {
        "± $\(rawValue)"
    }
}

public enum CycleLengthOption: Int, CaseIterable, Codable, Sendable {
    case direct = 2
    case threeWay = 3
    case fourWay = 4

    public var label: String {
        switch self {
        case .direct:
            return "Direct"
        case .threeWay:
            return "3-way"
        case .fourWay:
            return "4-way"
        }
    }
}

public struct IntentComposerDraft: Sendable, Equatable {
    public var offeringAssetID: String
    public var wantQuery: String
    public var acceptableWear: Set<WearOption>
    public var valueTolerance: ValueToleranceOption
    public var cycleLength: CycleLengthOption
    public var urgency: String

    public init(
        offeringAssetID: String = "",
        wantQuery: String = "",
        acceptableWear: Set<WearOption> = [.mw, .ft],
        valueTolerance: ValueToleranceOption = .usd50,
        cycleLength: CycleLengthOption = .threeWay,
        urgency: String = "normal"
    ) {
        self.offeringAssetID = offeringAssetID
        self.wantQuery = wantQuery
        self.acceptableWear = acceptableWear
        self.valueTolerance = valueTolerance
        self.cycleLength = cycleLength
        self.urgency = urgency
    }

    public static func from(intent: SwapIntent) -> IntentComposerDraft {
        let offering = intent.offer.first?.assetID ?? ""
        let category = intent.wantSpec?.anyOf?.first?.category ?? ""

        var wears = Set<WearOption>()
        let constraints = intent.wantSpec?.anyOf?.first?.constraints
        if let wearValues = constraints?["acceptable_wear"] {
            switch wearValues {
            case .array(let values):
                for value in values {
                    if case .string(let stringValue) = value,
                       let wear = WearOption(rawValue: stringValue.uppercased()) {
                        wears.insert(wear)
                    }
                }
            default:
                break
            }
        }

        if wears.isEmpty {
            wears = [.mw, .ft]
        }

        let tolerance = ValueToleranceOption(rawValue: Int(intent.valueBand?.maxUSD ?? 50)) ?? .usd50
        let cycleLength = CycleLengthOption(rawValue: intent.trustConstraints?.maxCycleLength ?? 3) ?? .threeWay

        return IntentComposerDraft(
            offeringAssetID: offering,
            wantQuery: category,
            acceptableWear: wears,
            valueTolerance: tolerance,
            cycleLength: cycleLength,
            urgency: intent.timeConstraints?.urgency ?? "normal"
        )
    }

    public func makeSwapIntent(actorID: String, now: Date, existingID: String? = nil) -> SwapIntent {
        let id = existingID ?? "intent_\(UUID().uuidString.lowercased())"
        let expiresAt = ISO8601DateFormatter().string(from: now.addingTimeInterval(72 * 60 * 60))
        let wearList = acceptableWear
            .map(\.rawValue)
            .sorted()
            .map { JSONValue.string($0) }

        return SwapIntent(
            id: id,
            actor: ActorRef(type: "user", id: actorID),
            offer: [
                AssetRef(
                    platform: "steam",
                    appID: 730,
                    contextID: 2,
                    assetID: offeringAssetID
                )
            ],
            wantSpec: WantSpec(
                type: "set",
                anyOf: [
                    CategoryConstraint(
                        type: "category",
                        platform: "steam",
                        appID: 730,
                        category: wantQuery,
                        constraints: [
                            "acceptable_wear": .array(wearList)
                        ]
                    )
                ]
            ),
            valueBand: ValueBand(
                minUSD: 0,
                maxUSD: Double(valueTolerance.rawValue),
                pricingSource: "market_median"
            ),
            trustConstraints: TrustConstraints(
                maxCycleLength: cycleLength.rawValue,
                minCounterpartyReliability: 0
            ),
            timeConstraints: TimeConstraints(
                expiresAt: expiresAt,
                urgency: urgency
            ),
            settlementPreferences: SettlementPreferences(requireEscrow: true),
            status: "active"
        )
    }
}

public enum IntentComposerValidationIssue: String, Sendable, Equatable, Identifiable {
    case missingOfferingAsset
    case missingWantQuery
    case missingWearSelection

    public var id: String { rawValue }

    public var message: String {
        switch self {
        case .missingOfferingAsset:
            return "Select an offering item"
        case .missingWantQuery:
            return "Enter what you want"
        case .missingWearSelection:
            return "Choose at least one acceptable wear"
        }
    }
}

public enum IntentComposerValidator {
    public static func validate(_ draft: IntentComposerDraft) -> [IntentComposerValidationIssue] {
        var issues: [IntentComposerValidationIssue] = []

        if draft.offeringAssetID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            issues.append(.missingOfferingAsset)
        }

        if draft.wantQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            issues.append(.missingWantQuery)
        }

        if draft.acceptableWear.isEmpty {
            issues.append(.missingWearSelection)
        }

        return issues
    }
}

public enum IntentWatchState: Sendable, Equatable {
    case watchingNoMatches
    case matched(nearMatchCount: Int)
    case cancelled
}

public enum IntentMutationPhase: Sendable, Equatable {
    case idle
    case creating
    case updating
    case cancelling
    case failed
}

public struct IntentRowModel: Identifiable, Sendable, Equatable {
    public let id: String
    public let giveAssetID: String
    public let wantLabel: String
    public let watchState: IntentWatchState
    public let cycleLength: Int
    public let valueTolerance: Int
    public let mutationPhase: IntentMutationPhase

    public init(
        id: String,
        giveAssetID: String,
        wantLabel: String,
        watchState: IntentWatchState,
        cycleLength: Int,
        valueTolerance: Int,
        mutationPhase: IntentMutationPhase
    ) {
        self.id = id
        self.giveAssetID = giveAssetID
        self.wantLabel = wantLabel
        self.watchState = watchState
        self.cycleLength = cycleLength
        self.valueTolerance = valueTolerance
        self.mutationPhase = mutationPhase
    }
}

public struct IntentJourneyEvent: Codable, Sendable, Equatable {
    public let name: String
    public let timestampISO8601: String

    enum CodingKeys: String, CodingKey {
        case name
        case timestampISO8601 = "timestamp_iso8601"
    }

    public init(name: String, timestampISO8601: String) {
        self.name = name
        self.timestampISO8601 = timestampISO8601
    }
}

public struct IntentJourneyTrace: Codable, Sendable, Equatable {
    public let sessionID: String
    public let elapsedSeconds: Double
    public let events: [IntentJourneyEvent]

    enum CodingKeys: String, CodingKey {
        case sessionID = "session_id"
        case elapsedSeconds = "elapsed_seconds"
        case events
    }

    public init(sessionID: String, elapsedSeconds: Double, events: [IntentJourneyEvent]) {
        self.sessionID = sessionID
        self.elapsedSeconds = elapsedSeconds
        self.events = events
    }
}
