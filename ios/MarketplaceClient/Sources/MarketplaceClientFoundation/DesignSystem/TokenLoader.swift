import Foundation

public enum DesignTokenLoader {
    public static func loadDefaultTokens() throws -> DesignTokens {
        guard let url = Bundle.module.url(forResource: "marketplace_design_tokens", withExtension: "json") else {
            throw MarketplaceDesignSystemError.missingTokenResource
        }
        return try loadTokens(from: url)
    }

    public static func loadTokens(from url: URL) throws -> DesignTokens {
        let data = try Data(contentsOf: url)
        let decoder = JSONDecoder()
        return try decoder.decode(DesignTokens.self, from: data)
    }

    public static func canonicalJSON(_ tokens: DesignTokens) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(tokens)
        guard let encoded = String(data: data, encoding: .utf8) else {
            throw MarketplaceDesignSystemError.invalidUTF8
        }
        return encoded
    }
}

public enum MarketplaceDesignSystemError: Error, Equatable {
    case missingTokenResource
    case invalidUTF8
    case missingTypographyScale(String)
    case invalidPixelToken(String)
}
