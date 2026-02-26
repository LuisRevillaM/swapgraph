import Foundation
import SwiftUI

public struct MarketplaceTypography: Sendable, Equatable {
    public static let readabilityFloorPx: Double = 11.3

    public let familySerif: String
    public let familySans: String
    public let familyMono: String
    public let styles: [TypographyRole: TypographyStyle]

    public init(tokens: DesignTokens) throws {
        self.familySerif = tokens.typography.families.serif
        self.familySans = tokens.typography.families.sans
        self.familyMono = tokens.typography.families.mono

        func scale(_ key: String) throws -> TypographyScaleToken {
            guard let token = tokens.typography.scale[key] else {
                throw MarketplaceDesignSystemError.missingTypographyScale(key)
            }
            return token
        }

        self.styles = [
            .pageTitle: TypographyStyle(
                role: .pageTitle,
                family: familySerif,
                token: try scale("xl"),
                weight: .semibold,
                informational: true
            ),
            .sectionHeading: TypographyStyle(
                role: .sectionHeading,
                family: familySans,
                token: try scale("lg"),
                weight: .semibold,
                informational: true
            ),
            .itemTitle: TypographyStyle(
                role: .itemTitle,
                family: familySans,
                token: try scale("md"),
                weight: .semibold,
                informational: true
            ),
            .body: TypographyStyle(
                role: .body,
                family: familySans,
                token: try scale("base"),
                weight: .regular,
                informational: true
            ),
            .label: TypographyStyle(
                role: .label,
                family: familyMono,
                token: try scale("sm"),
                weight: .semibold,
                informational: true
            ),
            .data: TypographyStyle(
                role: .data,
                family: familyMono,
                token: try scale("data"),
                weight: .medium,
                informational: true
            ),
            .decorativeOverlay: TypographyStyle(
                role: .decorativeOverlay,
                family: familyMono,
                token: try scale("xs"),
                weight: .regular,
                informational: false
            )
        ]
    }

    public func style(for role: TypographyRole) -> TypographyStyle {
        styles[role] ?? TypographyStyle.fallback(role: role)
    }

    public func readabilityAudit() -> ReadabilityAudit {
        var violations: [ReadabilityViolation] = []
        let details = TypographyRole.allCases.map { role -> ReadabilityDetail in
            let style = style(for: role)
            if style.informational && style.sizePx < Self.readabilityFloorPx {
                violations.append(
                    ReadabilityViolation(
                        role: role,
                        sizePx: style.sizePx,
                        floorPx: Self.readabilityFloorPx,
                        message: "Informational text is below readability floor"
                    )
                )
            }
            return ReadabilityDetail(role: role, sizePx: style.sizePx, informational: style.informational)
        }

        return ReadabilityAudit(
            minimumInformationalPx: Self.readabilityFloorPx,
            styleDetails: details,
            violations: violations
        )
    }
}

public enum TypographyRole: String, CaseIterable, Sendable {
    case pageTitle
    case sectionHeading
    case itemTitle
    case body
    case label
    case data
    case decorativeOverlay
}

public struct TypographyStyle: Sendable, Equatable {
    public let role: TypographyRole
    public let family: String
    public let sizePx: Double
    public let weight: Font.Weight
    public let informational: Bool

    init(
        role: TypographyRole,
        family: String,
        token: TypographyScaleToken,
        weight: Font.Weight,
        informational: Bool
    ) {
        self.role = role
        self.family = family
        self.sizePx = token.px
        self.weight = weight
        self.informational = informational
    }

    init(
        role: TypographyRole,
        family: String,
        sizePx: Double,
        weight: Font.Weight,
        informational: Bool
    ) {
        self.role = role
        self.family = family
        self.sizePx = sizePx
        self.weight = weight
        self.informational = informational
    }

    static func fallback(role: TypographyRole) -> TypographyStyle {
        TypographyStyle(
            role: role,
            family: "System",
            sizePx: 12.0,
            weight: .regular,
            informational: true
        )
    }

