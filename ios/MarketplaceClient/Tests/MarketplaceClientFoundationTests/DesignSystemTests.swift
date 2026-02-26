import XCTest
@testable import MarketplaceClientFoundation

final class DesignSystemTests: XCTestCase {
    func testLoadsDesignTokensAndMapsTheme() throws {
        let tokens = try DesignTokenLoader.loadDefaultTokens()
        let theme = try MarketplaceTheme(tokens: tokens)
        let typography = try MarketplaceTypography(tokens: tokens)

        XCTAssertEqual(tokens.color["canvas"], "#F8F7F4")
        XCTAssertEqual(tokens.typography.families.serif, "Fraunces")
        XCTAssertEqual(theme.spacing.cardPadding, 16)
        XCTAssertEqual(typography.style(for: .body).sizePx, 12.8, accuracy: 0.01)
    }

    func testReadabilityFloorAndContrastPass() throws {
        let tokens = try DesignTokenLoader.loadDefaultTokens()
        let theme = try MarketplaceTheme(tokens: tokens)
        let typography = try MarketplaceTypography(tokens: tokens)

        let readability = typography.readabilityAudit()
        XCTAssertTrue(readability.passes)

        let contrast = try ContrastAuditor.audit(theme: theme)
        XCTAssertTrue(contrast.passesAA)

        let ink3 = contrast.results.first(where: { $0.foreground == "ink-3" })
        XCTAssertNotNil(ink3)
        XCTAssertGreaterThanOrEqual(ink3?.ratio ?? 0, 4.5)
    }
}
