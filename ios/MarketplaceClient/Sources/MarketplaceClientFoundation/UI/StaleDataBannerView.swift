import Foundation
import SwiftUI

public struct StaleDataState: Sendable, Equatable {
    public let message: String
    public let cachedAtLabel: String

    public init(message: String, cachedAtLabel: String) {
        self.message = message
        self.cachedAtLabel = cachedAtLabel
    }

    public static func cachedFallback(
        message: String = "Offline mode: showing last synced data.",
        cachedAtEpochSeconds: Int
    ) -> StaleDataState {
        let date = Date(timeIntervalSince1970: TimeInterval(cachedAtEpochSeconds))
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "MMM d, HH:mm"
        return StaleDataState(message: message, cachedAtLabel: formatter.string(from: date))
    }
}

public struct StaleDataBannerView: View {
    let state: StaleDataState

    public init(state: StaleDataState) {
        self.state = state
    }

    public var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "wifi.slash")
                .font(.marketplace(.body).weight(.semibold))
                .foregroundStyle(Color(red: 0.63, green: 0.28, blue: 0.25))
                .padding(.top, 1)

            VStack(alignment: .leading, spacing: 2) {
                Text("STALE DATA")
                    .font(.marketplace(.label))
                    .foregroundStyle(Color(red: 0.63, green: 0.28, blue: 0.25))
                Text("\(state.message) Last sync \(state.cachedAtLabel).")
                    .font(.marketplace(.body))
                    .foregroundStyle(.primary)
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(Color(red: 0.99, green: 0.93, blue: 0.90))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}
