import Foundation

@MainActor
public final class WelcomeViewModel: ObservableObject {
    @Published public var selectedAccount: PilotAccount?
    @Published public private(set) var hasEnteredMarketplace = false

    public let accounts: [PilotAccount]
    private let onEnter: (PilotAccount) -> Void

    public init(
        accounts: [PilotAccount] = PilotAccounts.all,
        onEnter: @escaping (PilotAccount) -> Void
    ) {
        self.accounts = accounts
        self.selectedAccount = accounts.first
        self.onEnter = onEnter
    }

    public var canEnter: Bool {
        selectedAccount != nil
    }

    public func enter() {
        guard let account = selectedAccount else { return }
        hasEnteredMarketplace = true
        onEnter(account)
    }

    public static func preview() -> WelcomeViewModel {
        WelcomeViewModel { _ in }
    }
}
