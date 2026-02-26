import Foundation

public enum MarketplaceClientError: Error, Sendable, Equatable {
    case unauthorized(MarketplaceAPIErrorEnvelope)
    case forbidden(MarketplaceAPIErrorEnvelope)
    case notFound(MarketplaceAPIErrorEnvelope)
    case conflict(MarketplaceAPIErrorEnvelope)
    case validation(MarketplaceAPIErrorEnvelope)
    case server(statusCode: Int, envelope: MarketplaceAPIErrorEnvelope?)
    case transport(description: String)
    case decoding(description: String)
    case badResponse

    public var code: String {
        switch self {
        case .unauthorized(let envelope):
            return envelope.error.code
        case .forbidden(let envelope):
            return envelope.error.code
        case .notFound(let envelope):
            return envelope.error.code
        case .conflict(let envelope):
            return envelope.error.code
        case .validation(let envelope):
            return envelope.error.code
        case .server(_, let envelope):
            return envelope?.error.code ?? "SERVER_ERROR"
        case .transport:
            return "TRANSPORT_ERROR"
        case .decoding:
            return "DECODING_ERROR"
        case .badResponse:
            return "BAD_RESPONSE"
        }
    }

    public var isRetryable: Bool {
        switch self {
        case .transport:
            return true
        case .server(let statusCode, _):
            return [429, 500, 502, 503, 504].contains(statusCode)
        default:
            return false
        }
    }
}
