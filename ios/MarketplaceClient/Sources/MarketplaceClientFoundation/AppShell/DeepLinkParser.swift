import Foundation

public enum DeepLinkParser {
    public static func parse(url: URL) -> AppRoute? {
        let pathParts = pathComponents(from: url)

        if isSwapGraphScheme(url), let route = parseSwapGraphScheme(host: url.host, pathParts: pathParts) {
            return route
        }

        if isSwapGraphWebURL(url), let route = parseSwapGraphPath(pathParts: pathParts) {
            return route
        }

        return nil
    }

    private static func isSwapGraphScheme(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "swapgraph"
    }

    private static func isSwapGraphWebURL(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return false }
        return host == "swapgraph.app" || host == "www.swapgraph.app"
    }

    private static func pathComponents(from url: URL) -> [String] {
        url.path
            .split(separator: "/")
            .map { String($0) }
            .filter { !$0.isEmpty }
    }

    private static func parseSwapGraphScheme(host: String?, pathParts: [String]) -> AppRoute? {
        let hostPart = host?.lowercased()

        switch hostPart {
        case "proposal":
            guard let id = pathParts.first else { return nil }
            return .proposal(id: id)
        case "active":
            guard let cycleID = pathParts.first else { return nil }
            return .activeSwap(cycleID: cycleID)
        case "receipt":
            guard let cycleID = pathParts.first else { return nil }
            return .receipt(cycleID: cycleID)
        case "tab":
            guard let tabRaw = pathParts.first, let tab = MarketplaceTab(rawValue: tabRaw.lowercased()) else {
                return nil
            }
            return .tab(tab)
        default:
            return parseSwapGraphPath(pathParts: pathParts)
        }
    }

    private static func parseSwapGraphPath(pathParts: [String]) -> AppRoute? {
        guard let first = pathParts.first?.lowercased() else { return nil }

        switch first {
        case "proposal", "proposals":
            guard pathParts.count > 1 else { return nil }
            return .proposal(id: pathParts[1])
        case "active", "timeline":
            guard pathParts.count > 1 else { return nil }
            return .activeSwap(cycleID: pathParts[1])
        case "receipt", "receipts":
            guard pathParts.count > 1 else { return nil }
            return .receipt(cycleID: pathParts[1])
        case "tab":
            guard pathParts.count > 1, let tab = MarketplaceTab(rawValue: pathParts[1].lowercased()) else {
                return nil
            }
            return .tab(tab)
        default:
            return nil
        }
    }
}
