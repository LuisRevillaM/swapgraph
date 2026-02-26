import SwiftUI

public struct ReceiptsView: View {
    @ObservedObject private var viewModel: ReceiptsViewModel
    private let selectedCycleID: String?

    public init(viewModel: ReceiptsViewModel, selectedCycleID: String? = nil) {
        self.viewModel = viewModel
        self.selectedCycleID = selectedCycleID
    }

    public var body: some View {
        Group {
            if viewModel.isLoading, viewModel.snapshot == nil {
                FallbackStateView(state: .loading(message: "Loading receipts"))
            } else if let fallbackState = viewModel.fallbackState, viewModel.snapshot == nil {
                FallbackStateView(state: fallbackState) {
                    Task { await viewModel.refresh(selectedCycleID: selectedCycleID) }
                }
            } else if let snapshot = viewModel.snapshot {
                if snapshot.rows.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        if let staleDataState = viewModel.staleDataState {
                            StaleDataBannerView(state: staleDataState)
                        }
                        FallbackStateView(
                            state: .empty(
                                title: "No receipts yet",
                                message: "Completed or unwound cycles will appear here."
                            )
                        )
                    }
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 18) {
                            if let staleDataState = viewModel.staleDataState {
                                StaleDataBannerView(state: staleDataState)
                            }
                            Text("Settlement receipts")
                                .font(.marketplace(.sectionHeading))

                            ForEach(snapshot.rows) { row in
                                Button {
                                    Task { await viewModel.openReceipt(cycleID: row.cycleID) }
                                } label: {
                                    ReceiptRowCard(row: row)
                                }
                                .buttonStyle(.plain)
                                .marketplaceTouchTarget()
                                .accessibilityIdentifier("receipts.row.\(row.cycleID)")
                                .accessibilityLabel("Open receipt \(row.cycleID)")
                                .accessibilityHint("Shows verification and settlement metadata")
                            }
                        }
                        .padding(16)
                    }
                    .background(Color(red: 0.97, green: 0.97, blue: 0.96))
                }
            } else {
                FallbackStateView(state: .loading(message: "Preparing receipts"))
            }
        }
        .sheet(item: $viewModel.detailPresentation, onDismiss: {
            viewModel.closeDetail()
        }) { presentation in
            NavigationStack {
                ReceiptDetailView(snapshot: presentation.snapshot) {
                    viewModel.closeDetail()
                }
            }
        }
        .task {
            if viewModel.snapshot == nil, !viewModel.isLoading {
                await viewModel.refresh(selectedCycleID: selectedCycleID)
            }
        }
        .task(id: selectedCycleID) {
            await viewModel.openIfNeeded(cycleID: selectedCycleID)
        }
    }
}

private struct ReceiptRowCard: View {
    let row: ReceiptListRowModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: row.outcome.symbolName)
                    .foregroundStyle(outcomeColor(row.outcome))
                    .font(.marketplace(.sectionHeading))

                Text(row.flowTitle)
                    .font(.marketplace(.itemTitle))
                    .foregroundStyle(.primary)
                    .lineLimit(1)

                Spacer()

                Text(row.dateLabel)
                    .font(.marketplace(.data))
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 8) {
                metadataChip(title: "TYPE", value: row.typeLabel)
                metadataChip(title: "VERIFY", value: row.verificationLabel)
                metadataChip(title: "DELTA", value: row.valueDeltaLabel)
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

    private func outcomeColor(_ outcome: ReceiptOutcomeKind) -> Color {
        switch outcome {
        case .completed:
            return Color(red: 0.08, green: 0.40, blue: 0.24)
        case .failed:
            return Color(red: 0.63, green: 0.28, blue: 0.25)
        case .unwound:
            return Color(red: 0.69, green: 0.48, blue: 0.10)
        }
    }

    private func metadataChip(title: String, value: String) -> some View {
        HStack(spacing: 4) {
            Text(title)
                .font(.marketplace(.label))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.marketplace(.data))
                .lineLimit(1)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
        .background(Color(red: 0.94, green: 0.94, blue: 0.92))
        .clipShape(Capsule())
    }
}

