import SwiftUI

public struct ActiveView: View {
    @ObservedObject private var viewModel: ActiveViewModel
    private let selectedCycleID: String?
    private let openReceipt: ((String) -> Void)?

    public init(
        viewModel: ActiveViewModel,
        selectedCycleID: String? = nil,
        openReceipt: ((String) -> Void)? = nil
    ) {
        self.viewModel = viewModel
        self.selectedCycleID = selectedCycleID
        self.openReceipt = openReceipt
    }

    public var body: some View {
        Group {
            if viewModel.isLoading, viewModel.snapshot == nil {
                FallbackStateView(state: .loading(message: "Loading active swap"))
            } else if let fallbackState = viewModel.fallbackState, viewModel.snapshot == nil {
                FallbackStateView(state: fallbackState) {
                    Task { await viewModel.refresh() }
                }
            } else if let snapshot = viewModel.snapshot {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        if let staleDataState = viewModel.staleDataState {
                            StaleDataBannerView(state: staleDataState)
                                .accessibilitySortPriority(5)
                        }
                        headerCard(snapshot.header)
                            .accessibilitySortPriority(4)
                        if let waitReason = snapshot.waitReason {
                            waitReasonCard(waitReason)
                                .accessibilitySortPriority(3)
                        }
                        if let action = snapshot.primaryAction {
                            primaryActionCard(action: action, cycleID: snapshot.cycleID)
                                .accessibilitySortPriority(2)
                        }
                        timelineCard(events: snapshot.timelineEvents)
                            .accessibilitySortPriority(1)
                    }
                    .padding(16)
                }
                .background(Color(red: 0.97, green: 0.97, blue: 0.96))
            } else {
                FallbackStateView(state: .loading(message: "Preparing active timeline"))
            }
        }
        .task(id: selectedCycleID) {
            await viewModel.openCycle(cycleID: selectedCycleID)
        }
    }

    private func headerCard(_ header: ActiveProgressHeaderModel) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Circle()
                    .fill(Color(red: 0.08, green: 0.40, blue: 0.24))
                    .frame(width: 8, height: 8)
                Text(header.stateLabel.uppercased())
                    .font(.marketplace(.label))
                    .foregroundStyle(.secondary)
                Spacer()
                Text(header.cycleID)
                    .font(.marketplace(.data))
                    .foregroundStyle(.secondary)
            }

            Text(header.headline)
                .font(.marketplace(.sectionHeading))
                .foregroundStyle(.primary)

            Text(header.detail)
                .font(.marketplace(.body))
                .foregroundStyle(.secondary)

            ProgressView(value: header.progressFraction)
                .tint(Color(red: 0.08, green: 0.40, blue: 0.24))

            Text("Progress \(header.completedSteps)/\(header.totalSteps)")
                .font(.marketplace(.data))
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

    private func waitReasonCard(_ reason: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("WAIT REASON")
                .font(.marketplace(.label))
                .foregroundStyle(.secondary)
            Text(reason)
                .font(.marketplace(.body))
                .foregroundStyle(.primary)
        }
        .padding(12)
        .background(Color(red: 0.99, green: 0.96, blue: 0.90))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private func primaryActionCard(action: ActiveActionModel, cycleID: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("NEXT ACTION")
                .font(.marketplace(.label))
                .foregroundStyle(.secondary)

            Button {
                let actionKind = action.kind
                Task {
                    let succeeded = await viewModel.performPrimaryAction()
                    guard succeeded else { return }
                    guard actionKind == .openReceipt else { return }
                    openReceipt?(cycleID)
                }
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(action.title)
                        .font(.marketplace(.body).weight(.semibold))
                    Text(action.subtitle)
                        .font(.marketplace(.body))
                }
                .foregroundStyle(action.isEnabled ? Color.white : Color(red: 0.45, green: 0.45, blue: 0.43))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 10)
                .padding(.horizontal, 12)
                .background(
                    action.isEnabled
                        ? Color(red: 0.08, green: 0.40, blue: 0.24)
                        : Color(red: 0.94, green: 0.94, blue: 0.92)
                )
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(.plain)
            .disabled(!action.isEnabled || viewModel.isMutating)
            .marketplaceTouchTarget()
            .accessibilityIdentifier("active.primaryAction.\(action.kind.rawValue)")
            .accessibilityLabel(action.title)
            .accessibilityHint(action.subtitle)

            if let reason = action.disabledReason, !action.isEnabled {
                Text(reason)
                    .font(.marketplace(.body))
                    .foregroundStyle(Color(red: 0.63, green: 0.28, blue: 0.25))
            }
        }
        .padding(14)
        .background(Color.white)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(Color(red: 0.91, green: 0.90, blue: 0.87), lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
    }

    private func timelineCard(events: [ActiveTimelineEventModel]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("SETTLEMENT TIMELINE")
                .font(.marketplace(.label))
                .foregroundStyle(.secondary)

            ForEach(events) { event in
                HStack(alignment: .top, spacing: 10) {
                    Circle()
                        .fill(markerColor(event.marker))
                        .frame(width: 9, height: 9)
                        .padding(.top, 5)

                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text(event.title)
                                .font(.marketplace(.body).weight(.semibold))
                                .foregroundStyle(.primary)
                            Spacer()
                            Text(event.timestampLabel)
                                .font(.marketplace(.data))
                                .foregroundStyle(.secondary)
                        }

                        Text(event.description)
                            .font(.marketplace(.body))
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(10)
                .background(Color(red: 0.97, green: 0.97, blue: 0.95))
                .clipShape(RoundedRectangle(cornerRadius: 10))
            }
        }
        .padding(14)
        .background(Color.white)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(Color(red: 0.91, green: 0.90, blue: 0.87), lineWidth: 1)
        )
    }

    private func markerColor(_ marker: ActiveTimelineMarker) -> Color {
        switch marker {
        case .completed:
            return Color(red: 0.08, green: 0.40, blue: 0.24)
        case .active:
            return Color(red: 0.69, green: 0.48, blue: 0.10)
        case .pending:
            return Color(red: 0.72, green: 0.72, blue: 0.70)
        }
    }
}
