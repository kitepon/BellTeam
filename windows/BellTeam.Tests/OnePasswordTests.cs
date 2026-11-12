using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;

// W-MAC 15: the 1Password連携 setting (Mac OnePasswordState / OnePasswordResult / OnePasswordSettingEditor, Web showOnePasswordResult).
public sealed class OnePasswordTests
{
    private const string Token = "ops_TEST-TOKEN-DO-NOT-LOG";
    private const string Rejected = "1Passwordがこのトークンを受け付けませんでした。トークンを作り直して貼り直すか、ネットワークを確かめてください。";
    private const string Guide = """{"steps":["一つ目","二つ目"],"link":{"label":"手順を開く","url":"https://developer.1password.com/docs/service-accounts/"}}""";
    private static string Item(string status, bool configured, string? error = null, string? connection = null, string guide = Guide)
        => $$"""{"id":"onePassword","title":"1Password連携","enabled":{{(status == "enabled" ? "true" : "false")}},"status":"{{status}}","fields":[{"key":"token","label":"サービスアカウントのトークン","secret":true,"value":"","configured":{{(configured ? "true" : "false")}}}],"error":{{error ?? "null"}},"guide":{{guide}}{{(connection is null ? "" : ",\"connection\":" + connection)}}}""";
    private const string Vaults = """{"vaults":["Infra","Team"],"sshKeys":3}""";
    private static FeatureSetting Read(string json) { using var document = JsonDocument.Parse(json); return FeatureSetting.Read(document.RootElement); }

    [Fact]
    public async Task OldOrBrokenGuideAndConnectionNeverFailTheList()
    {
        var items = string.Join(",", Item("enabled", true, guide: """{"steps":"not a list"}""", connection: """{"vaults":"x","sshKeys":"3"}"""),
            """{"id":"calendar","title":"カレンダー","enabled":false,"status":"disabled","fields":[]}""", Item("disabled", false, guide: """{"steps":["a"],"link":{"label":"l"}}""", connection: "null"));
        using var api = new BellApi(new("http://localhost/"), new StubHandler((_, _) => Task.FromResult(StubHandler.Json("{\"settings\":[" + items + "]}"))));
        var list = await new PlanningApi(api).FeaturesAsync();
        Assert.Equal(3, list.Length);
        Assert.All(new[] { list[0], list[2] }, setting => { Assert.Null(setting.Guide); Assert.Null(setting.Connection); });
        Assert.Equal("1Passwordにつながっています。", OnePasswordItem.ConnectionLine(list[0])); // connected without a readable connection
        Assert.Equal(OnePasswordState.Failed, OnePasswordItem.State(Read(Item("enabled", true, """{"code":"X","message":"理由"}"""))));
        Assert.Equal("calendar", list[1].Id); Assert.Null(list[1].Guide);
    }

    [Fact]
    public void GuideAndConnectionAreReadWhenWellFormed()
    {
        var setting = Read(Item("enabled", true, connection: Vaults));
        Assert.Equal(["一つ目", "二つ目"], setting.Guide!.Steps); Assert.Equal(["Infra", "Team"], setting.Connection!.Vaults); Assert.Equal(3, setting.Connection.SshKeys);
    }

    [Theory]
    [InlineData("enabled", null, OnePasswordState.Connected, "連携中")]
    [InlineData("disabled", null, OnePasswordState.Off, "未連携")]
    [InlineData("unconfigured", null, OnePasswordState.Off, "未連携")]
    [InlineData("enabled", """{"code":"ONEPASSWORD_TOKEN_REJECTED","message":"拒否"}""", OnePasswordState.Failed, "失敗")]
    [InlineData("disabled", """{"code":"ONEPASSWORD_CLI_MISSING","message":"部品なし"}""", OnePasswordState.Failed, "失敗")]
    public void BadgeFollowsTheConnectionResultNotTheGenericState(string status, string? error, OnePasswordState state, string text)
    {
        var setting = Read(Item(status, true, error)); Assert.Equal(state, OnePasswordItem.State(setting)); Assert.Equal(text, OnePasswordItem.BadgeText(state));
        if (error is not null) Assert.Equal(error.Contains("拒否") ? "拒否" : "部品なし", setting.ErrorMessage);
    }

