import Foundation

public struct PilotInventoryItem: Identifiable, Sendable, Hashable {
    public let assetId: String
    public let name: String
    public let blurb: String

    public var id: String { assetId }
}

public struct PilotAccount: Identifiable, Sendable, Hashable {
    public let actorId: String
    public let name: String
    public let tagline: String
    public let inventory: [PilotInventoryItem]

    public var id: String { actorId }
}

public enum PilotAccounts {
    public static let all: [PilotAccount] = [
        PilotAccount(
            actorId: "u1",
            name: "Javier",
            tagline: "Ship fast, roast bugs, stack fake alpha.",
            inventory: [
                PilotInventoryItem(assetId: "javier_prompt_lambo", name: "Prompt Lambo Pass", blurb: "Unlocks spicy one-liners in standup."),
                PilotInventoryItem(assetId: "javier_ci_saber", name: "CI Lightsaber", blurb: "Cuts flaky tests before breakfast."),
                PilotInventoryItem(assetId: "javier_meme_coin", name: "Meme Yield Badge", blurb: "Boosts confidence by 9,000 bps.")
            ]
        ),
        PilotAccount(
            actorId: "u2",
            name: "Jesus",
            tagline: "Agent wrangler with elite caffeine uptime.",
            inventory: [
                PilotInventoryItem(assetId: "jesus_agent_hawk", name: "Agent Hawk Token", blurb: "Autopilot with tasteful chaos."),
                PilotInventoryItem(assetId: "jesus_deploy_hoodie", name: "Deploy Hoodie", blurb: "Warms hands during prod pushes."),
                PilotInventoryItem(assetId: "jesus_bug_filter", name: "Bug Filter Lens", blurb: "Shows root causes in under 60 seconds.")
            ]
        ),
        PilotAccount(
            actorId: "u3",
            name: "Edgar",
            tagline: "Latency assassin, UX comedian.",
            inventory: [
                PilotInventoryItem(assetId: "edgar_latency_charm", name: "Latency Charm", blurb: "Turns 500ms into 90ms vibes."),
                PilotInventoryItem(assetId: "edgar_refactor_scroll", name: "Refactor Scroll", blurb: "One scroll, six dead TODOs."),
                PilotInventoryItem(assetId: "edgar_chaos_shield", name: "Chaos Shield", blurb: "Protects demos from random gremlins.")
            ]
        ),
        PilotAccount(
            actorId: "u4",
            name: "Gabo",
            tagline: "Design pirate with ruthless merge discipline.",
            inventory: [
                PilotInventoryItem(assetId: "gabo_pixel_compass", name: "Pixel Compass", blurb: "Keeps every screen on-brand."),
                PilotInventoryItem(assetId: "gabo_commit_crown", name: "Commit Crown", blurb: "Grants +3 morale to every PR."),
                PilotInventoryItem(assetId: "gabo_vibe_turbine", name: "Vibe Turbine", blurb: "Converts ideas into launch copy.")
            ]
        ),
        PilotAccount(
            actorId: "u5",
            name: "Luis",
            tagline: "Founder mode: strategy by day, shipper by night.",
            inventory: [
                PilotInventoryItem(assetId: "luis_roadmap_orb", name: "Roadmap Orb", blurb: "Spots market moves 3 weeks early."),
                PilotInventoryItem(assetId: "luis_growth_fork", name: "Growth Fork", blurb: "Splits one idea into three bets."),
                PilotInventoryItem(assetId: "luis_friend_pass", name: "Friends Pilot Pass", blurb: "Lets the whole squad join the game.")
            ]
        )
    ]

    public static func account(for actorId: String) -> PilotAccount? {
        all.first { $0.actorId == actorId }
    }
}
