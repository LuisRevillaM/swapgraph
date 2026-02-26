import SwiftUI

public struct IntentsView: View {
    @ObservedObject private var viewModel: IntentsViewModel
    @ObservedObject private var notificationPreferencesViewModel: NotificationPreferencesViewModel

    public init(
        viewModel: IntentsViewModel,
        notificationPreferencesViewModel: NotificationPreferencesViewModel = .preview()
    ) {
        self.viewModel = viewModel
        self.notificationPreferencesViewModel = notificationPreferencesViewModel
    }

    public var body: some View {
        Group {
            if viewModel.isLoading, viewModel.rows.isEmpty {
                FallbackStateView(state: .loading(message: "Loading intents"))
            } else if let fallbackState = viewModel.fallbackState {
                FallbackStateView(state: fallbackState) {
                    Task { await viewModel.refresh() }
                }
            } else if viewModel.rows.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    if let staleDataState = viewModel.staleDataState {
                        StaleDataBannerView(state: staleDataState)
                    }
                    FallbackStateView(
                        state: .empty(
                            title: "No standing intents",
                            message: "Post an intent to start matching"
                        )
                    )
                    Button("Post intent") {
                        viewModel.openComposer()
                    }
                    .buttonStyle(.borderedProminent)
                    .marketplaceTouchTarget()
                    .accessibilityIdentifier("intents.empty.postButton")
                }
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 22) {
                        if let staleDataState = viewModel.staleDataState {
                            StaleDataBannerView(state: staleDataState)
                        }
                        actionHeader

                        ForEach(viewModel.rows) { row in
                            IntentRowCard(
                                row: row,
                                onEdit: { viewModel.startEditing(intentID: row.id) },
                                onCancel: {
                                    Task { _ = await viewModel.cancelIntent(id: row.id) }
                                }
                            )
                        }
                    }
                    .padding(16)
                }
            }
        }
        .sheet(isPresented: $viewModel.isComposerPresented) {
            IntentComposerSheet(viewModel: viewModel)
        }
        .task {
            if viewModel.rows.isEmpty, !viewModel.isLoading {
                await viewModel.refresh()
            }
        }
    }

    private var actionHeader: some View {
        HStack {
            Text("Standing intents")
                .font(.marketplace(.sectionHeading))
            Spacer()
            HStack(spacing: 8) {
                alertPreferencesButton
                Button {
                    viewModel.openComposer()
                } label: {
                    Text("Post intent")
                        .font(.marketplace(.label))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 7)
                        .background(Color(red: 0.89, green: 0.95, blue: 0.92))
                        .foregroundStyle(Color(red: 0.08, green: 0.40, blue: 0.24))
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
                .marketplaceTouchTarget()
                .accessibilityIdentifier("intents.postButton")
                .accessibilityLabel("Post intent")
                .accessibilityHint("Opens the intent composer")
            }
        }
    }

    private var alertPreferencesButton: some View {
        Button {
            notificationPreferencesViewModel.open()
        } label: {
            Text("Alerts")
                .font(.marketplace(.label))
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(Color(red: 0.94, green: 0.94, blue: 0.92))
                .foregroundStyle(.primary)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .marketplaceTouchTarget()
        .accessibilityIdentifier("intents.alertPreferencesButton")
        .accessibilityLabel("Alert preferences")
        .accessibilityHint("Manage proposal, active swap, and receipt alert rules")
        .sheet(isPresented: $notificationPreferencesViewModel.isPresented) {
            NotificationPreferencesView(viewModel: notificationPreferencesViewModel)
        }
    }
}

