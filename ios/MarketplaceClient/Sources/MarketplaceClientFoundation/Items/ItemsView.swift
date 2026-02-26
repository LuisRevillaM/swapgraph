import SwiftUI

public struct ItemsView: View {
    @ObservedObject private var viewModel: ItemsViewModel
    private let openInbox: () -> Void

    public init(viewModel: ItemsViewModel, openInbox: @escaping () -> Void) {
        self.viewModel = viewModel
        self.openInbox = openInbox
    }

    public var body: some View {
        Group {
            if viewModel.isLoading, viewModel.snapshot == nil {
                FallbackStateView(state: .loading(message: "Loading inventory"))
            } else if let fallbackState = viewModel.fallbackState {
                FallbackStateView(state: fallbackState) {
                    Task { await viewModel.refresh() }
                }
            } else if let snapshot = viewModel.snapshot {
                if snapshot.sections.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        if let staleDataState = viewModel.staleDataState {
                            StaleDataBannerView(state: staleDataState)
                        }
                        FallbackStateView(
                            state: .empty(
                                title: "No tradable items yet",
                                message: snapshot.emptyMessage
                            )
                        )
                    }
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 22) {
                            if let staleDataState = viewModel.staleDataState {
                                StaleDataBannerView(state: staleDataState)
                            }

                            if snapshot.demandBannerCount > 0 {
                                Button {
                                    Task { await viewModel.trackDemandBannerTap() }
                                    openInbox()
                                } label: {
                                    HStack {
                                        Text("\(snapshot.demandBannerCount) proposals waiting")
                                            .font(.marketplace(.label))
                                        Spacer()
                                        Image(systemName: "arrow.right")
                                    }
                                    .foregroundStyle(Color(red: 0.08, green: 0.40, blue: 0.24))
                                    .padding(12)
                                    .frame(maxWidth: .infinity)
                                    .background(Color(red: 0.89, green: 0.95, blue: 0.92))
                                    .clipShape(RoundedRectangle(cornerRadius: 12))
                                }
                                .buttonStyle(.plain)
                                .marketplaceTouchTarget()
                                .accessibilityIdentifier("items.demandBanner")
                                .accessibilityLabel("Open proposal inbox")
                                .accessibilityHint("Shows \(snapshot.demandBannerCount) waiting proposals")
                            }

                            ForEach(snapshot.sections) { section in
                                VStack(alignment: .leading, spacing: 10) {
                                    Text(section.title.uppercased())
                                        .font(.marketplace(.data))
                                        .foregroundStyle(.secondary)

                                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                                        ForEach(section.items) { item in
                                            ItemCardView(item: item)
                                        }
                                    }
                                }
                            }
                        }
                        .padding(16)
                    }
                }
            } else {
                FallbackStateView(state: .loading(message: "Preparing items"))
            }
        }
        .task {
            if viewModel.snapshot == nil, !viewModel.isLoading {
                await viewModel.refresh()
            }
        }
    }
}

public struct ItemCardView: View {
    let item: MarketplaceItemCardModel

    public init(item: MarketplaceItemCardModel) {
        self.item = item
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ZStack(alignment: .topLeading) {
                RoundedRectangle(cornerRadius: 10)
                    .fill(
                        LinearGradient(
                            colors: [
                                Color(red: 0.18, green: 0.18, blue: 0.21),
                                Color(red: 0.10, green: 0.10, blue: 0.13)
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .frame(height: 72)

                Text("\(item.demandCount) wants")
                    .font(.marketplace(.label))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Color.black.opacity(0.25))
                    .clipShape(Capsule())
                    .padding(8)
            }

            Text(item.displayName)
                .font(.marketplace(.itemTitle))
                .foregroundStyle(.primary)
                .lineLimit(2)

            HStack(spacing: 6) {
                metaTag(title: "WEAR", value: item.wearLabel ?? "--")
                metaTag(title: "FLOAT", value: formattedFloat(item.floatValue))
            }

            HStack {
                Text(formattedPrice(item.priceUSD))
                    .font(.marketplace(.data))
                Spacer()
                if let confidence = item.confidenceBps {
                    Text("\(confidence / 100)%")
                        .font(.marketplace(.data))
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(Color(red: 0.91, green: 0.90, blue: 0.87), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.03), radius: 3, x: 0, y: 1)
        .accessibilityElement(children: .combine)
    }

    private func metaTag(title: String, value: String) -> some View {
        HStack(spacing: 4) {
            Text(title)
                .font(.marketplace(.label))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.marketplace(.data))
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
        .background(Color(red: 0.94, green: 0.94, blue: 0.92))
        .clipShape(Capsule())
    }

    private func formattedFloat(_ value: Double?) -> String {
        guard let value else { return "--" }
        return String(format: "%.2f", value)
    }

    private func formattedPrice(_ value: Double?) -> String {
        guard let value else { return "$--" }
        return String(format: "$%.2f", value)
    }
}
