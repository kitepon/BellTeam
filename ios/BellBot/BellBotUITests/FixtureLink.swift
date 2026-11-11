import XCTest

/// How a UI test reaches its Mac fixture server. The simulator calls it directly. On a real device the XCUITest runner has no
/// Local Network access, so it calls the app's DEBUG relay on loopback (PreviewFixtureRelay), which forwards to the Mac.
let relayPort = 47999

func fixtureLaunchArguments(server: String) -> [String] {
    #if targetEnvironment(simulator)
    return []
    #else
    return ["-bellbot-fixture-relay", "\(relayPort)"]
    #endif
}

/// Taps "Allow" on the system Local Network alert when it is showing.
@MainActor
func allowLocalNetworkAlertIfShown() {
    let alert = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.firstMatch
    guard alert.exists else { return }
    for label in ["許可", "Allow", "OK"] where alert.buttons[label].exists {
        alert.buttons[label].tap()
        return
    }
}

@MainActor
func fixtureCall(server: String, path: String) async throws -> [String: Any] {
    #if targetEnvironment(simulator)
    return try await fixtureGet(server + path)
    #else
    let url = "http://127.0.0.1:\(relayPort)" + path
    do { return try await fixtureGet(url) } catch {}
    // No app is running the relay yet: start one, then retry until the relay accepts.
    let app = XCUIApplication()
    app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", server] + fixtureLaunchArguments(server: server)
    app.launch()
    var last: Error = URLError(.cannotConnectToHost)
    for _ in 0..<40 {
        allowLocalNetworkAlertIfShown()
        do { return try await fixtureGet(url) } catch { last = error }
        try await Task.sleep(nanoseconds: 500_000_000)
    }
    throw last
    #endif
}

private func fixtureGet(_ url: String) async throws -> [String: Any] {
    let (data, _) = try await URLSession.shared.data(from: try XCTUnwrap(URL(string: url)))
    return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
}
