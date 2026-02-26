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
        case .items: return "Items"
        case .intents: return "Intents"
        case .inbox: return "Inbox"
        case .active: return "Active"
        case .receipts: return "Receipts"
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