    [Fact]
    public void ConnectionLineIsShownOnlyWhileConnectedWithWebsWording()
    {
        Assert.Equal("読める保管庫：Infra、Team　SSH鍵：3件", OnePasswordItem.ConnectionLine(Read(Item("enabled", true, connection: Vaults))));
        Assert.Equal("読める保管庫：なし　SSH鍵が見つかりません。読める保管庫にSSH鍵を入れるか、サービスアカウントに鍵のある保管庫を足してください。", OnePasswordItem.ConnectionLine(Read(Item("enabled", true, connection: """{"vaults":[],"sshKeys":0}"""))));
        Assert.Null(OnePasswordItem.ConnectionLine(Read(Item("disabled", true, connection: Vaults))));
        Assert.Null(OnePasswordItem.ConnectionLine(Read(Item("enabled", true, """{"code":"X","message":"m"}""", Vaults))));
    }

    [Theory]
    [InlineData("ops_abc", true, false, false)]
    [InlineData("  ops_abc \n", true, false, false)]    // trimmed before the check
    [InlineData("abc", true, false, true)]
    [InlineData("op_abc", true, false, true)]
    [InlineData("", true, false, true)]               // nothing configured yet: a token is needed
    [InlineData("", true, true, false)]               // configured: an empty save only toggles
    [InlineData("abc", true, true, true)]             // a pasted token is always checked
    [InlineData("", false, false, false)]             // turning off needs no token
    public void OnlyTokensStartingWithOpsUnderscoreAreSent(string pasted, bool enabled, bool configured, bool problem)
        => Assert.Equal(problem, OnePasswordItem.SaveProblem(enabled, pasted, configured) is not null);

    [Fact]
    public void GuideLinksOpenOnlyOverHttps()
    {
        FeatureGuide Guided(string url) => new(["s"], new GuideLink("手順", url));
        Assert.Equal("https://developer.1password.com/docs/service-accounts/", Guided("https://developer.1password.com/docs/service-accounts/").OpenableLink!.Value.Url.AbsoluteUri);
        foreach (var url in new[] { "http://example.com/", "javascript:alert(1)", "file:///c:/windows", "ftp://example.com", "https://", "/relative", "not a url" }) Assert.Null(Guided(url).OpenableLink);
        Assert.Null(new FeatureGuide(["s"], null).OpenableLink);
    }

    [Fact]
    public void ResultLineIsDecidedByThePatchResponseAndRefreshesOnlyShowOrHideAFailure()
    {
        var connected = Read(Item("enabled", true, connection: Vaults)); var bare = Read(Item("enabled", true)); var off = Read(Item("disabled", true)); var failed = Read(Item("enabled", true, $$"""{"code":"ONEPASSWORD_TOKEN_REJECTED","message":"{{Rejected}}"}"""));
        Assert.Equal("連携できました。読める保管庫：Infra、Team　SSH鍵：3件", OnePasswordResult.Saved(connected).Text);
        Assert.Equal("連携できました。", OnePasswordResult.Saved(bare).Text); // no connection: no detail on the result line (same as Web)
        Assert.Equal("連携を解除しました。", OnePasswordResult.Saved(off).Text);
        Assert.Equal("連携できませんでした。" + Rejected, OnePasswordResult.Saved(failed).Text);
        Assert.Equal("", OnePasswordResult.None.Text); Assert.Equal("1Passwordにつないで確かめています…", OnePasswordResult.Checking.Text);
        // A refresh never overwrites a running check, shows a failure, hides a failure that cleared, and leaves the rest alone.
        Assert.Equal(OnePasswordResult.Checking, OnePasswordResult.Checking.Refreshed(failed));
        Assert.Equal(OnePasswordResult.Saved(failed), OnePasswordResult.None.Refreshed(failed));
        Assert.Equal(OnePasswordResult.None, OnePasswordResult.Saved(failed).Refreshed(connected));
        Assert.Equal(OnePasswordResult.Saved(connected), OnePasswordResult.Saved(connected).Refreshed(off));
        Assert.Equal(OnePasswordResult.None, OnePasswordResult.None.Refreshed(connected));
    }

