import UIKit
import UserNotifications

struct BellNotificationRoute: Equatable {
    let server: String
    let target: ChatTarget
    let requestID: String?

    init?(userInfo: [AnyHashable: Any]) {
        // 通知拡張が Communication Notification へ書き換えても、開く先は bellteam の botId / roomId のまま。
        guard let value = userInfo["bellteam"] as? [String: Any],
              let server = value["server"] as? String,
              let url = ServerOrigin.url(server),
              let kind = value["kind"] as? String, ["reply", "secret_request", "owner_question"].contains(kind),
              let botID = value["botId"] as? String, !botID.isEmpty else { return nil }
        self.server = url.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if let roomID = value["roomId"] as? String, !roomID.isEmpty { target = .room(roomID) }
        else { target = .bot(botID) }
        requestID = kind == "secret_request" ? value["requestId"] as? String : nil
    }

    func belongs(to url: URL?) -> Bool {
        url?.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) == server
    }
}

@MainActor
final class BellNotifications: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = BellNotifications()
    @Published var statusText = "未設定"
    @Published var errorText: String?
    var visibleConversation: ChatTarget?
    var onOpen: ((BellNotificationRoute) -> Void)? {
        didSet {
            if let pendingRoute, let onOpen { self.pendingRoute = nil; onOpen(pendingRoute) }
        }
    }
    private var pendingRoute: BellNotificationRoute?
    private var api: BellAPI?
    private var token: String?
    private var signedTransaction: String?
    private var attached = false
    private var activating = false
    private var registrationTask: Task<Void, Never>?

    func activate(api: BellAPI, signedTransaction: String?) async {
        guard !activating else { return }
        activating = true
        defer { activating = false }
        attached = true
        self.api = api
        self.signedTransaction = signedTransaction
        errorText = nil
        var stage = "server_status"
        var started = DispatchTime.now().uptimeNanoseconds
        do {
            let server: PushServerStatus = try await api.get("/api/notifications")
            guard attached else { return }
            guard server.configured, server.environments.contains(try Self.environment()) else {
                statusText = "サーバーで通知が設定されていません"
                return
            }
            let center = UNUserNotificationCenter.current()
            stage = "authorization"
            started = DispatchTime.now().uptimeNanoseconds
            var settings = await center.notificationSettings()
            if settings.authorizationStatus == .notDetermined {
                _ = try await center.requestAuthorization(options: [.alert, .sound])
                settings = await center.notificationSettings()
            }
            guard [.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus) else {
                statusText = "端末の設定で通知がオフです"
                return
            }
            guard attached else { return }
            statusText = "通知を登録しています"
            UIApplication.shared.registerForRemoteNotifications()
        } catch {
            statusText = "通知を登録できませんでした"
            errorText = error.localizedDescription
            api.diagnostics.reportPush(error, stage: stage, elapsedMilliseconds: BellDiagnostics.elapsedMilliseconds(since: started))
        }
    }

    func updateSignedTransaction(_ value: String?) async {
        signedTransaction = value
        if attached { await registerToken() }
    }

    func receivedToken(_ data: Data) {
        token = data.map { String(format: "%02x", $0) }.joined()
        guard attached else { return }
        registrationTask = Task { await registerToken() }
    }

    private func registerToken() async {
        guard attached, let api, let server = api.baseURL?.absoluteString, let token else { return }
        let started = DispatchTime.now().uptimeNanoseconds
        do {
            let previous = UserDefaults.standard.string(forKey: "bellbot.pushToken")
            let _: PushRegistration = try await api.post("/api/notifications/devices",
                body: PushDevice(token: token, environment: try Self.environment(), server: server, previousToken: previous, signedTransaction: signedTransaction))
            UserDefaults.standard.set(token, forKey: "bellbot.pushToken")
            statusText = "返信・入力要求を通知します"
            errorText = nil
        } catch {
            statusText = "通知を登録できませんでした"
            errorText = error.localizedDescription
            api.diagnostics.reportPush(error, stage: "register_device", elapsedMilliseconds: BellDiagnostics.elapsedMilliseconds(since: started))
        }
    }

    func registrationFailed(_ error: Error) {
        statusText = "Appleの通知サービスへ登録できませんでした"
        errorText = "通信状態と端末の通知設定を確認してください。"
        BellDiagnostics.shared.reportPush(error, stage: "apns_token")
    }

    func detach() async {
        attached = false
        UIApplication.shared.unregisterForRemoteNotifications()
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        await registrationTask?.value
        if let api, let token = UserDefaults.standard.string(forKey: "bellbot.pushToken") {
            let started = DispatchTime.now().uptimeNanoseconds
            do {
                let _: PushRegistration = try await api.post("/api/notifications/unregister", body: PushToken(token: token))
                UserDefaults.standard.removeObject(forKey: "bellbot.pushToken")
            } catch { api.diagnostics.reportPush(error, stage: "unregister", elapsedMilliseconds: BellDiagnostics.elapsedMilliseconds(since: started)) }
        }
        api = nil
        token = nil
        signedTransaction = nil
        pendingRoute = nil
        visibleConversation = nil
        statusText = "未設定"
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
        willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        Task { @MainActor in
            guard let route = BellNotificationRoute(userInfo: notification.request.content.userInfo),
                  route.belongs(to: api?.baseURL), attached else { completionHandler([]); return }
            completionHandler(visibleConversation == route.target ? [] : [.banner, .list, .sound])
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        Task { @MainActor in
            if let route = BellNotificationRoute(userInfo: response.notification.request.content.userInfo) {
                if let onOpen { onOpen(route) } else { pendingRoute = route }
            }
            completionHandler()
        }
    }

    static func environment() throws -> String {
        guard let value = Bundle.main.object(forInfoDictionaryKey: "BellTeamPushEnvironment") as? String,
              ["development", "production"].contains(value) else {
            throw BellAPIError.server("アプリの通知環境が正しく設定されていません。")
        }
        return value
    }
}

final class BellNotificationAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = BellNotifications.shared
        return true
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        BellNotifications.shared.receivedToken(deviceToken)
    }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        BellNotifications.shared.registrationFailed(error)
    }
}

private struct PushServerStatus: Decodable { let configured: Bool; let environments: [String] }
private struct PushDevice: Encodable { let token: String; let environment: String; let server: String; let previousToken: String?; let signedTransaction: String? }
private struct PushToken: Encodable { let token: String }
private struct PushRegistration: Decodable { let registered: Bool }
