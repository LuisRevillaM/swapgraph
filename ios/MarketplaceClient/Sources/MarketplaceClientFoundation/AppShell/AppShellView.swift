import SwiftUI

public struct AppShellView: View {
    @ObservedObject private var viewModel: AppShellViewModel
    @ObservedObject private var itemsViewModel: ItemsViewModel
    @ObservedObject private var intentsViewModel: IntentsViewModel
    @ObservedObject private var notificationPreferencesViewModel: NotificationPreferencesViewModel
    @ObservedObject private var inboxViewModel: InboxViewModel
    @ObservedObject private var activeViewModel: ActiveViewModel
    @ObservedObject private var receiptsViewModel: ReceiptsViewModel

    public init(
        viewModel: AppShellViewModel,
        itemsViewModel: ItemsViewModel = .preview(),
        intentsViewModel: IntentsViewModel = .preview(),
        notificationPreferencesViewModel: NotificationPreferencesViewModel = .preview(),
        inboxViewModel: InboxViewModel = .preview(),
        activeViewModel: ActiveViewModel = .preview(),
        receiptsViewModel: ReceiptsViewModel = .preview()
    ) {
        self.viewModel = viewModel
        self.itemsViewModel = itemsViewModel
        self.intentsViewModel = intentsViewModel
        self.notificationPreferencesViewModel = notificationPreferencesViewModel
        self.inboxViewModel = inboxViewModel
        self.activeViewModel = activeViewModel
        self.receiptsViewModel = receiptsViewModel
    }

    public var body: some View {
        TabView(selection: $viewModel.selectedTab) {
            ForEach(viewModel.availableTabs) { tab in
                tabContent(tab)
                    .tabItem {
                        Label(tab.title, systemImage: tab.systemImageName)
                    }
                    .tag(tab)
                    .accessibilityIdentifier("tab.\(tab.rawValue)")
            }
        }
        .dynamicTypeSize(.xSmall ... .accessibility3)
    }

    @ViewBuilder
    private func tabContent(_ tab: MarketplaceTab) -> some View {
        switch tab {
        case .items:
            ItemsView(
                viewModel: itemsViewModel,
                openInbox: { viewModel.open(.tab(.inbox)) }
            )
        case .intents:
            IntentsView(
                viewModel: intentsViewModel,
                notificationPreferencesViewModel: notificationPreferencesViewModel
            )
        case .inbox:
            InboxView(
                viewModel: inboxViewModel,
                selectedProposalID: viewModel.selectedProposalID
            )
        case .active:
            ActiveView(
                viewModel: activeViewModel,
                selectedCycleID: viewModel.selectedActiveCycleID
            ) { cycleID in
                viewModel.open(.receipt(cycleID: cycleID))
            }
            .accessibilityIdentifier("active.timeline")
        case .receipts:
            ReceiptsView(
                viewModel: receiptsViewModel,
                selectedCycleID: viewModel.selectedReceiptCycleID
            )
        }
    }
}

public struct RouteStubView: View {
    let title: String
    let subtitle: String

    public init(title: String, subtitle: String) {
        self.title = title
        self.subtitle = subtitle
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.marketplace(.sectionHeading))
            Text(subtitle)
                .font(.marketplace(.body))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(16)
    }
}
