import Foundation

public enum MarketplaceTab: String, CaseIterable, Identifiable, Sendable {
    case items
    case intents
    case inbox
    case active
    case receipts

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .items: return "My Items"
        case .intents: return "Trades"
        case .inbox: return "Matches"
        case .active: return "In Progress"
        case .receipts: return "History"
        }
    }

    public var systemImageName: String {
        switch self {
        case .items: return "square.grid.2x2"
        case .intents: return "scope"
        case .inbox: return "tray.full"
        case .active: return "waveform.path.ecg"
        case .receipts: return "doc.text"
        }
    }
}
