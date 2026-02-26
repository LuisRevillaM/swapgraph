import Foundation

public struct DesignTokens: Codable, Sendable, Equatable {
    public let color: [String: String]
    public let typography: TypographyTokens
    public let spacing: SpacingTokens
    public let shadow: [String: String]

    public init(
        color: [String: String],
        typography: TypographyTokens,
        spacing: SpacingTokens,
        shadow: [String: String]
    ) {
        self.color = color
        self.typography = typography
        self.spacing = spacing
        self.shadow = shadow
    }
}

public struct TypographyTokens: Codable, Sendable, Equatable {
    public let families: FontFamilyTokens
    public let scale: [String: TypographyScaleToken]
    public let readabilityFloor: String

    enum CodingKeys: String, CodingKey {
        case families
        case scale
        case readabilityFloor = "readability-floor"
    }

    public init(
        families: FontFamilyTokens,
        scale: [String: TypographyScaleToken],
        readabilityFloor: String
    ) {
        self.families = families
        self.scale = scale
        self.readabilityFloor = readabilityFloor
    }
}

public struct FontFamilyTokens: Codable, Sendable, Equatable {
    public let serif: String
    public let sans: String
    public let mono: String

    public init(serif: String, sans: String, mono: String) {
        self.serif = serif
        self.sans = sans
        self.mono = mono
    }
}

public struct TypographyScaleToken: Codable, Sendable, Equatable {
    public let rem: Double
    public let px: Double
    public let use: String

    public init(rem: Double, px: Double, use: String) {
        self.rem = rem
        self.px = px
        self.use = use
    }
}

public struct SpacingTokens: Codable, Sendable, Equatable {
    public let cardPadding: String
    public let cardRadius: String
    public let cardRadiusSmall: String
    public let gridGap: String
    public let sectionGap: String

    enum CodingKeys: String, CodingKey {
        case cardPadding = "card-padding"
        case cardRadius = "card-radius"
        case cardRadiusSmall = "card-radius-sm"
        case gridGap = "grid-gap"
        case sectionGap = "section-gap"
    }

    public init(
        cardPadding: String,
        cardRadius: String,
        cardRadiusSmall: String,
        gridGap: String,
        sectionGap: String
    ) {
        self.cardPadding = cardPadding
        self.cardRadius = cardRadius
        self.cardRadiusSmall = cardRadiusSmall
        self.gridGap = gridGap
        self.sectionGap = sectionGap
    }
}
