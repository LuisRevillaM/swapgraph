import Foundation

@MainActor
public final class DeepLinkRouter {
    private unowned let appShell: AppShellViewModel

    public init(appShell: AppShellViewModel) {
        self.appShell = appShell
    }

    @discardableResult
    public func route(url: URL) -> Bool {
        guard let route = DeepLinkParser.parse(url: url) else {
            return false
        }

        appShell.open(route)
        return true
    }
}
