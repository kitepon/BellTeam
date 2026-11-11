#if DEBUG
import Foundation
import Network

/// Real-device UI tests: the XCUITest runner has no Local Network access (every LAN request fails -1009), but this app does.
/// The runner calls 127.0.0.1:<port>; this relay pipes each connection to the Mac fixture server.
enum PreviewFixtureRelay {
    private static var listener: NWListener?
    private static let queue = DispatchQueue(label: "PreviewFixtureRelay")

    static func startIfRequested(arguments: [String], fixture: URL?) {
        guard listener == nil,
              let index = arguments.firstIndex(of: "-bellbot-fixture-relay"), arguments.indices.contains(index + 1),
              let port = UInt16(arguments[index + 1]).flatMap(NWEndpoint.Port.init(rawValue:)),
              let host = fixture?.host, let fixturePort = (fixture?.port).flatMap({ UInt16(exactly: $0) }).flatMap(NWEndpoint.Port.init(rawValue:))
        else { return }
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: port)
        guard let started = try? NWListener(using: parameters) else { return }
        started.newConnectionHandler = { inbound in
            let outbound = NWConnection(host: NWEndpoint.Host(host), port: fixturePort, using: .tcp)
            inbound.start(queue: queue)
            outbound.start(queue: queue)
            pipe(inbound, outbound)
            pipe(outbound, inbound)
        }
        started.start(queue: queue)
        listener = started
    }

    private static func pipe(_ from: NWConnection, _ to: NWConnection) {
        from.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, complete, error in
            if let data, !data.isEmpty {
                to.send(content: data, completion: .contentProcessed { _ in })
            }
            if complete || error != nil {
                to.cancel()
                from.cancel()
            } else {
                pipe(from, to)
            }
        }
    }
}
#endif
