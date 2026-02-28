import SwiftUI

public struct ProposalDetailView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var viewModel: ProposalDetailViewModel
    private let onClose: (() -> Void)?

    public init(viewModel: ProposalDetailViewModel, onClose: (() -> Void)? = nil) {
        self.viewModel = viewModel
        self.onClose = onClose
    }

    public var body: some View {
        Group {
            if viewModel.isLoading, viewModel.snapshot == nil {
                FallbackStateView(state: .loading(message: "Loading proposal detail"))
            } else if let fallbackState = viewModel.fallbackState, viewModel.snapshot == nil {
                FallbackStateView(state: fallbackState) {
                    Task { await viewModel.refresh() }
                }
            } else if let snapshot = viewModel.snapshot {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        decisionBanner
                            .accessibilitySortPriority(5)
                        decisionActions
                            .accessibilitySortPriority(4)
                        exchangeHero(snapshot)
                            .accessibilitySortPriority(3)
                        participantFlow(snapshot.participantNodes)
                            .accessibilitySortPriority(2)
                        explainabilitySection(snapshot.explainabilityCards)
                            .accessibilitySortPriority(1)
                    }
                    .padding(16)
                }
                .background(Color.marketplaceSurface)
            } else {
                FallbackStateView(state: .loading(message: "Preparing detail"))
            }
        }
        .navigationTitle("Proposal")
#if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
#endif
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Close") {
                    onClose?()
                    dismiss()
                }
            }
        }
        .task {
            if viewModel.snapshot == nil, !viewModel.isLoading {
                await viewModel.refresh()
            }
        }
    }

    @ViewBuilder
    private var decisionBanner: some View {
        switch viewModel.decisionState {
        case .idle:
            EmptyView()
        case .accepting:
            statusPill(text: "Accepting proposal...", fill: Color.marketplacePrimaryLight, ink: Color.marketplacePrimary)
        case .accepted(let commitID):
            statusPill(text: "Accepted · \(commitID)", fill: Color.marketplacePrimaryLight, ink: Color.marketplacePrimary)
        case .declining:
            statusPill(text: "Declining proposal...", fill: Color.marketplaceDangerLight, ink: Color.marketplaceDanger)
        case .declined(let commitID):
            statusPill(text: "Declined · \(commitID)", fill: Color.marketplaceDangerLight, ink: Color.marketplaceDanger)
        case .failed(let message):
            statusPill(text: message, fill: Color.marketplaceDangerLight, ink: Color.marketplaceDanger)
        }
    }

    private func statusPill(text: String, fill: Color, ink: Color) -> some View {
        Text(text)
            .font(.marketplace(.label))
            .foregroundStyle(ink)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(fill)
            .clipShape(Capsule())
    }

    private func exchangeHero(_ snapshot: ProposalDetailSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("EXCHANGE")
                .font(.marketplace(.label))
                .foregroundStyle(.secondary)

            HStack(spacing: 10) {
                heroCard(title: "GIVE", value: snapshot.giveTitle)
                Image(systemName: "arrow.right")
                    .foregroundStyle(.secondary)
                heroCard(title: "GET", value: snapshot.getTitle)
            }

            HStack(spacing: 8) {
                metaChip(title: "CONF", value: snapshot.confidenceText)
                metaChip(title: "DELTA", value: snapshot.valueDeltaText)
                metaChip(title: "CYCLE", value: snapshot.cycleTypeLabel)
            }
        }
        .padding(14)
        .background(Color.white)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(Color.marketplaceBorder, lineWidth: 1)
        )
    }

    private func heroCard(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.marketplace(.label))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.marketplace(.itemTitle))
                .lineLimit(2)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.marketplaceSurfaceAlt)
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func participantFlow(_ nodes: [ProposalParticipantNodeModel]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("CYCLE FLOW")
                .font(.marketplace(.label))
                .foregroundStyle(.secondary)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(Array(nodes.enumerated()), id: \.element.id) { index, node in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(node.actorLabel)
                                .font(.marketplace(.label))
                            Text("Give: \(node.givesLabel)")
                                .font(.marketplace(.body).weight(.medium))
                                .lineLimit(1)
                            Text("Get: \(node.getsLabel)")
                                .font(.marketplace(.body).weight(.medium))
                                .lineLimit(1)
                        }
                        .padding(10)
                        .background(Color.marketplaceSurfaceAlt)
                        .clipShape(RoundedRectangle(cornerRadius: 10))

                        if index < nodes.count - 1 {
                            Image(systemName: "arrow.right")
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .padding(14)
        .background(Color.white)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(Color.marketplaceBorder, lineWidth: 1)
        )
    }

    private func explainabilitySection(_ cards: [ProposalExplainabilityCardModel]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("WHY THIS PROPOSAL")
                .font(.marketplace(.label))
                .foregroundStyle(.secondary)

            ForEach(cards) { card in
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(card.title.uppercased())
                            .font(.marketplace(.label))
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text(card.valueText)
                            .font(.marketplace(.label))
                    }
                    Text(card.descriptionText)
                        .font(.marketplace(.body))
                        .foregroundStyle(.primary)
                }
                .padding(10)
                .background(Color.marketplaceSurfaceAlt)
                .clipShape(RoundedRectangle(cornerRadius: 10))
            }
        }
        .padding(14)
        .background(Color.white)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(Color.marketplaceBorder, lineWidth: 1)
        )
    }

    private var decisionActions: some View {
        HStack(spacing: 10) {
            Button {
                Task { _ = await viewModel.declineProposal() }
            } label: {
                Text("Decline")
                    .font(.marketplace(.body).weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 11)
                    .foregroundStyle(Color.marketplaceDanger)
                    .background(Color.marketplaceDangerLight)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(.plain)
            .disabled(viewModel.isMutating)
            .marketplaceTouchTarget()
            .accessibilityIdentifier("proposal.decline")
            .accessibilityLabel("Decline swap proposal")
            .accessibilityHint("Decline this proposal and return to inbox")

            Button {
                Task { _ = await viewModel.acceptProposal() }
            } label: {
                Text("Accept swap")
                    .font(.marketplace(.body).weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 11)
                    .foregroundStyle(.white)
                    .background(Color.marketplacePrimary)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(.plain)
            .disabled(viewModel.isMutating)
            .marketplaceTouchTarget()
            .accessibilityIdentifier("proposal.accept")
            .accessibilityLabel("Accept swap proposal")
            .accessibilityHint("Commit to this proposal and begin settlement")
        }
    }

    private func metaChip(title: String, value: String) -> some View {
        HStack(spacing: 4) {
            Text(title)
                .font(.marketplace(.label))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.marketplace(.data))
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 4)
        .background(Color.marketplaceNeutral)
        .clipShape(Capsule())
    }
}