    public var font: Font {
        Font.custom(family, size: sizePx, relativeTo: role.textStyle).weight(weight)
    }
}

private extension TypographyRole {
    var textStyle: Font.TextStyle {
        switch self {
        case .pageTitle:
            return .title2
        case .sectionHeading:
            return .headline
        case .itemTitle:
            return .headline
        case .body:
            return .body
        case .label:
            return .subheadline
        case .data:
            return .subheadline
        case .decorativeOverlay:
            return .caption2
        }
    }
}

public struct ReadabilityAudit: Sendable, Equatable {
    public let minimumInformationalPx: Double
    public let styleDetails: [ReadabilityDetail]
    public let violations: [ReadabilityViolation]

    public var passes: Bool {
        violations.isEmpty
    }
}

public struct ReadabilityDetail: Sendable, Equatable {
    public let role: TypographyRole
    public let sizePx: Double
    public let informational: Bool
}

public struct ReadabilityViolation: Sendable, Equatable {
    public let role: TypographyRole
    public let sizePx: Double
    public let floorPx: Double
    public let message: String
}

public struct ContrastAudit: Sendable, Equatable {
    public let results: [ContrastResult]

    public var passesAA: Bool {
        results.filter(\.requiredAA).allSatisfy { $0.ratio >= 4.5 }
    }
}

public struct ContrastResult: Sendable, Equatable {
    public let foreground: String
    public let background: String
    public let ratio: Double
    public let requiredAA: Bool
}

public enum ContrastAuditor {
    public static func audit(theme: MarketplaceTheme) throws -> ContrastAudit {
        let pairs: [(String, String, Bool)] = [
            ("ink", "canvas", true),
            ("ink-2", "canvas", true),
            ("ink-3", "canvas", true),
            ("ink-4", "canvas", false)
        ]

        let results = try pairs.map { foreground, background, requiredAA in
            let ratio = try theme.contrastRatio(foreground: foreground, background: background)
            return ContrastResult(
                foreground: foreground,
                background: background,
                ratio: ratio,
                requiredAA: requiredAA
            )
        }

        return ContrastAudit(results: results)
    }
}

public enum MarketplaceTypographyProvider {
    public static let shared: MarketplaceTypography = {
        if let tokens = try? DesignTokenLoader.loadDefaultTokens(),
           let typography = try? MarketplaceTypography(tokens: tokens) {
            return typography
        }

        let fallbackTokens = DesignTokens(
            color: [:],
            typography: TypographyTokens(
                families: FontFamilyTokens(
                    serif: "System",
                    sans: "System",
                    mono: "Menlo"
                ),
                scale: [
                    "xs": TypographyScaleToken(rem: 0.625, px: 10, use: "decorative"),
                    "sm": TypographyScaleToken(rem: 0.70625, px: 11.3, use: "labels"),
                    "data": TypographyScaleToken(rem: 0.7375, px: 11.8, use: "data"),
                    "base": TypographyScaleToken(rem: 0.8, px: 12.8, use: "body"),
                    "md": TypographyScaleToken(rem: 0.89375, px: 14.3, use: "item"),
                    "lg": TypographyScaleToken(rem: 1.03125, px: 16.5, use: "section"),
                    "xl": TypographyScaleToken(rem: 1.125, px: 18, use: "page")
                ],
                readabilityFloor: "11.3px"
            ),
            spacing: SpacingTokens(
                cardPadding: "16px",
                cardRadius: "16px",
                cardRadiusSmall: "12px",
                gridGap: "12px",
                sectionGap: "20px"
            ),
            shadow: [:]
        )
        return try! MarketplaceTypography(tokens: fallbackTokens)
    }()
}

public extension Font {
    static func marketplace(_ role: TypographyRole) -> Font {
        MarketplaceTypographyProvider.shared.style(for: role).font
    }
}
