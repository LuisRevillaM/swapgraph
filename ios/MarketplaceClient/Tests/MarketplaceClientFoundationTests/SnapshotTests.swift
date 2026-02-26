import Foundation
import XCTest
@testable import MarketplaceClientFoundation

final class SnapshotTests: XCTestCase {
    struct ThemeSnapshot: Codable, Equatable {
        let colors: [String: String]
        let spacing: SpacingSnapshot
        let typography: [String: Double]
    }

    struct SpacingSnapshot: Codable, Equatable {
        let cardPadding: Double
        let cardRadius: Double
        let cardRadiusSmall: Double
        let gridGap: Double
        let sectionGap: Double
    }

    func testThemeSnapshotMatchesBaseline() throws {
        let expectedURL = try XCTUnwrap(Bundle.module.url(forResource: "theme_snapshot", withExtension: "json"))
        let expectedData = try Data(contentsOf: expectedURL)
        let expected = try JSONDecoder().decode(ThemeSnapshot.self, from: expectedData)

        let tokens = try DesignTokenLoader.loadDefaultTokens()
        let theme = try MarketplaceTheme(tokens: tokens)
        let typography = try MarketplaceTypography(tokens: tokens)

        let actual = ThemeSnapshot(
            colors: tokens.color,
            spacing: SpacingSnapshot(
                cardPadding: Double(theme.spacing.cardPadding),
                cardRadius: Double(theme.spacing.cardRadius),
                cardRadiusSmall: Double(theme.spacing.cardRadiusSmall),
                gridGap: Double(theme.spacing.gridGap),
                sectionGap: Double(theme.spacing.sectionGap)
            ),
            typography: Dictionary(uniqueKeysWithValues: TypographyRole.allCases.map { role in
                (role.rawValue, typography.style(for: role).sizePx)
            })
        )

        XCTAssertEqual(actual, expected)
    }
}
