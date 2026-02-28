import SwiftUI

public struct MatchingStatusBannerView: View {
    @State private var isPulsing = false

    public init() {}

    public var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(Color.marketplacePrimary)
                .frame(width: 8, height: 8)
                .scaleEffect(isPulsing ? 1.3 : 1.0)
                .opacity(isPulsing ? 0.7 : 1.0)
                .animation(
                    .easeInOut(duration: 1.2).repeatForever(autoreverses: true),
                    value: isPulsing
                )

            Text("Always matching")
                .font(.marketplace(.label))
                .foregroundStyle(Color.marketplacePrimary)

            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.marketplacePrimaryLight)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("System matching is active")
        .onAppear { isPulsing = true }
    }
}
