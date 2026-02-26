import SwiftUI

public enum FallbackState: Sendable, Equatable {
    case loading(message: String)
    case empty(title: String, message: String)
    case retryable(title: String, message: String)
    case blocked(title: String, message: String)
    case failure(title: String, message: String)

    public static func from(error: MarketplaceClientError) -> FallbackState {
        switch error {
        case .unauthorized:
            return .blocked(title: "Session expired", message: "Please sign in again.")
        case .forbidden:
            return .blocked(title: "Access denied", message: "You do not have permission for this action.")
        case .notFound:
            return .empty(title: "Not found", message: "The requested resource is no longer available.")
        case .conflict:
            return .retryable(title: "Already processed", message: "This action was already applied. Refresh to continue.")
        case .validation:
            return .failure(title: "Invalid request", message: "Check your inputs and try again.")
        case .server:
            return .retryable(title: "Temporary issue", message: "The server is unavailable. Try again shortly.")
        case .transport:
            return .retryable(title: "Connection issue", message: "Check your network and retry.")
        case .decoding:
            return .failure(title: "Data error", message: "Unexpected response format.")
        case .badResponse:
            return .failure(title: "Unexpected response", message: "Please retry in a moment.")
        }
    }
}

public struct FallbackStateView: View {
    public let state: FallbackState
    public let retryAction: (() -> Void)?

    public init(state: FallbackState, retryAction: (() -> Void)? = nil) {
        self.state = state
        self.retryAction = retryAction
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            switch state {
            case .loading(let message):
                ProgressView(message)
            case .empty(let title, let message),
                 .retryable(let title, let message),
                 .blocked(let title, let message),
                 .failure(let title, let message):
                Text(title)
                    .font(.marketplace(.sectionHeading))
                Text(message)
                    .font(.marketplace(.body))
                    .foregroundStyle(.secondary)
            }

            if case .retryable = state, let retryAction {
                Button("Retry", action: retryAction)
                    .buttonStyle(.borderedProminent)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 14)
                .fill(Color.white)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(Color.gray.opacity(0.2), lineWidth: 1)
        )
    }
}
