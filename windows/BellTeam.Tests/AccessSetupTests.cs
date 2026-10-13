using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
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
    [Fact]
    public void SetupInputIsClearedOnFailedSendDeactivationAndClose()
    {
        RunSta(() =>
        {
            var posts = 0;
            using var workspace = new Workspace(origin => new BellApi(origin, new StubHandler((request, _) =>
            {
                if (request.Method == HttpMethod.Post) { posts++; return Task.FromResult(StubHandler.Json(JsonSerializer.Serialize(new { message = FakeSecret }), HttpStatusCode.BadRequest)); }
                return Task.FromResult(StubHandler.Json(request.RequestUri!.AbsolutePath switch { "/api/session" => "{\"authenticated\":true,\"authMode\":\"local\"}", "/api/bots" => ApiTests.Bots, "/api/rooms" => ApiTests.Rooms, _ => ApiTests.Page }));
            })));
            Await(workspace.ConnectAsync("http://localhost", listen: false));
            var window = new SetupWindow(workspace, JsonSerializer.Deserialize<SetupState>(Waiting, BellApi.Json)!);
            var input = Descendants<PasswordBox>(window).Single(); input.Password = FakeSecret;
            Descendants<Button>(window).Single(button => (string)button.Content == "入力を送る").RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); Pump(); Assert.Equal(1, posts); Assert.Empty(input.Password);
            Assert.All(Descendants<TextBlock>(window), text => Assert.DoesNotContain(FakeSecret, text.Text));
            input.Password = FakeSecret; typeof(Window).GetMethod("OnDeactivated", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(window, [EventArgs.Empty]); Assert.Empty(input.Password);
            input.Password = FakeSecret; window.Close(); Assert.Empty(input.Password);
        });
    }
    [Fact]
    public void SetupStatusRefreshKeepsUnsubmittedInputAndStartCompletesOnlyOnReady()
    {
        RunSta(() =>
        {
            var posts = 0;
            using var workspace = new Workspace(origin => new BellApi(origin, new StubHandler((request, _) =>
            {
                if (request.Method == HttpMethod.Post) { posts++; Assert.EndsWith("/setup/start", request.RequestUri!.AbsolutePath); return Task.FromResult(StubHandler.Json("{\"phase\":\"ready\",\"harness\":\"codex\",\"harnesses\":[],\"guideBotId\":\"bot-guide\",\"complete\":false,\"auth\":null}")); }
                return Task.FromResult(StubHandler.Json(request.RequestUri!.AbsolutePath switch { "/api/session" => "{\"authenticated\":true,\"authMode\":\"local\"}", "/api/bots" => ApiTests.Bots, "/api/rooms" => ApiTests.Rooms, "/api/setup" => Waiting, _ => ApiTests.Page }));
            })));
            Await(workspace.ConnectAsync("http://localhost", listen: false));
            var window = new SetupWindow(workspace, JsonSerializer.Deserialize<SetupState>(Waiting, BellApi.Json)!);
            var input = Descendants<PasswordBox>(window).Single(); input.Password = FakeSecret;
            Descendants<Button>(window).Single(button => (string)button.Content == "認証の状態を更新").RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); Pump(); Assert.Equal(FakeSecret, input.Password); Assert.Equal(0, posts);
            Descendants<Button>(window).Single(button => (string)button.Content == "認証を確認して始める").RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); Pump(); Assert.Equal("ready", window.State.Phase); Assert.Empty(input.Password); Assert.Equal(1, posts);
        });
    }
    private static IEnumerable<T> Descendants<T>(DependencyObject root) where T : DependencyObject { if (root is T found) yield return found; foreach (var child in LogicalTreeHelper.GetChildren(root).OfType<DependencyObject>()) foreach (var item in Descendants<T>(child)) yield return item; }
    private static void Pump() { var frame = new DispatcherFrame(); Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() => frame.Continue = false)); Dispatcher.PushFrame(frame); }
    private static void Await(Task task) { var until = DateTime.UtcNow.AddSeconds(5); while (!task.IsCompleted) { if (DateTime.UtcNow > until) throw new TimeoutException(); Pump(); Thread.Sleep(1); } task.GetAwaiter().GetResult(); }
    private static void RunSta(Action action)
    {
        Exception? failure = null; var thread = new Thread(() => { try { SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(Dispatcher.CurrentDispatcher)); action(); } catch (Exception error) { failure = error; } finally { Dispatcher.CurrentDispatcher.InvokeShutdown(); } });
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join(); if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }
}