private struct ReceiptDetailView: View {
    let snapshot: ReceiptDetailSnapshot
    let close: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                headerCard
                metadataCard
                verificationCard
                if let shareContext = snapshot.shareContext {
                    shareCard(shareContext)
                }
            }
            .padding(16)
        }
        .background(Color(red: 0.97, green: 0.97, blue: 0.96))
        .navigationTitle("Receipt")
        .toolbar {
            ToolbarItem(placement: .automatic) {
                Button("Done", action: close)
            }
        }
        .accessibilityIdentifier("receipts.detail.\(snapshot.receiptID)")
    }

    private var headerCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: snapshot.outcome.symbolName)
                    .foregroundStyle(outcomeColor(snapshot.outcome))
                Text(snapshot.typeLabel.uppercased())
                    .font(.marketplace(.label))
                    .foregroundStyle(.secondary)
                Spacer()
                Text(snapshot.dateLabel)
                    .font(.marketplace(.data))
                    .foregroundStyle(.secondary)
            }

            Text(snapshot.flowTitle)
                .font(.marketplace(.sectionHeading))

            Text("Cycle \(snapshot.cycleID)")
                .font(.marketplace(.body))
                .foregroundStyle(.secondary)
        }
        .padding(14)
        .background(Color.white)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(Color(red: 0.91, green: 0.90, blue: 0.87), lineWidth: 1)
        )
    }

    private var metadataCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("METADATA")
                .font(.marketplace(.label))
                .foregroundStyle(.secondary)

            detailRow(title: "Type", value: snapshot.typeLabel)
            detailRow(title: "Verification", value: snapshot.verificationLabel)
            detailRow(title: "Value delta", value: snapshot.valueDeltaLabel)
            detailRow(title: "Intents", value: snapshot.intentCountLabel)
            detailRow(title: "Assets", value: snapshot.assetCountLabel)
        }
        .padding(14)
        .background(Color.white)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(Color(red: 0.91, green: 0.90, blue: 0.87), lineWidth: 1)
        )
    }

    private var verificationCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("CRYPTO VERIFICATION")
                .font(.marketplace(.label))
                .foregroundStyle(.secondary)

            detailRow(title: "Key", value: snapshot.signatureKeyID)
            detailRow(title: "Algorithm", value: snapshot.signatureAlgorithm)
            detailRow(title: "Signature", value: snapshot.signaturePreview)
        }
        .padding(14)
        .background(Color.white)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(Color(red: 0.91, green: 0.90, blue: 0.87), lineWidth: 1)
        )
    }

    private func shareCard(_ context: ReceiptShareContextModel) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("SHARE PROOF")
                .font(.marketplace(.label))
                .foregroundStyle(.secondary)

            Text(context.shareTitle)
                .font(.marketplace(.body).weight(.semibold))
            Text(context.shareSubtitle)
                .font(.marketplace(.body))
                .foregroundStyle(.secondary)

            detailRow(title: "Badge", value: context.badge)
            detailRow(title: "Public summary", value: context.publicSummary)
            detailRow(title: "Privacy", value: context.privacyMode)
            detailRow(title: "Redactions", value: context.redactionSummary)
        }
        .padding(14)
        .background(Color.white)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(Color(red: 0.91, green: 0.90, blue: 0.87), lineWidth: 1)
        )
    }

    private func detailRow(title: String, value: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(title.uppercased())
                .font(.marketplace(.label))
                .foregroundStyle(.secondary)
                .frame(width: 98, alignment: .leading)
            Text(value)
                .font(.marketplace(.body))
                .foregroundStyle(.primary)
            Spacer(minLength: 0)
        }
    }

    private func outcomeColor(_ outcome: ReceiptOutcomeKind) -> Color {
        switch outcome {
        case .completed:
            return Color(red: 0.08, green: 0.40, blue: 0.24)
        case .failed:
            return Color(red: 0.63, green: 0.28, blue: 0.25)
        case .unwound:
            return Color(red: 0.69, green: 0.48, blue: 0.10)
        }
    }
}
