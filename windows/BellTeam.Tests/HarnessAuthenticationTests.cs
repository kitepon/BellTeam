using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Threading;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;

public sealed class HarnessAuthenticationTests
{
    private const string Secret = "模擬の認証入力-記録しない";
    private const string Waiting = """{"harness":"codex","auth":{"status":"waiting","url":"https://example.com/login","user_code":"TEST-CODE","input_required":true,"message":"公式サイトで認証してください。"}}""";
    private const string Authenticated = """{"harness":"codex","auth":{"status":"authenticated","input_required":false}}""";
    private static readonly HarnessAuthenticationOption Option = new("codex", "Codex", 3, "始めると今の認証が消えます。");
    [Fact]
    public async Task RoutesFieldsAndCancelNullMatchServer()
    {
        var paths = new Queue<string>(["", "/codex", "/codex/start", "/codex/input", "/codex/input", "/codex/cancel"]);
        using var api = new BellApi(new("http://localhost/"), new StubHandler(async (request, token) =>
        {
            var path = paths.Dequeue(); Assert.Equal("/api/harness-auth" + path, request.RequestUri!.AbsolutePath);
            Assert.Equal(path is "" or "/codex" ? HttpMethod.Get : HttpMethod.Post, request.Method);
            if (path.EndsWith("/input")) { using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token)); Assert.Single(body.RootElement.EnumerateObject()); if (paths.Count == 2) Assert.Equal(Secret, body.RootElement.GetProperty("text").GetString()); else Assert.Equal("Enter", body.RootElement.GetProperty("key").GetString()); }
            return StubHandler.Json(path == "" ? """{"harnesses":[{"id":"codex","name":"Codex","members":3,"startWarning":"認証が消えます。"}]}""" : path.EndsWith("/cancel") ? """{"harness":"codex","auth":null}""" : Waiting);
        }));
        var auth = new HarnessAuthenticationApi(api); var options = (await auth.ListAsync()).Harnesses; Assert.Equal("3人が使用", options[0].UsageText); Assert.True(options[0].NeedsStartConfirmation(null));
        Assert.True((await auth.StatusAsync("codex")).Auth!.InputRequired); await auth.StartAsync("codex"); await auth.InputAsync("codex", Secret, null); await auth.InputAsync("codex", null, "Enter"); Assert.Null((await auth.CancelAsync("codex")).Auth); Assert.Empty(paths);
    }
    [Theory]
    [InlineData(true)] [InlineData(false)]
    public void UnsupportedReloginRemovesStartAndSendsNothing(bool supported)
    {
        Sta(() =>
        {
            var posts = 0;
            using var workspace = CreateWorkspace((request, _) => { if (request.Method == HttpMethod.Post) posts++; return Task.FromResult(StubHandler.Json(Authenticated)); });
            var option = Option with { ReloginSupported = supported };
            var window = new HarnessAuthenticationWindow(workspace, option, _ => true);
            Await(window.InitializeAsync());
            Assert.Equal(supported, Find<Button>(window).Any(button => button.Content as string == "認証し直す"));
            Await(window.StartAsync()); Assert.Equal(supported ? 1 : 0, posts);
            Assert.Contains(Find<Button>(window), button => button.Content as string == "状態を更新");
            window.Close();
        });
    }
    [Fact]
    public async Task TypedAuthenticationResponsesKeepBindingAndPromptForSettingsAndSetup()
    {
        const string wire = """{"schema":"aiterm.auth-ui.v1","stage":"select","binding":{"session_id":"owned","launch_id":null},"prompt_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","choices":[{"id":"google","label":"Googleでログイン"}]}""";
        var ui = JsonSerializer.Deserialize<AuthenticationUi>(wire, BellApi.Json)!;
        Assert.Equal(ui, JsonSerializer.Deserialize<AuthenticationUi>(wire, BellApi.Json));
        using var api = new BellApi(new("http://localhost/"), new StubHandler(async (request, token) =>
        {
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
            Assert.Equal("owned", body.RootElement.GetProperty("binding").GetProperty("session_id").GetString());
            Assert.Equal(new string('a', 64), body.RootElement.GetProperty("prompt_digest").GetString());
            Assert.Equal(3, body.RootElement.EnumerateObject().Count());
            return StubHandler.Json(request.RequestUri!.AbsolutePath.StartsWith("/api/setup")
                ? """{"phase":"authenticate","harnesses":[],"complete":false,"auth":{"status":"authenticated"}}""" : Authenticated);
        }));
        await new HarnessAuthenticationApi(api).RespondAsync("codex", ui, new { kind = "choice", id = "google" });
        await new SetupApi(api).RespondAsync(ui, new { kind = "authorization_code", value = Secret });
    }
    [Theory]
    [InlineData(false)] [InlineData(true)]
    public void UnsupportedReloginAllowsTypedFirstAuthenticationAndBlocksUnknownInput(bool failInput)
    {
        Sta(() =>
        {
            var stage = "blocked"; var posts = 0;
            var ui = new AuthenticationUi { Schema = "aiterm.auth-ui.v1", Stage = "select", Title = "ログイン方法", Binding = new("owned", null), PromptDigest = new string('a', 64), Choices = [new("google", "Googleでログイン")] };
            string Current() => JsonSerializer.Serialize(new { harness = "antigravity", auth = new AuthenticationState { Status = stage is "blocked" or "authenticated" ? stage : "waiting", AuthUi = stage is "select" or "paste_code" ? ui with { Stage = stage, Input = stage == "paste_code" ? "authorization_code" : null } : null } }, BellApi.Json);
            using var workspace = CreateWorkspace(async (request, token) =>
            {
                if (request.Method == HttpMethod.Post)
                {
                    posts++;
                    if (request.RequestUri!.AbsolutePath.EndsWith("/start")) stage = "select";
                    else
                    {
                        using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
                        Assert.Equal("owned", body.RootElement.GetProperty("binding").GetProperty("session_id").GetString());
                        Assert.Equal(new string('a', 64), body.RootElement.GetProperty("prompt_digest").GetString());
                        var response = body.RootElement.GetProperty("response");
                        if (response.GetProperty("kind").GetString() == "choice") { Assert.Equal("google", response.GetProperty("id").GetString()); stage = "paste_code"; }
                        else { Assert.Equal(Secret, response.GetProperty("value").GetString()); if (failInput) return StubHandler.Json(JsonSerializer.Serialize(new { message = Secret }), HttpStatusCode.BadGateway); stage = "authenticated"; }
                    }
                }
                return StubHandler.Json(Current());
            });
            var option = Option with { Id = "antigravity", Name = "Antigravity", ReloginSupported = false };
            var window = new HarnessAuthenticationWindow(workspace, option, _ => throw new InvalidOperationException("初回認証で資格の破棄を確認しない"));
            Await(window.InitializeAsync()); Assert.Equal(0, posts);
            Assert.Contains(Find<Button>(window), button => button.Content as string == "認証する");
            Await(window.StartAsync());
            Find<Button>(window).Single(button => button.Content as string == "Googleでログイン").RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); Pump();
            var input = Find<PasswordBox>(window).Single(); input.Password = Secret;
            var poll = typeof(HarnessAuthenticationWindow).GetMethod("PollAsync", BindingFlags.Instance | BindingFlags.NonPublic)!;
            Await((Task)poll.Invoke(window, null)!); Assert.Equal(Secret, input.Password);
            Find<Button>(window).Single(button => button.Content as string == "認証を完了する").RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); Pump();
            Assert.Equal(3, posts); Assert.Empty(input.Password); Assert.Empty(Find<PasswordBox>(window));
            Assert.All(Find<TextBlock>(window), text => Assert.DoesNotContain(Secret, text.Text));
            if (failInput) { Await(window.InitializeAsync()); Assert.Single(Find<PasswordBox>(window)); }
            else { Assert.Equal("authenticated", window.Authentication!.Status); Assert.DoesNotContain(Find<Button>(window), button => button.Content as string is "認証する" or "認証し直す"); }
            window.Close();
        });
    }
    [Theory]
    [InlineData(400)] [InlineData(307)] [InlineData(0)]
    public async Task InputFailureDoesNotIncludeValueOrInnerException(int status)
    {
        using var api = new BellApi(new("http://localhost/"), new StubHandler((_, _) => status == 0 ? Task.FromException<HttpResponseMessage>(new HttpRequestException(Secret)) : Task.FromResult(StubHandler.Json(JsonSerializer.Serialize(new { message = Secret }), (HttpStatusCode)status))));
        var error = await Assert.ThrowsAsync<BellApiException>(() => new HarnessAuthenticationApi(api).InputAsync("codex", Secret, null)); Assert.DoesNotContain(Secret, error.ToString()); Assert.Null(error.InnerException);
    }
    [Fact]
    public void WarningCancellationSendsNothingAndBlockedStatusDoesNotAsk()
    {
        Sta(() =>
        {
            var posts = 0; var confirms = 0; var response = Authenticated;
            using var workspace = CreateWorkspace((request, _) => { if (request.Method == HttpMethod.Post) posts++; return Task.FromResult(StubHandler.Json(request.Method == HttpMethod.Post ? Waiting : response)); });
            var window = new HarnessAuthenticationWindow(workspace, Option, _ => { confirms++; return false; }); Await(window.InitializeAsync()); Await(window.StartAsync()); Assert.Equal(1, confirms); Assert.Equal(0, posts);
            response = """{"harness":"codex","auth":{"status":"blocked","input_required":false}}"""; Await(window.InitializeAsync()); Await(window.StartAsync()); Assert.Equal(1, confirms); Assert.Equal(1, posts); Assert.True(window.Started); Assert.Equal(IntPtr.Zero, new WindowInteropHelper(window).Handle); window.Close();
        });
    }
    [Fact]
    public void InputSurvivesUnchangedPollAndIsClearedOnFailureDeactivationAndClose()
    {
        Sta(() =>
        {
            using var workspace = CreateWorkspace((request, _) => Task.FromResult(request.RequestUri!.AbsolutePath.EndsWith("/input") ? StubHandler.Json(JsonSerializer.Serialize(new { message = Secret }), HttpStatusCode.BadRequest) : StubHandler.Json(Waiting)));
            var window = new HarnessAuthenticationWindow(workspace, Option, _ => true); Await(window.InitializeAsync()); Await(window.StartAsync());
            var input = Find<PasswordBox>(window).Single(); input.Password = Secret;
            var poll = typeof(HarnessAuthenticationWindow).GetMethod("PollAsync", BindingFlags.Instance | BindingFlags.NonPublic)!;
            Await((Task)poll.Invoke(window, null)!); Assert.Equal(Secret, input.Password); Assert.True(input.IsEnabled);
            Find<Button>(window).Single(button => button.Content as string == "入力を送る").RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); Pump(); Assert.Empty(input.Password);
            Assert.All(Find<TextBlock>(window), text => Assert.DoesNotContain(Secret, text.Text));
            input.Password = Secret; typeof(Window).GetMethod("OnDeactivated", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(window, [EventArgs.Empty]); Assert.Empty(input.Password);
            input.Password = Secret; window.Close(); Assert.Empty(input.Password);
        });
    }
    [Fact]
    public void CompletedAuthenticationRemovesInputAndCancelRefreshesOfficialStatus()
    {
        Sta(() =>
        {
            var response = Waiting; var paths = new List<string>();
            using var workspace = CreateWorkspace((request, _) => { var path = request.RequestUri!.AbsolutePath; paths.Add(path); return Task.FromResult(StubHandler.Json(path.EndsWith("/cancel") ? """{"harness":"codex","auth":null}""" : response)); });
            var window = new HarnessAuthenticationWindow(workspace, Option, _ => true); Await(window.InitializeAsync()); Await(window.StartAsync());
            Find<Button>(window).Single(button => button.Content as string == "やめる").RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); Pump(); Assert.False(window.Started); Assert.EndsWith("/codex/cancel", paths[^2]); Assert.EndsWith("/codex", paths[^1]);
            Await(window.StartAsync()); response = Authenticated; Await(window.InitializeAsync()); Assert.False(window.Started); Assert.Empty(Find<PasswordBox>(window)); window.Close();
        });
    }
    private static Workspace CreateWorkspace(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> authentication)
    {
        var workspace = new Workspace(origin => new BellApi(origin, new StubHandler((request, token) => request.RequestUri!.AbsolutePath.StartsWith("/api/harness-auth") ? authentication(request, token) : Task.FromResult(StubHandler.Json(request.RequestUri.AbsolutePath switch { "/api/session" => """{"authenticated":true,"authMode":"local"}""", "/api/bots" => ApiTests.Bots, "/api/rooms" => ApiTests.Rooms, "/api/queue" => """{"items":[]}""", "/api/owner" => """{"owner":{"name":"利用者"}}""", _ => ApiTests.Page })))));
        Await(workspace.ConnectAsync("http://localhost", listen: false)); return workspace;
    }
    private static IEnumerable<T> Find<T>(DependencyObject root) where T : DependencyObject { if (root is T match) yield return match; foreach (var child in LogicalTreeHelper.GetChildren(root).OfType<DependencyObject>()) foreach (var item in Find<T>(child)) yield return item; }
    private static void Pump() { var frame = new DispatcherFrame(); Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() => frame.Continue = false)); Dispatcher.PushFrame(frame); }
    private static void Await(Task task) { var until = DateTime.UtcNow.AddSeconds(5); while (!task.IsCompleted) { if (DateTime.UtcNow > until) throw new TimeoutException(); Pump(); Thread.Sleep(1); } task.GetAwaiter().GetResult(); }
    private static void Sta(Action action) { Exception? failure = null; var thread = new Thread(() => { try { SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(Dispatcher.CurrentDispatcher)); action(); } catch (Exception error) { failure = error; } finally { Dispatcher.CurrentDispatcher.InvokeShutdown(); } }); thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join(); if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw(); }
}
