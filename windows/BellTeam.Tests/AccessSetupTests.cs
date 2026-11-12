using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Threading;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;

public sealed class AccessSetupTests
{
    private const string FakeSecret = "模擬認証入力-表示しない";
    [Fact]
    public void LogoutClearsTheConversationDraftAndRequiresAccessAgain()
    {
        RunSta(() =>
        {
            using var workspace = new Workspace(origin => new BellApi(origin,new StubHandler((request,_)=>Task.FromResult(StubHandler.Json(request.RequestUri!.AbsolutePath switch { "/api/session" => """{"authenticated":true,"authMode":"cloudflare"}""", "/api/bots" => ApiTests.Bots, "/api/rooms" => ApiTests.Rooms, "/api/queue" => ApiTests.EmptyQueue, "/api/owner" => ApiTests.Owner, _ => ApiTests.Page })))));
            Await(workspace.ConnectAsync("https://example.test",listen:false)); var target = workspace.Entries[0].Target; Await(workspace.SelectAsync(workspace.Entries[0])); workspace.DraftText="残さない下書き"; workspace.SignOut();
            Assert.False(workspace.Connected); Assert.True(workspace.NeedsLogin); Assert.Null(workspace.Selected); Assert.Empty(workspace.Entries); Assert.Empty(workspace.Messages);
            Await(workspace.ConnectAsync("https://example.test",listen:false)); Await(workspace.SelectAsync(workspace.Entries.Single(item=>item.Target==target))); Assert.Empty(workspace.DraftText);
        });
    }
    [Theory]
    [InlineData("setup-select")] [InlineData("setup-start")] [InlineData("auth-start")] [InlineData("auth-cancel")]
    public async Task NonInputRejectionsKeepTheKnownServerReason(string action)
    {
        using var api = new BellApi(new("http://localhost/"), new StubHandler((_, _) => Task.FromResult(StubHandler.Json("""{"error":"SETUP_AUTH_REQUIRED","message":"公式認証を済ませてください。"}""", HttpStatusCode.Conflict))));
        Func<Task> perform = action switch { "setup-select" => () => new SetupApi(api).SelectAsync("codex"), "setup-start" => () => new SetupApi(api).StartAsync(), "auth-start" => () => new HarnessAuthenticationApi(api).StartAsync("codex"), _ => () => new HarnessAuthenticationApi(api).CancelAsync("codex") };
        var error = await Assert.ThrowsAsync<BellApiException>(perform); Assert.Contains("公式認証を済ませてください。", error.Message); Assert.DoesNotContain("結果を確認できません", error.Message);
    }
    [Fact]
    public void RestoreSkipsUnusedProfilesAndRuntimeFailureIsJapanese()
    {
        RunSta(() =>
        {
            var path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "BellTeam-access-" + Guid.NewGuid()); var calls = 0;
            var access = new DesktopAccess(path, _ => { calls++; return Task.FromException<Microsoft.Web.WebView2.Core.CoreWebView2Environment>(new InvalidOperationException("Mock runtime missing")); });
            Await(access.RestoreAsync(new("https://example.com/"))); Assert.Equal(0, calls);
            System.IO.Directory.CreateDirectory(path);
            try { var error = Assert.Throws<BellApiException>(() => Await(access.RestoreAsync(new("https://example.com/")))); Assert.Contains("WebView2 Runtime", error.Message); Assert.DoesNotContain("Mock runtime missing", error.ToString()); Assert.Equal(1, calls); }
            finally { System.IO.Directory.Delete(path); }
        });
    }
    [Fact]
    public void LogoutClearsApiCookiesAndConfirmationUsesTheMacCaptions()
    {
        var jar = new CookieContainer(); jar.Add(new Cookie("CF_Authorization", "模擬値", "/", "one.example")); jar.Add(new Cookie("IdP", "模擬値", "/", "two.example")); AccessCookies.Clear(jar); Assert.Empty(jar.GetAllCookies().Cast<Cookie>());
        RunSta(() => { var confirmation = new AuthenticationConfirmationWindow("認証が消えます。"); var buttons = Descendants<Button>(confirmation).Select(button => button.Content as string).ToArray(); Assert.Contains("始めない", buttons); Assert.Contains("今の認証を手放して始める", buttons); confirmation.Close(); });
    }
    public const string Waiting = """{"phase":"authenticate","harness":"codex","harnesses":[{"id":"codex","name":"Codex"}],"guideBotId":"bot-guide","complete":false,"auth":{"status":"waiting","url":"https://example.com/login","user_code":"TEST-CODE","input_required":true,"message":"公式認証を待っています。"}}""";
    [Fact]
    public void OnlyUnexpiredServerAccessCookieIsCopiedAndOldLoginIsRemoved()
    {
        var origin = new Uri("https://bell.example.com/"); var jar = new CookieContainer();
        AccessCookies.Replace(jar, origin, [new("CF_Authorization", "模擬値", "/", ".example.com") { Secure = true, HttpOnly = true, Expires = DateTime.UtcNow.AddDays(1) }, new("other", "コピーしない", "/", "bell.example.com"), new("CF_Authorization", "別ドメイン", "/", "elsewhere.test")]);
        Assert.Equal("CF_Authorization=模擬値", jar.GetCookieHeader(origin)); Assert.Empty(jar.GetCookieHeader(new("https://other.example.com/"))); Assert.Empty(jar.GetCookieHeader(new("http://bell.example.com/")));
        AccessCookies.Replace(jar, origin, []); Assert.Empty(jar.GetCookieHeader(origin));
        AccessCookies.Replace(jar, origin, [new("CF_Authorization", "期限切れ", "/", "bell.example.com") { Expires = DateTime.UtcNow.AddDays(-1) }]); Assert.Empty(jar.GetCookieHeader(origin));
    }
    [Theory]
    [InlineData(302)]
    [InlineData(401)]
    [InlineData(403)]
    public async Task AccessRejectionShowsLoginWithoutFollowingRedirect(int status)
    {
        using var workspace = new Workspace(origin => new BellApi(origin, new StubHandler((_, _) => Task.FromResult(StubHandler.Json("{}", (HttpStatusCode)status)))));
        await workspace.ConnectAsync("https://example.com"); Assert.True(workspace.NeedsLogin); Assert.False(workspace.Connected); Assert.Contains("ログイン", workspace.ConnectionError);
    }
    [Theory]
    [InlineData("cloudflare", true)]
    [InlineData("local", false)]
    public async Task SessionAuthenticationFailureDistinguishesAccessAndLocalConfiguration(string mode, bool login)
    {
        using var workspace = new Workspace(origin => new BellApi(origin, new StubHandler((_, _) => Task.FromResult(StubHandler.Json(JsonSerializer.Serialize(new { authenticated = false, authMode = mode }))))));
        await workspace.ConnectAsync("https://example.com"); Assert.Equal(login, workspace.NeedsLogin); Assert.False(workspace.Connected);
    }
    [Fact]
    public async Task ProfileReadFailureIsReportedBeforeHttpRequests()
    {
        var requests = 0;
        using var workspace = new Workspace(origin => new BellApi(origin, new StubHandler((_, _) => { requests++; return Task.FromResult(StubHandler.Json("{}")); })), _ => Task.FromException(new InvalidOperationException("プロファイルを開けません。")));
        await workspace.ConnectAsync("https://example.com"); Assert.Equal(0, requests); Assert.Contains("プロファイルを開けません", workspace.ConnectionError);
    }
    [Fact]
    public async Task SetupRoutesAndSnakeCaseAuthenticationFieldsMatchServer()
    {
        var paths = new Queue<string>(["/api/setup", "/api/setup/harness", "/api/setup/auth/input", "/api/setup/auth/input", "/api/setup/start"]);
        using var api = new BellApi(new("http://localhost/"), new StubHandler(async (request, token) =>
        {
            var path = paths.Dequeue(); Assert.Equal(path, request.RequestUri!.AbsolutePath);
            if (path == "/api/setup") Assert.Equal(HttpMethod.Get, request.Method);
            else
            {
                Assert.Equal(HttpMethod.Post, request.Method); using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
                if (path.EndsWith("/harness")) Assert.Equal("codex", body.RootElement.GetProperty("harness").GetString());
                if (path.EndsWith("/input")) { Assert.Single(body.RootElement.EnumerateObject()); if (paths.Count == 2) Assert.Equal(FakeSecret, body.RootElement.GetProperty("text").GetString()); else Assert.Equal("Enter", body.RootElement.GetProperty("key").GetString()); }
                if (path.EndsWith("/start")) Assert.Empty(body.RootElement.EnumerateObject());
            }
            return StubHandler.Json(Waiting);
        }));
        var setup = new SetupApi(api); var state = await setup.StatusAsync(); Assert.True(state.Auth!.InputRequired); Assert.Equal("TEST-CODE", state.Auth.UserCode);
        await setup.SelectAsync("codex"); await setup.InputAsync(FakeSecret, null); await setup.InputAsync(null, "Enter"); await setup.StartAsync(); Assert.Empty(paths);
    }
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SetupInputFailuresDoNotExposeSubmittedValue(bool transport)
    {
        using var api = new BellApi(new("http://localhost/"), new StubHandler((_, _) => transport ? Task.FromException<HttpResponseMessage>(new HttpRequestException(FakeSecret)) : Task.FromResult(StubHandler.Json(JsonSerializer.Serialize(new { message = FakeSecret }), HttpStatusCode.BadRequest))));
        var error = await Assert.ThrowsAsync<BellApiException>(() => new SetupApi(api).InputAsync(FakeSecret, null)); Assert.DoesNotContain(FakeSecret, error.ToString()); Assert.Null(error.InnerException);
    }
    // Mac OnboardingView: only a paste_code prompt with an official https address offers the code field.
    public const string PasteCode = """{"phase":"authenticate","harness":"codex","harnesses":[{"id":"codex","name":"Codex"}],"guideBotId":"bot-guide","complete":false,"auth":{"status":"waiting","url":"https://example.com/login","input_required":true,"message":"公式認証を待っています。","auth_ui":{"schema":"aiterm.auth-ui.v1","stage":"paste_code","title":"コードを貼り付けます","message":"公式ページのコードを入力してください。","url":"https://example.com/login","input":"authorization_code","prompt_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","binding":{"session_id":"owned","launch_id":null,"metadata_identity":"meta-1","native_id":"native-1","pane_id":"%3","server_pid":4101,"server_started":"2026-11-08T09:00:00Z","pane_pid":4102,"pane_started":"2026-11-08T09:00:01Z"},"choices":[]}}}""";
    private const string ReadyState = """{"phase":"ready","harness":"codex","harnesses":[],"guideBotId":"bot-guide","complete":false,"auth":null}""";
    [Fact]
    public void OnboardingCodeIsClearedOnSendDeactivationAndUnloadAndAFailedSendNeedsARefresh()
    {
        RunSta(() =>
        {
            var posts = 0;
            using var api = new BellApi(new("http://localhost/"), new StubHandler((request, _) =>
            {
                if (request.Method == HttpMethod.Post) { posts++; return Task.FromResult(StubHandler.Json(JsonSerializer.Serialize(new { message = FakeSecret }), HttpStatusCode.BadRequest)); }
                return Task.FromResult(StubHandler.Json(PasteCode));
            }));
            var view = new OnboardingView(new SetupApi(api), JsonSerializer.Deserialize<SetupState>(PasteCode, BellApi.Json)!, _ => Task.CompletedTask, () => { });
            var input = Descendants<PasswordBox>(view).Single(); input.Password = FakeSecret;
            Click(view, "認証コードを送る"); Settle(view); Assert.Equal(1, posts); Assert.Empty(input.Password);
            Assert.All(Descendants<TextBlock>(view), text => Assert.DoesNotContain(FakeSecret, text.Text));
            // Mac setupAuthNeedsRefresh: after a failed reply nothing is sent again until the status is refreshed.
            Assert.NotNull(view.ErrorText); Assert.False(Named(view, "認証コードを送る").IsEnabled); Assert.False(Named(view, "認証を確認して始める").IsEnabled); Assert.False(input.IsEnabled);
            input.Password = FakeSecret; typeof(OnboardingView).GetMethod("Deactivated", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(view, [null, EventArgs.Empty]); Assert.Empty(input.Password);
            input.Password = FakeSecret; view.RaiseEvent(new RoutedEventArgs(FrameworkElement.UnloadedEvent)); Assert.Empty(input.Password);
            Click(view, "認証の状態を更新"); Settle(view); Assert.Null(view.ErrorText); Assert.True(input.IsEnabled); Assert.Equal(1, posts);
            view.Dispose();
        });
    }
    [Fact]
    public void OnboardingRefreshKeepsUnsubmittedInputAndStartLeavesOnlyOnReady()
    {
        RunSta(() =>
        {
            var posts = 0; var left = new List<string>();
            using var api = new BellApi(new("http://localhost/"), new StubHandler((request, _) =>
            {
                if (request.Method == HttpMethod.Post) { posts++; Assert.EndsWith("/setup/start", request.RequestUri!.AbsolutePath); return Task.FromResult(StubHandler.Json(posts == 1 ? PasteCode : ReadyState)); }
                return Task.FromResult(StubHandler.Json(PasteCode));
            }));
            var view = new OnboardingView(new SetupApi(api), JsonSerializer.Deserialize<SetupState>(PasteCode, BellApi.Json)!, state => { left.Add(state.Phase); return Task.CompletedTask; }, () => { });
            var input = Descendants<PasswordBox>(view).Single(); input.Password = FakeSecret;
            Click(view, "認証の状態を更新"); Settle(view); Assert.Equal(FakeSecret, input.Password); Assert.Equal(0, posts);
            // Not ready yet: the Mac message, and the app stays on this screen.
            Click(view, "認証を確認して始める"); Settle(view); Assert.Equal(1, posts); Assert.Empty(left); Assert.Equal("公式認証を完了してから、もう一度確認してください。", view.ErrorText);
            Click(view, "認証の状態を更新"); Settle(view);
            Click(view, "認証を確認して始める"); Settle(view); Assert.Equal(2, posts); Assert.Equal(new[] { "ready" }, left.ToArray()); Assert.Empty(input.Password);
            view.Dispose();
        });
    }
    [Fact]
    public void OnboardingChoosingAnAiWritesOnceAndAFailureIsShownNotResent()
    {
        RunSta(() =>
        {
            var posts = 0;
            const string choose = """{"phase":"select_harness","harness":null,"harnesses":[{"id":"codex","name":"Codex"},{"id":"claude","name":"Claude"}],"guideBotId":null,"complete":false,"auth":null}""";
            using var api = new BellApi(new("http://localhost/"), new StubHandler((request, _) => { posts++; Assert.Equal("/api/setup/harness", request.RequestUri!.AbsolutePath); return Task.FromResult(StubHandler.Json("""{"error":"SETUP_BUSY","message":"今は選べません。"}""", HttpStatusCode.Conflict)); }));
            var view = new OnboardingView(new SetupApi(api), JsonSerializer.Deserialize<SetupState>(choose, BellApi.Json)!, _ => Task.CompletedTask, () => { });
            Assert.Equal(new[] { "Codex", "Claude" }, Descendants<Button>(view).Select(button => System.Windows.Automation.AutomationProperties.GetName(button)).Where(name => name is "Codex" or "Claude").ToArray());
            Click(view, "Claude"); Settle(view); Assert.Equal(1, posts); Assert.Contains("今は選べません。", view.ErrorText); Assert.False(view.Polling);
            view.Dispose();
        });
    }
    [Fact]
    public void OnboardingPollingGoesOnAfterATransientFailureAndTheNextSuccessClearsIt()
    {
        RunSta(() =>
        {
            var reads = 0; var posts = 0;
            using var api = new BellApi(new("http://localhost/"), new StubHandler((request, _) =>
            {
                if (request.Method == HttpMethod.Post) { posts++; return Task.FromResult(StubHandler.Json(ReadyState)); }
                reads++; if (reads == 1) return Task.FromException<HttpResponseMessage>(new HttpRequestException("一時的な通信失敗"));
                return Task.FromResult(StubHandler.Json(reads < 4 ? PasteCode : PasteCode.Replace("\"status\":\"waiting\"", "\"status\":\"authenticated\"")));
            }));
            var view = new OnboardingView(new SetupApi(api), JsonSerializer.Deserialize<SetupState>(PasteCode, BellApi.Json)!, _ => Task.CompletedTask, () => { });
            Assert.True(view.Polling);
            Await(view.PollAsync()); Assert.NotNull(view.ErrorText); Assert.True(view.Polling); Assert.Equal(1, reads);
            Await(view.PollAsync()); Assert.Null(view.ErrorText); Assert.True(view.Polling); Assert.Equal(2, reads);
            Await(view.PollAsync()); Await(view.PollAsync()); Assert.Equal("authenticated", view.State.Auth!.Status); Assert.False(view.Polling);
            // Polling only reads; nothing was ever written by it.
            Assert.Equal(0, posts); view.Dispose();
        });
    }
    [Fact]
    public void ServerSetupShowsAnInvalidAddressUnderTheFieldAndHandsOverAValidOne()
    {
        RunSta(() =>
        {
            var connected = new List<string>();
            var view = new ServerSetupView(text => { ServerOrigin.Parse(text); connected.Add(text); }, () => { });
            view.Address = "ftp://example.com"; view.Continue(); Assert.Contains("HTTPS", view.ErrorText); Assert.Empty(connected);
            view.Address = "http://localhost:18891"; view.Continue(); Assert.Null(view.ErrorText); Assert.Equal(new[] { "http://localhost:18891" }, connected.ToArray());
            Assert.Contains("BellTeamを始める", Descendants<TextBlock>(view).Select(text => text.Text)); Assert.Contains("サーバーを用意済みの方", Descendants<TextBlock>(view).Select(text => text.Text));
        });
    }
    [Fact]
    public void GuideCopiesTheRepositoryUrlAndRequestThenSaysCopied()
    {
        RunSta(() =>
        {
            Assert.Equal("https://github.com/kitepon/BellTeam\nこれセットアップしたい", ServerGuideView.AiRequest);
            var copied = new List<string>(); var opened = new List<Uri>();
            var guide = new ServerGuideView(copied.Add, opened.Add);
            Assert.Contains("AIにセットアップを任せる", Descendants<TextBlock>(guide).Select(text => text.Text)); Assert.Contains("GitHubのURLと依頼文を、PCを操作できるAIへ渡します。", Descendants<TextBlock>(guide).Select(text => text.Text));
            Click(guide, "URLと依頼文をコピー"); Assert.Equal(new[] { ServerGuideView.AiRequest }, copied.ToArray()); Assert.Equal("コピーしました", System.Windows.Automation.AutomationProperties.GetName(Descendants<Button>(guide).First()));
            // The copy button then shows a check icon (E73E) in place of the copy icon (E8C8).
            Assert.Equal("\uE73E", ((TextBlock)((StackPanel)Descendants<Button>(guide).First().Content).Children[0]).Text);
            Click(guide, "この手順のURLをコピー"); Assert.Equal("https://github.com/kitepon/BellTeam/blob/main/docs/server-installation.md", copied[1]);
            Click(guide, "GitHubをブラウザーで開く"); Click(guide, "PCで読む手順と配布ファイルを開く");
            Assert.Equal(new[] { "https://github.com/kitepon/BellTeam", "https://github.com/kitepon/BellTeam/blob/main/docs/server-installation.md" }, opened.Select(address => address.AbsoluteUri).ToArray());
            // The body is the bundled installation guide, rendered by the shared markdown view.
            Assert.Contains("アプリからBellTeamを使い始める", new TextRange(Descendants<MarkdownView>(guide).Single().Document.ContentStart, Descendants<MarkdownView>(guide).Single().Document.ContentEnd).Text);
        });
    }
    [Fact]
    public void GuideShowsAClipboardFailureInsteadOfSayingCopied()
    {
        RunSta(() =>
        {
            var guide = new ServerGuideView(_ => throw new InvalidOperationException("クリップボードが使用中です。"), _ => { });
            Click(guide, "URLと依頼文をコピー");
            Assert.Contains(Descendants<TextBlock>(guide), text => text.Text.Contains("コピーできませんでした。") && text.Visibility == Visibility.Visible);
            Assert.DoesNotContain(Descendants<Button>(guide), button => System.Windows.Automation.AutomationProperties.GetName(button) == "コピーしました");
        });
    }
    [Fact]
    public void LoginAndFailureScreensCallTheirActionsAndShowTheirText()
    {
        RunSta(() =>
        {
            var login = 0; var again = 0; var change = 0;
            var signIn = new LoginView(() => login++);
            Click(signIn, "ログインして始める"); Assert.Equal(1, login);
            var texts = Descendants<TextBlock>(signIn).Select(text => text.Text).ToArray(); Assert.Contains("いつでも、あなたのチームと。", texts); Assert.Contains("Cloudflare Accessで安全に接続します", texts);
            var failure = new StartupFailureView("サーバーが応答しません。", "bell.example.com", () => { again++; return Task.CompletedTask; }, () => change++, () => true);
            Click(failure, "もう一度試す"); Click(failure, "接続先を変更"); Assert.Equal((1, 1), (again, change));
            var shown = Descendants<TextBlock>(failure).Select(text => text.Text).ToArray(); Assert.Contains("BellTeamにつながりません", shown); Assert.Contains("接続先 bell.example.com", shown);
            // The raw error is folded under 「詳細」 (closed), not printed in the page.
            var fold = Descendants<Expander>(failure).Single(); Assert.Equal("詳細", fold.Header); Assert.False(fold.IsExpanded); Assert.Equal("サーバーが応答しません。", ((TextBox)fold.Content).Text);
            Assert.Contains("BellTeamを開いています", Descendants<TextBlock>(new StartupOpeningView()).Select(text => text.Text));
        });
    }
    [Fact]
    public void ChangingTheServerFromTheFailureScreenAsksFirstAndCancelChangesNothing()
    {
        RunSta(() =>
        {
            var change = 0; var asked = 0; var answer = false;
            var failure = new StartupFailureView("応答なし", "bell.example.com", () => Task.CompletedTask, () => change++, () => { asked++; return answer; });
            Click(failure, "接続先を変更"); Assert.Equal((1, 0), (asked, change));
            answer = true; Click(failure, "接続先を変更"); Assert.Equal((2, 1), (asked, change));
        });
    }
    [Fact]
    public void RetryOnTheFailureScreenReadsConnectingUntilTheAttemptEnds()
    {
        RunSta(() =>
        {
            var attempt = new TaskCompletionSource(); var tries = 0;
            var failure = new StartupFailureView("応答なし", null, () => { tries++; return attempt.Task; }, () => { }, () => true);
            Click(failure, "もう一度試す");
            var button = Named(failure, "接続しています…"); Assert.False(button.IsEnabled); Assert.False(Named(failure, "接続先を変更").IsEnabled); Assert.Equal(1, tries);
            attempt.SetResult(); Pump();
            Assert.True(Named(failure, "もう一度試す").IsEnabled); Assert.DoesNotContain(Descendants<TextBlock>(failure), text => text.Text.StartsWith("接続先 "));
        });
    }
    [Theory]
    [InlineData(null, StartupPhase.Setup)]
    [InlineData("", StartupPhase.Setup)]
    [InlineData("https://bell.example.com/", StartupPhase.Checking)]
    public void StartupBeginsAtTheServerEntryOnlyWithoutASavedServer(string? saved, StartupPhase phase) => Assert.Equal(phase, StartupRoute.Initial(saved));
    [Theory]
    [InlineData(false, false, null, StartupPhase.Failure)]
    [InlineData(false, true, null, StartupPhase.Failure)]
    [InlineData(true, false, null, StartupPhase.SignIn)]
    [InlineData(true, true, "ready", StartupPhase.SignIn)]
    [InlineData(false, true, "select_harness", StartupPhase.Onboarding)]
    [InlineData(false, true, "authenticate", StartupPhase.Onboarding)]
    [InlineData(false, true, "ready", StartupPhase.Ready)]
    public void ConnectionResultRoutesToLoginFailureOnboardingOrTheWorkspace(bool needsLogin, bool connected, string? setupPhase, StartupPhase expected)
    {
        var setup = setupPhase is null ? null : new SetupState { Phase = setupPhase, Harnesses = [], Complete = false };
        Assert.Equal(expected, StartupRoute.AfterConnect(needsLogin, connected, setup));
    }
    private static Button Named(DependencyObject root, string name) => Descendants<Button>(root).Single(button => System.Windows.Automation.AutomationProperties.GetName(button) == name);
    private static void Click(DependencyObject root, string name) => Named(root, name).RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
    private static void Settle(OnboardingView view) { var until = DateTime.UtcNow.AddSeconds(5); Pump(); while (view.Busy) { if (DateTime.UtcNow > until) throw new TimeoutException(); Pump(); Thread.Sleep(1); } }
    private static IEnumerable<T> Descendants<T>(DependencyObject root) where T : DependencyObject { if (root is T found) yield return found; foreach (var child in LogicalTreeHelper.GetChildren(root).OfType<DependencyObject>()) foreach (var item in Descendants<T>(child)) yield return item; }
    private static void Pump() { var frame = new DispatcherFrame(); Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() => frame.Continue = false)); Dispatcher.PushFrame(frame); }
    private static void Await(Task task) { var until = DateTime.UtcNow.AddSeconds(5); while (!task.IsCompleted) { if (DateTime.UtcNow > until) throw new TimeoutException(); Pump(); Thread.Sleep(1); } task.GetAwaiter().GetResult(); }
    private static void RunSta(Action action)
    {
        Exception? failure = null; var thread = new Thread(() => { try { SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(Dispatcher.CurrentDispatcher)); action(); } catch (Exception error) { failure = error; } finally { Dispatcher.CurrentDispatcher.InvokeShutdown(); } });
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join(); if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }
}
