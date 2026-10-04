import SwiftUI
import WebKit

struct ServerSetupView: View {
    @EnvironmentObject private var store: AppStore
    @State private var address = ""
    @State private var errorText: String?
    @State private var showingInstallationGuide = false

    var body: some View {
        ZStack {
            BellBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    Image("BellPortrait")
                        .resizable()
                        .scaledToFill()
                        .frame(width: 106, height: 106)
                        .clipShape(RoundedRectangle(cornerRadius: 30, style: .continuous))
                    Text("BellTeamを始める")
                        .font(.system(size: 37, weight: .bold, design: .rounded))
                        .foregroundStyle(BellTheme.ink)
                    Text("自分のPCやサーバーでBellTeamを動かし、このアプリから接続して使います。")
                        .foregroundStyle(BellTheme.muted)
                    Button { showingInstallationGuide = true } label: {
                        HStack(spacing: 16) {
                            Image(systemName: "shippingbox").font(.title2)
                            VStack(alignment: .leading, spacing: 6) {
                                Text("はじめて使う").font(.headline)
                                Text("Dockerの準備からアプリへの接続まで").font(.subheadline)
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                        }
                        .foregroundStyle(BellTheme.ink)
                        .padding(20)
                        .bellCard()
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("server-installation-guide")
                    Text("サーバーを用意済みの方").font(.headline).padding(.top, 8)
                    Text("同じマシンならhttp://localhost:18891、iPhone・iPadならLAN上のBellTeamのURLを入力してください。外部接続はHTTPSを使います。")
                        .foregroundStyle(BellTheme.muted)
                    TextField("BellTeamの接続先URL", text: $address)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .padding(18)
                        .bellCard()
                        .accessibilityIdentifier("server-address")
                    if let errorText {
                        Text(errorText).font(.footnote).foregroundStyle(.red)
                    }
                    Button {
                        Task {
                            do {
                                errorText = nil
                                try await store.setServerAddress(address)
                            } catch { errorText = error.localizedDescription }
                        }
                    } label: {
                        HStack {
                            Text("続ける")
                            Spacer()
                            Image(systemName: "arrow.right")
                        }
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 23)
                        .frame(height: 60)
                        .background(BellTheme.violet, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    }
                }
                .padding(.horizontal, 30)
                .frame(maxWidth: 520)
                .padding(.vertical, 40)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .sheet(isPresented: $showingInstallationGuide) { ServerInstallationGuide() }
    }
}

struct LoginView: View {
    @EnvironmentObject private var store: AppStore
    @State private var showingLogin = false

    var body: some View {
        ZStack {
            BellBackground()
            VStack(spacing: 0) {
                Spacer()
                ZStack {
                    Circle()
                        .fill(BellTheme.violet.opacity(0.16))
                        .frame(width: 290, height: 290)
                        .blur(radius: 45)
                    Image("BellPortrait")
                        .resizable()
                        .scaledToFill()
                        .frame(width: 182, height: 182)
                        .clipShape(RoundedRectangle(cornerRadius: 51, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 51, style: .continuous).strokeBorder(.white, lineWidth: 3))
                        .shadow(color: BellTheme.violet.opacity(0.22), radius: 30, y: 17)
                }
                .padding(.bottom, 42)
                Text("BellTeam")
                    .font(.system(size: 48, weight: .bold, design: .rounded))
                    .tracking(-2.5)
                    .foregroundStyle(BellTheme.ink)
                Text("いつでも、あなたのチームと。")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(BellTheme.muted)
                    .padding(.top, 12)
                Spacer()
                Button {
                    showingLogin = true
                } label: {
                    HStack {
                        Image(systemName: "lock.shield.fill")
                        Text("ログインして始める")
                        Spacer()
                        Image(systemName: "arrow.right")
                    }
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 23)
                    .frame(height: 60)
                    .background(BellTheme.violet, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .shadow(color: BellTheme.violet.opacity(0.22), radius: 16, y: 8)
                }
                Text("Cloudflare Accessで安全に接続します")
                    .font(.caption)
                    .foregroundStyle(BellTheme.muted)
                    .padding(.top, 18)
                    .padding(.bottom, 25)
            }
            .padding(.horizontal, 30)
            #if targetEnvironment(macCatalyst)
            .frame(maxWidth: 520)
            .padding(.vertical, 40)
            #endif
        }
        .onAppear {
            if store.openLoginAutomatically {
                store.openLoginAutomatically = false
                showingLogin = true
            }
        }
        .sheet(isPresented: $showingLogin) {
            NavigationStack {
                CloudflareLoginView()
                    .navigationTitle("ログイン")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("閉じる") { showingLogin = false }
                        }
                    }
            }
        }
    }
}

private struct CloudflareLoginView: UIViewRepresentable {
    @EnvironmentObject private var store: AppStore

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = store.webDataStore
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        if let baseURL = store.serverURL {
            view.load(URLRequest(url: baseURL.appending(path: "api/session")))
        }
        return view
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(store: store) }

    final class Coordinator: NSObject, WKNavigationDelegate {
        let store: AppStore
        init(store: AppStore) { self.store = store }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            Task { await store.completeWebLogin() }
        }
    }
}
