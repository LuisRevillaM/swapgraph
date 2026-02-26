import Foundation
import XCTest
@testable import MarketplaceClientFoundation

final class ItemsFeatureTests: XCTestCase {
    func testRepositoryBuildsHighestDemandThenTradableSections() async throws {
        let baseURL = URL(string: "http://localhost:3005")!
        let transport = PathAwareMockTransport()

        await transport.register(
            path: "/product-projections/inventory-awakening",
            statusCode: 200,
            body: """
            {
              "correlation_id":"corr_projection",
              "projection":{
                "swappability_summary":{
                  "intents_total":2,
                  "active_intents":2,
                  "cycle_opportunities":4,
                  "average_confidence_bps":8300
                },
                "recommended_first_intents":[
                  {
                    "recommendation_id":"rec_1",
                    "cycle_id":"cycle_1",
                    "suggested_give_asset_id":"asset_a",
                    "suggested_get_asset_id":"asset_x",
                    "confidence_bps":9100,
                    "rationale":"high demand"
                  },
                  {
                    "recommendation_id":"rec_2",
                    "cycle_id":"cycle_2",
                    "suggested_give_asset_id":"asset_b",
                    "suggested_get_asset_id":"asset_y",
                    "confidence_bps":8600,
                    "rationale":"stable"
                  }
                ]
              }
            }
            """
        )

        await transport.register(
            path: "/cycle-proposals",
            statusCode: 200,
            body: """
            {
              "correlation_id":"corr_proposals",
              "proposals":[
                {
                  "id":"cycle_1",
                  "participants":[
                    {
                      "intent_id":"intent_a",
                      "actor":{"type":"user","id":"u1"},
                      "give":[{"platform":"steam","asset_id":"asset_a"}],
                      "get":[{"platform":"steam","asset_id":"asset_x"}]
                    }
                  ]
                },
                {
                  "id":"cycle_2",
                  "participants":[
                    {
                      "intent_id":"intent_b",
                      "actor":{"type":"user","id":"u2"},
                      "give":[{"platform":"steam","asset_id":"asset_a"}],
                      "get":[{"platform":"steam","asset_id":"asset_z"}]
                    },
                    {
                      "intent_id":"intent_c",
                      "actor":{"type":"user","id":"u3"},
                      "give":[{"platform":"steam","asset_id":"asset_c"}],
                      "get":[{"platform":"steam","asset_id":"asset_q"}]
                    }
                  ]
                }
              ]
            }
            """
        )

        let apiClient = MarketplaceAPIClient(
            configuration: APIClientConfiguration(
                baseURL: baseURL,
                actorType: "user",
                actorID: "u1"
            ),
            transport: transport,
            idempotencyKeyProvider: IdempotencyKeyStore()
        )

        let repository = MarketplaceItemsRepository(apiClient: apiClient)
        let snapshot = try await repository.loadItems()

        XCTAssertEqual(snapshot.demandBannerCount, 4)
        XCTAssertEqual(snapshot.sections.count, 2)
        XCTAssertEqual(snapshot.sections[0].id, "highest-demand")
        XCTAssertEqual(snapshot.sections[1].id, "also-tradable")

        let highestDemandAssetIDs = snapshot.sections[0].items.map(\.assetID)
        XCTAssertEqual(highestDemandAssetIDs, ["asset_a", "asset_c"])

        let tradableAssetIDs = snapshot.sections[1].items.map(\.assetID)
        XCTAssertEqual(tradableAssetIDs, ["asset_b"])
    }
}

@MainActor
final class ItemsViewModelFeatureTests: XCTestCase {
    func testViewModelMapsRetryableFallbackOnServerError() async {
        let viewModel = ItemsViewModel(
            repository: ThrowingItemsRepository(error: .server(statusCode: 503, envelope: nil))
        )

        await viewModel.refresh()

        XCTAssertNil(viewModel.snapshot)
        XCTAssertEqual(
            viewModel.fallbackState,
            .retryable(title: "Temporary issue", message: "The server is unavailable. Try again shortly.")
        )
    }

    private struct ThrowingItemsRepository: MarketplaceItemsRepositoryProtocol {
        let error: MarketplaceClientError

        func loadItems() async throws -> ItemsScreenSnapshot {
            throw error
        }
    }
}

private actor PathAwareMockTransport: HTTPTransport {
    enum StubError: Error {
        case noStub
    }

    struct Stub {
        let statusCode: Int
        let body: String
    }

    private var stubsByPath: [String: Stub] = [:]

    func register(path: String, statusCode: Int, body: String) {
        stubsByPath[path] = Stub(statusCode: statusCode, body: body)
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url?.path ?? ""
        guard let stub = stubsByPath[path], let url = request.url else {
            throw StubError.noStub
        }

        let response = HTTPURLResponse(
            url: url,
            statusCode: stub.statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: ["content-type": "application/json"]
        )!

        return (Data(stub.body.utf8), response)
    }
}
