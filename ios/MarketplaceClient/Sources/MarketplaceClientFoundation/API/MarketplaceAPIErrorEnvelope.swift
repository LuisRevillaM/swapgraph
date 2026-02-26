import Foundation

public struct MarketplaceAPIErrorEnvelope: Error, Codable, Sendable, Equatable {
    public let correlationID: String?
    public let error: MarketplaceAPIErrorBody

    enum CodingKeys: String, CodingKey {
        case correlationID = "correlation_id"
        case error
    }

    public init(correlationID: String?, error: MarketplaceAPIErrorBody) {
        self.correlationID = correlationID
        self.error = error
    }
}

public struct MarketplaceAPIErrorBody: Codable, Sendable, Equatable {
    public let code: String
    public let message: String
    public let details: JSONValue?

    public init(code: String, message: String, details: JSONValue? = nil) {
        self.code = code
        self.message = message
        self.details = details
    }
}
