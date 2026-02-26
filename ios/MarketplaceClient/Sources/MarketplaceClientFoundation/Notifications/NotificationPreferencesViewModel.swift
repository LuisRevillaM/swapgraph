import Foundation

@MainActor
public final class NotificationPreferencesViewModel: ObservableObject {
    @Published public private(set) var preferences: MarketplaceNotificationPreferences
    @Published public var isPresented = false
    @Published public private(set) var fallbackState: FallbackState?

    private let store: MarketplaceNotificationPreferencesStoreProtocol
    private let analyticsClient: AnalyticsClient?
    private let actorID: String
    private let now: () -> Date

    public init(
        store: MarketplaceNotificationPreferencesStoreProtocol,
        analyticsClient: AnalyticsClient? = nil,
        actorID: String = "u1",
        now: @escaping () -> Date = Date.init
    ) {
        self.store = store
        self.analyticsClient = analyticsClient
        self.actorID = actorID
        self.now = now
        self.preferences = .default
    }

    public func load() {
        do {
            preferences = try store.load(nowEpochSeconds: nowEpochSeconds())
            fallbackState = nil
        } catch {
            preferences = .default
            fallbackState = .failure(
                title: "Unable to load notification preferences",
                message: "Using defaults for now."
            )
        }
    }

    public func setCategory(_ category: MarketplaceNotificationCategory, enabled: Bool) {
        if enabled {
            preferences.enabledCategories.insert(category)
        } else {
            preferences.enabledCategories.remove(category)
        }
        persist()
    }

    public func setMinimumUrgency(_ urgency: MarketplaceNotificationUrgency) {
        preferences.minimumUrgency = urgency
        persist()
    }

    public func open() {
        isPresented = true
    }

    public func close() {
        isPresented = false
    }

    public static func preview() -> NotificationPreferencesViewModel {
        let store = PreviewStore()
        let model = NotificationPreferencesViewModel(store: store)
        model.preferences = .default
        return model
    }

    private func persist() {
        do {
            try store.save(preferences, nowEpochSeconds: nowEpochSeconds())
            fallbackState = nil

            let enabledCategories = preferences.enabledCategories
                .map(\.rawValue)
                .sorted()
                .map(JSONValue.string)
            track(
                name: "marketplace.notification.preferences.updated",
                payload: [
                    "actor_id": .string(actorID),
                    "minimum_urgency": .string(preferences.minimumUrgency.rawValue),
                    "enabled_categories": .array(enabledCategories)
                ]
            )
        } catch {
            fallbackState = .retryable(
                title: "Unable to save preferences",
                message: "Please try again."
            )
        }
    }

    private func track(name: String, payload: [String: JSONValue]) {
        guard let analyticsClient else { return }
        let event = AnalyticsEvent(
            name: name,
            correlationID: UUID().uuidString.lowercased(),
            occurredAt: ISO8601DateFormatter().string(from: now()),
            payload: payload
        )

        Task {
            try? await analyticsClient.track(event)
        }
    }

    private func nowEpochSeconds() -> Int {
        Int(now().timeIntervalSince1970)
    }
}

private final class PreviewStore: MarketplaceNotificationPreferencesStoreProtocol, @unchecked Sendable {
    private var value: MarketplaceNotificationPreferences = .default

    func load(nowEpochSeconds: Int) throws -> MarketplaceNotificationPreferences {
        _ = nowEpochSeconds
        return value
    }

    func save(_ preferences: MarketplaceNotificationPreferences, nowEpochSeconds: Int) throws {
        _ = nowEpochSeconds
        value = preferences
    }

    func reset() throws {
        value = .default
    }
}