    // ---- the page and the list row ----
    private sealed class Server
    {
        public string Settings = "";
        public Func<string, Task<HttpResponseMessage>> Patch = _ => throw new InvalidOperationException("no PATCH expected");
        public readonly List<string> Patches = [], Reads = [];
        public Workspace Workspace() => new(origin => new BellApi(origin, new StubHandler(async (request, token) =>
        {
            var path = request.RequestUri!.AbsolutePath;
            if (request.Method == HttpMethod.Patch) { var body = await request.Content!.ReadAsStringAsync(token); Patches.Add(path + " " + body); return await Patch(body); }
            if (path == "/api/settings") { Reads.Add(path); return StubHandler.Json(Settings); }
            return StubHandler.Json(path switch { "/api/session" => """{"authenticated":true,"authMode":"local"}""", "/api/bots" => ApiTests.Bots, "/api/queue" => ApiTests.EmptyQueue, "/api/rooms" => ApiTests.Rooms, "/api/owner" => ApiTests.Owner, _ => ApiTests.Page });
        })));
    }
    private static string List(params string[] items) => "{\"settings\":[" + string.Join(",", items) + "]}";
    private static (OnePasswordView View, StackPanel Form, Func<bool> Busy) Open(Workspace workspace, CancellationToken token = default)
    {
        Await(workspace.ConnectAsync("http://localhost", listen: false));
        var first = Await(workspace.Planning.FeaturesAsync()).Single(setting => setting.Id == OnePasswordItem.Id); var busy = false; var form = new StackPanel();
        var view = new OnePasswordView(workspace, first, form, token, value => busy = value); Await(view.Ready); Pump();
        return (view, form, () => busy);
    }
    // Only text a reader could see: a collapsed ancestor (the folded guide, an empty result line) hides what is inside it.
    private static bool Shown(DependencyObject? item) { for (; item is not null; item = LogicalTreeHelper.GetParent(item)) if (item is not Window && item is UIElement { Visibility: not Visibility.Visible }) return false; return true; }
    private static string[] Texts(DependencyObject root) => Descendants<TextBlock>(root).Where(Shown).Select(text => text.Text).Where(text => text.Length != 0).ToArray();
    private static Button SaveButton(DependencyObject root) => Descendants<Button>(root).Single(button => button.Content is string label && label.Contains("連携を"));
    private static void Click(Button button) { button.RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); Pump(); }
    private static void Settle(Func<bool> busy) { var until = DateTime.UtcNow.AddSeconds(5); Pump(); while (busy()) { if (DateTime.UtcNow > until) throw new TimeoutException(); Pump(); Thread.Sleep(1); } }

    [Fact]
    public void NotLinkedPageShowsTheGuideOpenAndRejectsATokenWithoutOpsUnderscoreBeforeAnyRequest()
    {
        RunSta(() =>
        {
            var server = new Server { Settings = List(Item("unconfigured", false)) }; using var workspace = server.Workspace();
            var (view, form, busy) = Open(workspace); var texts = Texts(form);
            Assert.Contains("作り方を見る", texts); Assert.Contains("一つ目", texts); Assert.Contains("手順を開く", texts.Concat(Descendants<Button>(form).Select(button => AutomationName(button))));
            Assert.Contains("ops_で始まるトークンを貼る", texts); Assert.DoesNotContain(texts, text => text.StartsWith("読める保管庫"));
            Assert.True(Descendants<CheckBox>(form).Single().IsChecked);       // unconfigured starts enabled (Mac)
            var box = Descendants<PasswordBox>(form).Single(); box.Password = "not-a-token"; Click(SaveButton(form)); Settle(busy);
            Assert.Contains("サービスアカウントのトークン（ops_で始まる文字）を貼ってください。", Texts(form)); Assert.Empty(server.Patches);
            view.ClearToken(); Assert.Empty(box.Password);
        });
    }

    [Fact]
    public void ConnectedPageFoldsTheGuideShowsTheConnectionLineAndAnEmptySaveOnlyToggles()
    {
        RunSta(() =>
        {
            var server = new Server { Settings = List(Item("enabled", true, connection: Vaults)) };
            server.Patch = _ => Task.FromResult(StubHandler.Json("{\"setting\":" + Item("disabled", true) + "}")); using var workspace = server.Workspace();
            var (_, form, busy) = Open(workspace); var texts = Texts(form);
            Assert.Contains("読める保管庫：Infra、Team　SSH鍵：3件", texts); Assert.Contains("作り方を見る", texts); Assert.DoesNotContain("一つ目", texts); // folded inside 「作り方を見る」
            Assert.Contains("登録済み・変更するときだけ入力", texts);
            Descendants<CheckBox>(form).Single().IsChecked = false; Click(SaveButton(form)); Settle(busy);
            Assert.Equal(["/api/settings/onePassword {\"values\":{},\"enabled\":false}"], server.Patches);
            Assert.Contains("連携を解除しました。", Texts(form));
        });
    }

    [Fact]
    public void SaveSendsOnePatchWithTheTrimmedTokenWaitsVisiblyThenShowsTheVaultLineAndClearsTheField()
    {
        RunSta(() =>
        {
            var release = new TaskCompletionSource(); var server = new Server { Settings = List(Item("unconfigured", false)) };
            server.Patch = async _ => { await release.Task; server.Settings = List(Item("enabled", true, connection: Vaults)); return StubHandler.Json("{\"setting\":" + Item("enabled", true, connection: Vaults) + "}"); };
            using var workspace = server.Workspace(); var (_, form, busy) = Open(workspace);
            var box = Descendants<PasswordBox>(form).Single(); box.Password = "  " + Token + " "; var button = SaveButton(form); Click(button);
            Assert.True(busy()); Assert.Empty(box.Password);                  // cleared on send, never shown back
            Assert.Equal("連携を確かめています…", (string)button.Content); Assert.False(button.IsEnabled); Assert.Contains("1Passwordにつないで確かめています…", Texts(form));
            release.SetResult(); Settle(busy);
            Assert.Single(server.Patches); Assert.Equal("/api/settings/onePassword {\"values\":{\"token\":\"" + Token + "\"},\"enabled\":true}", server.Patches[0]);
            var texts = Texts(form);
            Assert.Contains("連携できました。読める保管庫：Infra、Team　SSH鍵：3件", texts); Assert.Equal("保存して連携を確かめる", (string)SaveButton(form).Content);
            Assert.Empty(Descendants<PasswordBox>(form).Single().Password); Assert.All(texts, text => Assert.DoesNotContain(Token, text));
            Assert.DoesNotContain("一つ目", texts);                            // folded once connected
        });
    }

    [Fact]
    public void FailedConnectionShowsTheServersReasonOnTheResultLineOnly()
    {
        RunSta(() =>
        {
            var failed = Item("enabled", true, $$"""{"code":"ONEPASSWORD_TOKEN_REJECTED","message":"{{Rejected}}"}""");
            var server = new Server { Settings = List(Item("unconfigured", false)) }; server.Patch = _ => { server.Settings = List(failed); return Task.FromResult(StubHandler.Json("{\"setting\":" + failed + "}")); };
            using var workspace = server.Workspace(); var (_, form, busy) = Open(workspace);
            Descendants<PasswordBox>(form).Single().Password = Token; Click(SaveButton(form)); Settle(busy);
            var texts = Texts(form); Assert.Contains("連携できませんでした。" + Rejected, texts); Assert.Equal(1, texts.Count(text => text.Contains(Rejected)));
            Assert.DoesNotContain(texts, text => text.StartsWith("保存しました。表示を更新できませんでした"));
        });
    }

    [Fact]
    public void ReadingAFailedItemWhenOpeningShowsTheReasonOnceOnTheResultLine()
    {
        RunSta(() =>
        {
            var server = new Server { Settings = List(Item("enabled", true, $$"""{"code":"ONEPASSWORD_TOKEN_REJECTED","message":"{{Rejected}}"}""")) }; using var workspace = server.Workspace();
            var (_, form, _) = Open(workspace); var texts = Texts(form);
            Assert.Equal(1, texts.Count(text => text.Contains(Rejected))); Assert.Contains("連携できませんでした。" + Rejected, texts); Assert.Contains("一つ目", texts); // not connected: guide open
        });
    }

    [Fact]
    public void ARejectedRequestClearsTheLineShowsTheFormErrorAndIsNeverResent()
    {
        RunSta(() =>
        {
            var server = new Server { Settings = List(Item("unconfigured", false)) };
            server.Patch = _ => Task.FromResult(StubHandler.Json("{\"error\":\"" + Token + "\"}", HttpStatusCode.BadRequest));
            using var workspace = server.Workspace(); var (_, form, busy) = Open(workspace);
            var reads = server.Reads.Count; Descendants<PasswordBox>(form).Single().Password = Token; Click(SaveButton(form)); Settle(busy);
            var texts = Texts(form); Assert.Single(server.Patches); Assert.Equal(reads, server.Reads.Count); // no resend, and no re-read after a refusal
            Assert.DoesNotContain(texts, text => text.StartsWith("連携できました") || text.StartsWith("連携できませんでした") || text.StartsWith("1Passwordにつないで"));
            Assert.Contains(texts, text => text.StartsWith("設定の保存・反映結果を確認できませんでした")); Assert.All(texts, text => Assert.DoesNotContain(Token, text));
            Assert.True(SaveButton(form).IsEnabled);
        });
    }

    [Fact]
    public void RereadFailingAfterAGoodPatchSaysItWasSavedAndKeepsTheResultLine()
    {
        RunSta(() =>
        {
            var server = new Server { Settings = List(Item("unconfigured", false)) };
            server.Patch = _ => { server.Settings = "not json"; return Task.FromResult(StubHandler.Json("{\"setting\":" + Item("enabled", true, connection: Vaults) + "}")); };
            using var workspace = server.Workspace(); var (_, form, busy) = Open(workspace);
            Descendants<PasswordBox>(form).Single().Password = Token; Click(SaveButton(form)); Settle(busy);
            var texts = Texts(form); Assert.Single(server.Patches);
            Assert.Contains(texts, text => text.StartsWith("保存しました。表示を更新できませんでした")); Assert.Contains("連携できました。読める保管庫：Infra、Team　SSH鍵：3件", texts);
        });
    }

    [Fact]
    public void ListRowShowsTheBadgeAndPlainFailureTextAndAnOldServerGetsNoRow()
    {
        RunSta(() =>
        {
            var failed = Item("enabled", true, $$"""{"code":"ONEPASSWORD_TOKEN_REJECTED","message":"{{Rejected}}"}""");
            var plain = """{"id":"calendar","title":"カレンダー","enabled":false,"status":"disabled","fields":[]}""";
            var server = new Server { Settings = List(plain, failed) }; using var workspace = server.Workspace(); Await(workspace.ConnectAsync("http://localhost", listen: false));
            // 1Password is its own settings item (settings-user-flow B8): 追加機能 lists the rest, the item's row and the 要対応 band carry its failure.
            var window = new SettingsWindow(workspace); Await(window.InitializeAsync(SettingsPage.Features)); Pump();
            var texts = Texts(window); Assert.DoesNotContain("1Password連携", texts); Assert.Contains("カレンダー", texts); Assert.Contains("オフ", texts);
            Assert.Equal(SettingsTone.Orange, window.ItemStatus(SettingsPage.OnePassword).Tone); Assert.Equal(Rejected, window.ItemStatus(SettingsPage.OnePassword).Line); Assert.True(window.ItemStatus(SettingsPage.OnePassword).NeedsAttention);
            Await(window.SelectAsync(SettingsPage.OnePassword)); Pump();
            texts = Texts(window); Assert.Contains("失敗", texts); Assert.Contains(Rejected, texts); Assert.DoesNotContain("反映エラー", texts); window.Close();
            var old = new Server { Settings = List(plain) }; using var oldWorkspace = old.Workspace(); Await(oldWorkspace.ConnectAsync("http://localhost", listen: false));
            var oldWindow = new SettingsWindow(oldWorkspace); Await(oldWindow.InitializeAsync(SettingsPage.OnePassword)); Pump();
            Assert.Contains("このサーバーの版では1Passwordと連携できません。", Texts(oldWindow)); Assert.Null(oldWindow.ItemStatus(SettingsPage.OnePassword).Badge); oldWindow.Close();
        });
    }

    private static string AutomationName(DependencyObject item) => System.Windows.Automation.AutomationProperties.GetName(item);
    private static IEnumerable<T> Descendants<T>(DependencyObject root) where T : DependencyObject
    {
        if (root is T found) yield return found;
        foreach (var child in LogicalTreeHelper.GetChildren(root).OfType<DependencyObject>()) foreach (var item in Descendants<T>(child)) yield return item;
    }
    private static void Pump() { var frame = new DispatcherFrame(); Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() => frame.Continue = false)); Dispatcher.PushFrame(frame); }
    private static void Await(Task task) { var end = DateTime.UtcNow.AddSeconds(5); while (!task.IsCompleted) { if (DateTime.UtcNow > end) throw new TimeoutException(); Pump(); Thread.Sleep(1); } task.GetAwaiter().GetResult(); }
    private static T Await<T>(Task<T> task) { Await((Task)task); return task.Result; }
    private static void RunSta(Action action)
    {
        Exception? failure = null; var thread = new Thread(() => { try { SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(Dispatcher.CurrentDispatcher)); action(); } catch (Exception error) { failure = error; } finally { Dispatcher.CurrentDispatcher.InvokeShutdown(); } });
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join(); if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }
}
