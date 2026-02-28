import SwiftUI

public struct ItemsView: View {
    @ObservedObject private var viewModel: ItemsViewModel
    private let openInbox: () -> Void
    private let onTradeItem: ((String) -> Void)?
    private let hasActiveIntents: Bool

    public init(viewModel: ItemsViewModel, openInbox: @escaping () -> Void, onTradeItem: ((String) -> Void)? = nil, hasActiveIntents: Bool = false) {
        self.viewModel = viewModel
        self.openInbox = openInbox
        self.onTradeItem = onTradeItem
        self.hasActiveIntents = hasActiveIntents
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

                            if hasActiveIntents {
                                MatchingStatusBannerView()
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
                                    .foregroundStyle(Color.marketplacePrimary)
                                    .padding(12)
                                    .frame(maxWidth: .infinity)
                                    .background(Color.marketplacePrimaryLight)
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
                                            ItemCardView(item: item, onTrade: onTradeItem)
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
    var onTrade: ((String) -> Void)?

    public init(item: MarketplaceItemCardModel, onTrade: ((String) -> Void)? = nil) {
        self.item = item
        self.onTrade = onTrade
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ZStack(alignment: .topLeading) {
                RoundedRectangle(cornerRadius: 10)
                    .fill(
                        LinearGradient(
                            colors: [
                                Color.marketplaceCardGradientStart,
                                Color.marketplaceCardGradientEnd
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

            if let onTrade {
                Button {
                    onTrade(item.assetID)
                } label: {
                    Text("Trade this")
                        .font(.marketplace(.label))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .foregroundStyle(.white)
                        .background(Color.marketplacePrimary)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
                .marketplaceTouchTarget()
                .accessibilityIdentifier("items.tradeThis.\(item.assetID)")
                .accessibilityLabel("Trade \(item.displayName)")
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(Color.marketplaceBorder, lineWidth: 1)
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
        .background(Color.marketplaceNeutral)
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
