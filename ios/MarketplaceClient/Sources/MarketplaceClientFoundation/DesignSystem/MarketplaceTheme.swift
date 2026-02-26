import Foundation
import SwiftUI

public struct MarketplaceTheme: Sendable, Equatable {
    public let tokens: DesignTokens
    public let palette: Palette
    public let spacing: Spacing
    public let shadows: ShadowTokens

    public init(tokens: DesignTokens) throws {
        self.tokens = tokens
        self.palette = try Palette(tokens: tokens)
        self.spacing = try Spacing(tokens: tokens)
        self.shadows = ShadowTokens(tokens: tokens)
    }

    public static func `default`() throws -> MarketplaceTheme {
        try MarketplaceTheme(tokens: DesignTokenLoader.loadDefaultTokens())
    }

    public func contrastRatio(foreground: String, background: String) throws -> Double {
        let fg = try palette.color(for: foreground)
        let bg = try palette.color(for: background)
        return ColorToken.contrastRatio(foreground: fg, background: bg)
    }
}

public struct Palette: Sendable, Equatable {
    private let colors: [String: ColorToken]

    init(tokens: DesignTokens) throws {
        var map: [String: ColorToken] = [:]
        for (key, value) in tokens.color {
            map[key] = try ColorToken(hex: value)
        }
        self.colors = map
    }

    public func color(for name: String) throws -> ColorToken {
        guard let color = colors[name] else {
            throw MarketplaceDesignSystemError.invalidPixelToken("missing color token: \(name)")
        }
        return color
    }

    public subscript(_ name: String) -> ColorToken? {
        colors[name]
    }
}

public struct Spacing: Sendable, Equatable {
    public let cardPadding: CGFloat
    public let cardRadius: CGFloat
    public let cardRadiusSmall: CGFloat
    public let gridGap: CGFloat
    public let sectionGap: CGFloat

    init(tokens: DesignTokens) throws {
        self.cardPadding = try Spacing.parsePx(tokens.spacing.cardPadding)
        self.cardRadius = try Spacing.parsePx(tokens.spacing.cardRadius)
        self.cardRadiusSmall = try Spacing.parsePx(tokens.spacing.cardRadiusSmall)
        self.gridGap = try Spacing.parsePx(tokens.spacing.gridGap)
        self.sectionGap = try Spacing.parsePx(tokens.spacing.sectionGap)
    }

    private static func parsePx(_ value: String) throws -> CGFloat {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let numeric = trimmed.replacingOccurrences(of: "px", with: "")
        guard let parsed = Double(numeric) else {
            throw MarketplaceDesignSystemError.invalidPixelToken(value)
        }
        return CGFloat(parsed)
    }
}

public struct ShadowTokens: Sendable, Equatable {
    public let small: String
    public let medium: String
    public let large: String

    init(tokens: DesignTokens) {
        self.small = tokens.shadow["sm"] ?? ""
        self.medium = tokens.shadow["md"] ?? ""
        self.large = tokens.shadow["lg"] ?? ""
    }
}

public struct ColorToken: Sendable, Equatable {
    public let hex: String
    public let red: Double
    public let green: Double
    public let blue: Double

    public init(hex: String) throws {
        let cleaned = hex.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard cleaned.hasPrefix("#"), cleaned.count == 7 else {
            throw MarketplaceDesignSystemError.invalidPixelToken(hex)
        }

        let r = String(cleaned.dropFirst().prefix(2))
        let g = String(cleaned.dropFirst(3).prefix(2))
        let b = String(cleaned.dropFirst(5).prefix(2))

        guard
            let redValue = UInt8(r, radix: 16),
            let greenValue = UInt8(g, radix: 16),
            let blueValue = UInt8(b, radix: 16)
        else {
            throw MarketplaceDesignSystemError.invalidPixelToken(hex)
        }

        self.hex = cleaned
        self.red = Double(redValue) / 255.0
        self.green = Double(greenValue) / 255.0
        self.blue = Double(blueValue) / 255.0
    }

    public var swiftUIColor: Color {
        Color(red: red, green: green, blue: blue)
    }

    public var relativeLuminance: Double {
        func channel(_ value: Double) -> Double {
            if value <= 0.03928 {
                return value / 12.92
            }
            return pow((value + 0.055) / 1.055, 2.4)
        }

        let r = channel(red)
        let g = channel(green)
        let b = channel(blue)
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }

    public static func contrastRatio(foreground: ColorToken, background: ColorToken) -> Double {
        let l1 = foreground.relativeLuminance
        let l2 = background.relativeLuminance
        let lighter = max(l1, l2)
        let darker = min(l1, l2)
        return (lighter + 0.05) / (darker + 0.05)
    }
}
