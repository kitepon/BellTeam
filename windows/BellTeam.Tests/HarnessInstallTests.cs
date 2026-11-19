using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;

// a451 (harness-cli.md): the press, the poll while busy, and what the login page and onboarding show for an AI that is not installed.
public sealed class HarnessInstallTests
{
    private static string Install(string state, bool busy, string message, bool press) => JsonSerializer.Serialize(new { harness = "codex", install = new { state, version = (string?)null, source = (string?)null, busy, lastError = (object?)null, message, action = press ? "install" : null, label = "最新版を入れる" } });
    private const string Missing = "まだ入っていません。「最新版を入れる」で入れてください。";

    [Fact]
    public async Task APressPostsOnceThenReadsUntilTheInstallEndsAndAFailedReadDoesNotEndTheWait()
    {
        var calls = new List<string>(); var reads = 0;
        using var api = new BellApi(new("http://localhost/"), new StubHandler((request, _) =>
        {
            calls.Add(request.Method + " " + request.RequestUri!.AbsolutePath);
            if (request.Method == HttpMethod.Post) return Task.FromResult(StubHandler.Json(Install("installing", true, "入れています。", false)));
            reads++;
            if (reads == 1) return Task.FromResult(StubHandler.Json("""{"error":"TEMPORARY"}""", HttpStatusCode.ServiceUnavailable));
            return Task.FromResult(StubHandler.Json(reads == 2 ? Install("installing", true, "入れています。", false) : Install("installed", false, "入っています。", true)));
        }));
        var runner = new HarnessInstallRunner(new HarnessAuthenticationApi(api), "codex", null, CancellationToken.None, TimeSpan.FromMilliseconds(5));
        await runner.PressAsync();
        Assert.Equal("installed", runner.Install!.State); Assert.Null(runner.Error);
        Assert.Equal(["POST /api/harness-auth/codex/install", "GET /api/harness-auth/codex/install", "GET /api/harness-auth/codex/install", "GET /api/harness-auth/codex/install"], calls);
    }

    [Fact]
    public async Task ThePressSaysItIsStartingOnlyWhileThePostIsInFlightAndOnlyAnAiThatCannotRunWarns()
    {
        var gate = new TaskCompletionSource<string>(); var labels = new List<string>(); HarnessInstallRunner? runner = null;
        using var api = new BellApi(new("http://localhost/"), new StubHandler(async (request, _) => StubHandler.Json(await gate.Task)));
        runner = new HarnessInstallRunner(new HarnessAuthenticationApi(api), "codex", null, CancellationToken.None, TimeSpan.FromMilliseconds(5));
        runner.Changed += () => labels.Add(runner.PressLabel);
        var press = runner.PressAsync(); Assert.Equal("始めています…", labels[0]); Assert.True(runner.Pressing);
        gate.SetResult(Install("installed", false, "入っています。", true)); await press;
        Assert.False(runner.Pressing); Assert.Equal("最新版を入れる", runner.PressLabel);
        HarnessCliInstall Of(string state, string? error = null) => new() { State = state, LastError = error is null ? null : new("X", error) };
        Assert.True(Of("not_installed").Warns); Assert.True(Of("installing").Warns); Assert.True(Of("failed").Warns); Assert.True(Of("installed", "x").Warns);
        Assert.False(Of("installed").Warns); Assert.False(Of("checking").Warns);
    }

    [Fact]
    public void ANotInstalledAiShowsTheServerSentenceAndOnlyTheButtonThenReadsItsLoginOnceInstalled()
    {
        RunSta(() =>
        {
            var calls = new List<string>();
            using var workspace = Workspace(request =>
            {
                calls.Add(request.Method + " " + request.RequestUri!.AbsolutePath);
                return request.Method == HttpMethod.Post ? Install("installed", false, "入っています。", true) : """{"harness":"codex","auth":{"status":"authenticated","input_required":false}}""";
            });
            var missing = JsonSerializer.Deserialize<HarnessCliInstallResponse>(Install("not_installed", false, Missing, true), BellApi.Json)!.Install;
            var window = new HarnessAuthenticationWindow(workspace, new("codex", "Codex", 2, null, Install: missing), _ => true);
            Await(window.InitializeAsync());
            // The login routes answer 409 while it is absent, so nothing is read and no login button is offered.
            Assert.Empty(calls); Assert.Contains(Descendants<TextBlock>(window), text => text.Text == Missing && text.Foreground == SettingsUi.Orange);
            Assert.DoesNotContain(Descendants<Button>(window), button => button.Content as string is "認証する" or "認証し直す");
            Descendants<Button>(window).Single(button => button.Content as string == "最新版を入れる").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            var until = DateTime.UtcNow.AddSeconds(5); while (window.Authentication is null) { if (DateTime.UtcNow > until) throw new TimeoutException(); Pump(); Thread.Sleep(2); }
            Assert.Equal(["POST /api/harness-auth/codex/install", "GET /api/harness-auth/codex"], calls); Assert.Equal("authenticated", window.Authentication!.Status);
            window.Close();
        });
    }

