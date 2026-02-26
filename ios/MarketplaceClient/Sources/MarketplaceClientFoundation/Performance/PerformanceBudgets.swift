import Foundation

public enum MarketplacePerformanceBudgets {
    public static let startupBudgetMilliseconds: Double = 450
    public static let interactionBudgetMilliseconds: Double = 300
    public static let longListBudgetMilliseconds: Double = 500
}

public struct PerformanceCheckResult: Sendable, Equatable {
    public let name: String
    public let measuredMilliseconds: Double
    public let budgetMilliseconds: Double

    public init(name: String, measuredMilliseconds: Double, budgetMilliseconds: Double) {
        self.name = name
        self.measuredMilliseconds = measuredMilliseconds
        self.budgetMilliseconds = budgetMilliseconds
    }

    public var passes: Bool {
        measuredMilliseconds <= budgetMilliseconds
    }
}
