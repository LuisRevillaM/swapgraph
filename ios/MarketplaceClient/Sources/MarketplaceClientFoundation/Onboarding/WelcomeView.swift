import SwiftUI

public struct WelcomeView: View {
    @ObservedObject private var viewModel: WelcomeViewModel

    public init(viewModel: WelcomeViewModel) {
        self.viewModel = viewModel
    }

    public var body: some View {
        VStack(spacing: 0) {
            header
                .padding(.top, 48)
                .padding(.bottom, 24)

            accountPicker
                .padding(.bottom, 16)

            if let account = viewModel.selectedAccount {
                inventoryPreview(account)
                    .padding(.bottom, 24)
            }

            Spacer()

            enterButton
                .padding(.bottom, 32)
        }
        .padding(.horizontal, 24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.marketplaceSurface)
    }

    private var header: some View {
        VStack(spacing: 10) {
            HStack(spacing: 8) {
                Circle()
                    .fill(Color.marketplacePrimary)
                    .frame(width: 12, height: 12)
                Text("SwapGraph")
                    .font(.marketplace(.label))
                    .foregroundStyle(.secondary)
            }

            Text("Marketplace")
                .font(.marketplace(.sectionHeading))

            Text("Each account has 3 starter items ready to trade. SwapGraph matches trades automatically.")
                .font(.marketplace(.body))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 16)
        }
    }

    private var accountPicker: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Choose an account")
                .font(.marketplace(.label))
                .foregroundStyle(.secondary)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(viewModel.accounts) { account in
                        accountChip(account)
                    }
                }
            }
        }
    }

    private func accountChip(_ account: PilotAccount) -> some View {
        let isSelected = viewModel.selectedAccount?.actorId == account.actorId
        return Button {
            viewModel.selectedAccount = account
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text(account.name)
                    .font(.marketplace(.itemTitle))
                Text(account.tagline)
                    .font(.marketplace(.label))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            .padding(12)
            .frame(width: 160, alignment: .leading)
            .background(isSelected ? Color.marketplacePrimaryLight : Color.white)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .stroke(
                        isSelected ? Color.marketplacePrimary : Color.marketplaceBorder,
                        lineWidth: isSelected ? 2 : 1
                    )
            )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("welcome.account.\(account.actorId)")
        .accessibilityLabel("Enter as \(account.name)")
        .accessibilityHint(account.tagline)
    }

    private func inventoryPreview(_ account: PilotAccount) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("\(account.name)'s starter items")
                .font(.marketplace(.label))
                .foregroundStyle(.secondary)

            ForEach(account.inventory) { item in
                HStack(spacing: 10) {
                    RoundedRectangle(cornerRadius: 8)
                        .fill(
                            LinearGradient(
                                colors: [Color.marketplaceCardGradientStart, Color.marketplaceCardGradientEnd],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )
                        .frame(width: 44, height: 44)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.name)
                            .font(.marketplace(.itemTitle))
                        Text(item.blurb)
                            .font(.marketplace(.label))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.white)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(Color.marketplaceBorder, lineWidth: 1)
                )
            }
        }
    }

    private var enterButton: some View {
        Button {
            viewModel.enter()
        } label: {
            HStack {
                Spacer()
                Text(enterButtonLabel)
                    .font(.marketplace(.body).weight(.semibold))
                Spacer()
            }
            .padding(.vertical, 14)
            .foregroundStyle(.white)
            .background(Color.marketplacePrimary)
            .clipShape(RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
        .disabled(!viewModel.canEnter)
        .opacity(viewModel.canEnter ? 1 : 0.5)
        .marketplaceTouchTarget()
        .accessibilityIdentifier("welcome.enterButton")
        .accessibilityLabel(enterButtonLabel)
    }

    private var enterButtonLabel: String {
        if let account = viewModel.selectedAccount {
            return "Enter as \(account.name)"
        }
        return "Select an account"
    }
}