    [Fact]
    public void OnboardingShowsTheInstallSentenceInsteadOfTheLoginAndPressesTheSetupInstallRoute()
    {
        RunSta(() =>
        {
            var paths = new List<string>();
            const string absent = """{"phase":"authenticate","harness":"codex","harnesses":[{"id":"codex","name":"Codex"}],"guideBotId":null,"complete":false,"auth":{"status":"blocked","message":"x"},"install":{"state":"not_installed","busy":false,"message":"まだ入っていません。「最新版を入れる」で入れてください。","action":"install","label":"最新版を入れる"}}""";
            const string waiting = """{"phase":"authenticate","harness":"codex","harnesses":[{"id":"codex","name":"Codex"}],"guideBotId":null,"complete":false,"auth":{"status":"waiting"},"install":{"state":"installed","busy":false,"message":"入っています。","action":"install","label":"最新版を入れる"}}""";
            using var api = new BellApi(new("http://localhost/"), new StubHandler((request, _) => { paths.Add(request.Method + " " + request.RequestUri!.AbsolutePath); return Task.FromResult(StubHandler.Json(waiting)); }));
            var view = new OnboardingView(new SetupApi(api), JsonSerializer.Deserialize<SetupState>(absent, BellApi.Json)!, _ => Task.CompletedTask, () => { });
            Assert.Contains(Descendants<TextBlock>(view), text => text.Text == Missing);
            Assert.DoesNotContain(Descendants<TextBlock>(view), text => text.Text == "公式認証の完了を待っています。" || text.Text == "認証に必要な操作を確認してください。");
            Assert.False(Named(view, "認証を確認して始める").IsEnabled);
            Named(view, "最新版を入れる").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            var until = DateTime.UtcNow.AddSeconds(5); while (view.Busy) { if (DateTime.UtcNow > until) throw new TimeoutException(); Pump(); Thread.Sleep(1); }
            Assert.Equal(["POST /api/setup/install"], paths); Assert.Equal("waiting", view.State.Auth!.Status); Assert.True(view.Polling);
            view.Dispose();
        });
    }

    private static Workspace Workspace(Func<HttpRequestMessage, string> auth)
    {
        var workspace = new Workspace(origin => new BellApi(origin, new StubHandler((request, _) => Task.FromResult(request.RequestUri!.AbsolutePath.StartsWith("/api/harness-auth") ? StubHandler.Json(auth(request)) : StubHandler.Json(request.RequestUri.AbsolutePath switch { "/api/session" => """{"authenticated":true,"authMode":"local"}""", "/api/bots" => ApiTests.Bots, "/api/rooms" => ApiTests.Rooms, "/api/queue" => """{"items":[]}""", "/api/owner" => """{"owner":{"name":"利用者"}}""", _ => ApiTests.Page })))));
        Await(workspace.ConnectAsync("http://localhost", listen: false)); return workspace;
    }
    private static Button Named(DependencyObject root, string name) => Descendants<Button>(root).Single(button => System.Windows.Automation.AutomationProperties.GetName(button) == name || button.Content as string == name);
    private static IEnumerable<T> Descendants<T>(DependencyObject root) where T : DependencyObject { if (root is T found) yield return found; foreach (var child in LogicalTreeHelper.GetChildren(root).OfType<DependencyObject>()) foreach (var item in Descendants<T>(child)) yield return item; }
    private static void Pump() { var frame = new DispatcherFrame(); Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() => frame.Continue = false)); Dispatcher.PushFrame(frame); }
    private static void Await(Task task) { var until = DateTime.UtcNow.AddSeconds(5); while (!task.IsCompleted) { if (DateTime.UtcNow > until) throw new TimeoutException(); Pump(); Thread.Sleep(1); } task.GetAwaiter().GetResult(); }
    private static void RunSta(Action action) { Exception? failure = null; var thread = new Thread(() => { try { SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(Dispatcher.CurrentDispatcher)); action(); } catch (Exception error) { failure = error; } finally { Dispatcher.CurrentDispatcher.InvokeShutdown(); } }); thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join(); if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw(); }
}
