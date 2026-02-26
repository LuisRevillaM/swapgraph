import Foundation
@testable import MarketplaceClientFoundation

actor MockHTTPTransport: HTTPTransport {
    enum MockError: Error {
        case noStub
    }

    struct Stub {
        let result: Result<(Data, HTTPURLResponse), Error>
    }

    private var stubs: [Stub] = []
    private(set) var requests: [URLRequest] = []

    func enqueue(statusCode: Int, url: URL, body: String) {
        let response = HTTPURLResponse(
            url: url,
            statusCode: statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: ["content-type": "application/json"]
        )!
        let data = Data(body.utf8)
        stubs.append(Stub(result: .success((data, response))))
    }

    func enqueue(error: Error) {
        stubs.append(Stub(result: .failure(error)))
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)

        guard !stubs.isEmpty else {
            throw MockError.noStub
        }

        let stub = stubs.removeFirst()
        switch stub.result {
        case .success(let payload):
            return payload
        case .failure(let error):
            throw error
        }
    }

    func capturedRequests() -> [URLRequest] {
        requests
    }
}