private struct IntentRowCard: View {
    let row: IntentRowModel
    let onEdit: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("GIVE")
                    .font(.marketplace(.label))
                    .foregroundStyle(.secondary)
                Text(row.giveAssetID)
                    .font(.marketplace(.itemTitle))
                    .lineLimit(1)
                Spacer()
                stateChip
            }

            HStack(alignment: .firstTextBaseline) {
                Text("WANT")
                    .font(.marketplace(.label))
                    .foregroundStyle(.secondary)
                Text(row.wantLabel)
                    .font(.marketplace(.body))
                    .lineLimit(2)
            }

            HStack(spacing: 6) {
                metaTag(title: "VALUE", value: "±$\(row.valueTolerance)")
                metaTag(title: "CYCLE", value: "\(row.cycleLength)-way")
                mutationChip
            }

            HStack {
                Button("Edit", action: onEdit)
                    .font(.marketplace(.label))
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .marketplaceTouchTarget()
                    .accessibilityLabel("Edit intent \(row.id)")

                Spacer()

                if row.watchState != .cancelled {
                    Button("Cancel", action: onCancel)
                        .font(.marketplace(.label))
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .tint(Color(red: 0.72, green: 0.26, blue: 0.23))
                        .marketplaceTouchTarget()
                        .accessibilityLabel("Cancel intent \(row.id)")
                }
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

    private var stateChip: some View {
        let text: String
        let fill: Color
        let ink: Color

        switch row.watchState {
        case .watchingNoMatches:
            text = "Watching · no matches"
            fill = Color(red: 0.95, green: 0.95, blue: 0.93)
            ink = Color(red: 0.29, green: 0.29, blue: 0.29)
        case .matched(let nearMatchCount):
            text = "Watching · \(nearMatchCount) near"
            fill = Color(red: 0.89, green: 0.95, blue: 0.92)
            ink = Color(red: 0.08, green: 0.40, blue: 0.24)
        case .cancelled:
            text = "Cancelled"
            fill = Color(red: 0.98, green: 0.92, blue: 0.91)
            ink = Color(red: 0.63, green: 0.28, blue: 0.25)
        }

        return Text(text)
            .font(.marketplace(.label))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .foregroundStyle(ink)
            .background(fill)
            .clipShape(Capsule())
    }

    private var mutationChip: some View {
        let text: String
        switch row.mutationPhase {
        case .idle:
            text = "READY"
        case .creating:
            text = "CREATING"
        case .updating:
            text = "UPDATING"
        case .cancelling:
            text = "CANCELLING"
        case .failed:
            text = "RETRY"
        }

        return Text(text)
            .font(.marketplace(.label))
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
            .background(Color(red: 0.94, green: 0.94, blue: 0.92))
            .clipShape(Capsule())
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
}

private struct IntentComposerSheet: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var viewModel: IntentsViewModel

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    labeledField(
                        title: "Offering asset ID",
                        prompt: "asset_123",
                        text: $viewModel.composerDraft.offeringAssetID
                    )

                    labeledField(
                        title: "Want",
                        prompt: "knife, gloves, or category",
                        text: $viewModel.composerDraft.wantQuery
                    )

                    VStack(alignment: .leading, spacing: 8) {
                        Text("Acceptable wear")
                            .font(.marketplace(.label))
                            .foregroundStyle(.secondary)
                        wearTags
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Text("Value tolerance")
                            .font(.marketplace(.label))
                            .foregroundStyle(.secondary)
                        Picker("Value tolerance", selection: $viewModel.composerDraft.valueTolerance) {
                            ForEach(ValueToleranceOption.allCases, id: \.self) { option in
                                Text(option.label).tag(option)
                            }
                        }
                        .pickerStyle(.segmented)
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Text("Max cycle length")
                            .font(.marketplace(.label))
                            .foregroundStyle(.secondary)
                        Picker("Cycle length", selection: $viewModel.composerDraft.cycleLength) {
                            ForEach(CycleLengthOption.allCases, id: \.self) { option in
                                Text(option.label).tag(option)
                            }
                        }
                        .pickerStyle(.segmented)
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Text("Urgency")
                            .font(.marketplace(.label))
                            .foregroundStyle(.secondary)

                        Picker("Urgency", selection: $viewModel.composerDraft.urgency) {
                            Text("Normal").tag("normal")
                            Text("High").tag("high")
                        }
                        .pickerStyle(.segmented)
                    }

                    if !viewModel.composerIssues.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(viewModel.composerIssues) { issue in
                                Text("• \(issue.message)")
                                    .font(.marketplace(.body).weight(.medium))
                                    .foregroundStyle(Color(red: 0.63, green: 0.28, blue: 0.25))
                            }
                        }
                        .padding(10)
                        .background(Color(red: 0.98, green: 0.92, blue: 0.91))
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    }

                    Button {
                        Task {
                            let ok = await viewModel.submitComposer()
                            if ok {
                                dismiss()
                            }
                        }
                    } label: {
                        HStack {
                            Spacer()
                            Text(viewModel.editingIntentID == nil ? "Create intent" : "Save changes")
                                .font(.marketplace(.body).weight(.semibold))
                            Spacer()
                        }
                        .padding(.vertical, 12)
                        .foregroundStyle(.white)
                        .background(Color(red: 0.08, green: 0.40, blue: 0.24))
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                    .buttonStyle(.plain)
                    .marketplaceTouchTarget()
                    .accessibilityIdentifier("intents.composer.submit")
                }
                .padding(16)
            }
            .background(Color(red: 0.97, green: 0.97, blue: 0.96))
            .navigationTitle(viewModel.editingIntentID == nil ? "Post intent" : "Edit intent")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") {
                        viewModel.dismissComposer()
                        dismiss()
                    }
                }
            }
        }
    }

    private var wearTags: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 54))], alignment: .leading, spacing: 8) {
            ForEach(WearOption.allCases, id: \.self) { wear in
                let selected = viewModel.composerDraft.acceptableWear.contains(wear)

                Button {
                    if selected {
                        viewModel.composerDraft.acceptableWear.remove(wear)
                    } else {
                        viewModel.composerDraft.acceptableWear.insert(wear)
                    }
                } label: {
                    Text(wear.displayName)
                        .font(.marketplace(.label))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .foregroundStyle(selected ? .white : .primary)
                        .background(
                            selected
                            ? Color(red: 0.08, green: 0.40, blue: 0.24)
                            : Color(red: 0.94, green: 0.94, blue: 0.92)
                        )
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func labeledField(title: String, prompt: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.marketplace(.label))
                .foregroundStyle(.secondary)
            TextField(prompt, text: text)
                .textFieldStyle(.roundedBorder)
                .font(.marketplace(.body))
        }
    }
}
