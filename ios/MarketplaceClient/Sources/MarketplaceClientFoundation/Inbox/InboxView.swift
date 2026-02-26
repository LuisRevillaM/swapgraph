import SwiftUI

public struct InboxView: View {
    @ObservedObject private var viewModel: InboxViewModel
    private let selectedProposalID: String?

    public init(viewModel: InboxViewModel, selectedProposalID: String? = nil) {
        self.viewModel = viewModel
        self.selectedProposalID = selectedProposalID
    }

    public var body: some View {
        Group {
            if viewModel.isLoading, viewModel.snapshot == nil {
                FallbackStateView(state: .loading(message: "Loading proposals"))
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
                                title: "No proposals yet",
                                message: "Keep your intents active and proposals will appear here."
                            )
                        )
                    }
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 22) {
                            if let staleDataState = viewModel.staleDataState {
                                StaleDataBannerView(state: staleDataState)
                            }
                            Text("Proposal inbox")
                                .font(.marketplace(.sectionHeading))

                            ForEach(snapshot.sections) { section in
                                VStack(alignment: .leading, spacing: 10) {
                                    Text(section.title.uppercased())
                                        .font(.marketplace(.label))
                                        .foregroundStyle(.secondary)

                                    ForEach(section.rows) { row in
                                        Button {
                                            Task { await viewModel.openProposal(id: row.id) }
                                        } label: {
                                            ProposalInboxRowCard(row: row)
                                        }
                                        .buttonStyle(.plain)
                                        .marketplaceTouchTarget()
                                        .accessibilityIdentifier("inbox.proposal.\(row.id)")
                                        .accessibilityLabel("Review proposal \(row.id)")
                                        .accessibilityHint("Open detailed rationale and accept or decline controls")
                                    }
                                }
                            }
                        }
                        .padding(16)
                    }
                }
            } else {
                FallbackStateView(state: .loading(message: "Preparing inbox"))
            }
        }
        .sheet(item: $viewModel.detailPresentation, onDismiss: {
            viewModel.closeDetail()
        }) { presentation in
            NavigationStack {
                ProposalDetailView(viewModel: presentation.viewModel) {
                    viewModel.closeDetail()
                }
            }
        }
        .task {
            if viewModel.snapshot == nil, !viewModel.isLoading {
                await viewModel.refresh()
            }
        }
        .task(id: selectedProposalID) {
            await viewModel.openIfNeeded(proposalID: selectedProposalID)
        }
    }
}

private struct ProposalInboxRowCard: View {
    let row: ProposalInboxRowModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("GIVE")
                    .font(.marketplace(.label))
                    .foregroundStyle(.secondary)
                Text(row.giveLabel)
                    .font(.marketplace(.body).weight(.semibold))
                    .lineLimit(1)
                Spacer()
                urgencyChip
            }

            Divider()

            HStack {
                Text("GET")
                    .font(.marketplace(.label))
                    .foregroundStyle(.secondary)
                Text(row.getLabel)
                    .font(.marketplace(.body).weight(.semibold))
                    .lineLimit(1)
            }

            HStack(spacing: 8) {
                metaChip(title: "CONF", value: "\(Int((row.confidenceScore * 100).rounded()))%")
                metaChip(title: "DELTA", value: "\(Int((row.valueSpread * 100).rounded()))%")
                metaChip(title: "CYCLE", value: row.participantCount < 3 ? "Direct" : "\(row.participantCount)-way")
                Spacer()
            }
        }
        .padding(12)
        .background(Color.white)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(Color(red: 0.91, green: 0.90, blue: 0.87), lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
    }

    private var urgencyChip: some View {
        let fill: Color
        let ink: Color

        switch row.urgencyBand {
        case .actNow:
            fill = Color(red: 0.98, green: 0.92, blue: 0.91)
            ink = Color(red: 0.63, green: 0.28, blue: 0.25)
        case .highConfidence:
            fill = Color(red: 0.89, green: 0.95, blue: 0.92)
            ink = Color(red: 0.08, green: 0.40, blue: 0.24)
        case .standard:
            fill = Color(red: 0.94, green: 0.94, blue: 0.92)
            ink = Color(red: 0.28, green: 0.28, blue: 0.28)
        }

        return Text(row.statusCue)
            .font(.marketplace(.label))
            .foregroundStyle(ink)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(fill)
            .clipShape(Capsule())
    }

    private func metaChip(title: String, value: String) -> some View {
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
}
