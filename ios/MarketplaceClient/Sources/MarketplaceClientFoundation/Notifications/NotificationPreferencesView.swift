import SwiftUI

public struct NotificationPreferencesView: View {
    @ObservedObject private var viewModel: NotificationPreferencesViewModel

    public init(viewModel: NotificationPreferencesViewModel) {
        self.viewModel = viewModel
    }

    public var body: some View {
        NavigationStack {
            Form {
                Section("Categories") {
                    ForEach(MarketplaceNotificationCategory.allCases, id: \.self) { category in
                        Toggle(isOn: categoryBinding(category)) {
                            Text(category.title)
                                .font(.marketplace(.body).weight(.semibold))
                        }
                        .toggleStyle(.switch)
                    }
                }

                Section("Minimum urgency") {
                    Picker("Minimum urgency", selection: urgencyBinding) {
                        ForEach(MarketplaceNotificationUrgency.allCases, id: \.self) { urgency in
                            Text(urgency.title).tag(urgency)
                        }
                    }
                    .pickerStyle(.menu)
                }

                if let fallbackState = viewModel.fallbackState {
                    Section("Status") {
                        Text(fallbackMessage(fallbackState))
                            .font(.marketplace(.body))
                            .foregroundStyle(Color(red: 0.63, green: 0.28, blue: 0.25))
                    }
                }
            }
            .navigationTitle("Alert preferences")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        viewModel.close()
                    }
                }
            }
        }
        .task {
            viewModel.load()
        }
    }

    private var urgencyBinding: Binding<MarketplaceNotificationUrgency> {
        Binding(
            get: { viewModel.preferences.minimumUrgency },
            set: { next in
                viewModel.setMinimumUrgency(next)
            }
        )
    }

    private func categoryBinding(_ category: MarketplaceNotificationCategory) -> Binding<Bool> {
        Binding(
            get: { viewModel.preferences.enabledCategories.contains(category) },
            set: { enabled in
                viewModel.setCategory(category, enabled: enabled)
            }
        )
    }

    private func fallbackMessage(_ state: FallbackState) -> String {
        switch state {
        case .loading(let message):
            return message
        case .empty(_, let message),
             .retryable(_, let message),
             .blocked(_, let message),
             .failure(_, let message):
            return message
        }
    }
}
