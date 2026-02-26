import SwiftUI

public enum MarketplaceAccessibility {
    public static let minimumTouchTarget: CGFloat = 44
    public static let informationalReadabilityFloor: CGFloat = 11.3
}

public extension View {
    func marketplaceTouchTarget() -> some View {
        contentShape(Rectangle())
            .frame(minHeight: MarketplaceAccessibility.minimumTouchTarget)
    }
}
