using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Threading;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;

// Claude's 1st/2nd accounts (W-MAC row 12). Contract: docs/architecture/modules/execution/harness-accounts.md.
public sealed class HarnessAccountsTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-11-08T05:00:00Z"); // 14:00 JST
    private const string Both = """
        {"harnesses":[{"harness":"claude","slots":[
          {"slot":"1st","loggedIn":true,"label":"first@example.com","history":"shared","limits":[{"scope":"fable","since":"2026-11-08T04:00:00Z","resetAt":"2026-11-08T14:00:00Z","resetSource":"message"}],"seats":["bot-bell","bot-two"]},
          {"slot":"2nd","loggedIn":false,"label":null,"history":"separate","limits":[],"seats":[]}],
          "allLimited":[]}],"rules":[{"harness":"claude","modelPrefix":"claude-fable","slot":"2nd"}]}
        """;
    private const string AllLimited = """
        {"harnesses":[{"harness":"claude","slots":[
          {"slot":"1st","loggedIn":true,"label":"a@example.com","history":"shared","limits":[{"scope":"all","since":"2026-11-08T04:00:00Z","resetAt":"2026-11-09T23:00:00Z","resetSource":"usage"}],"seats":["bot-bell"]},
          {"slot":"2nd","loggedIn":true,"label":"b@example.com","history":"shared","limits":[{"scope":"all","since":"2026-11-08T04:30:00Z","resetAt":null,"resetSource":null}],"seats":[]}],
          "allLimited":[{"scope":"all","earliestResetAt":"2026-11-08T08:00:00Z"}]}],"rules":[]}
        """;

    [Fact]
    public async Task ReadsPerScopeLimitsAndAllLimitedArrays()
    {
        using var api = new BellApi(new("http://localhost/"), new StubHandler((request, _) => { Assert.Equal("/api/accounts", request.RequestUri!.AbsolutePath); Assert.Equal(HttpMethod.Get, request.Method); return Task.FromResult(StubHandler.Json(AllLimited)); }));
        var list = (await new HarnessAccountsApi(api).ReadAsync())!;
        var claude = list.Claude!; Assert.Equal(["1st", "2nd"], claude.Slots.Select(slot => slot.Slot));
        Assert.Equal(new AccountLimit("all", "2026-11-08T04:00:00Z", "2026-11-09T23:00:00Z", "usage"), claude.Slots[0].Limits.Single());
        Assert.Null(claude.Slots[1].Limits.Single().ResetAt);
        Assert.Equal(new AccountAllLimited("all", "2026-11-08T08:00:00Z"), claude.AllLimited.Single());
    }

    [Fact]
    public async Task OnlyA404MeansAnOlderServerAndEveryOtherFailureThrows()
    {
        foreach (var (status, older) in new[] { (HttpStatusCode.NotFound, true), (HttpStatusCode.InternalServerError, false), (HttpStatusCode.Forbidden, false), (HttpStatusCode.BadRequest, false) })
        {
            using var api = new BellApi(new("http://localhost/"), new StubHandler((_, _) => Task.FromResult(StubHandler.Json("""{"error":"NOT_FOUND"}""", status))));
            var read = new HarnessAccountsApi(api).ReadAsync();
            if (older) Assert.Null(await read); else await Assert.ThrowsAsync<BellApiException>(() => read);
        }
        using var broken = new BellApi(new("http://localhost/"), new StubHandler((_, _) => Task.FromResult(StubHandler.Json("""{"harnesses":"x"}"""))));
        await Assert.ThrowsAnyAsync<Exception>(() => new HarnessAccountsApi(broken).ReadAsync());
    }

    [Fact]
    public async Task SlotRidesTheQueryOfEveryAuthRequestAndNeverTheBody()
    {
        var seen = new List<(HttpMethod Method, string Url, string Body)>();
        using var api = new BellApi(new("http://localhost/"), new StubHandler(async (request, token) =>
        {
            seen.Add((request.Method, request.RequestUri!.PathAndQuery, request.Content is null ? "" : await request.Content.ReadAsStringAsync(token)));
            return StubHandler.Json("""{"harness":"claude","slot":"2nd","account_label":"b@example.com","auth":{"status":"waiting","input_required":true}}""");
        }));
        var auth = new HarnessAuthenticationApi(api);
        var status = await auth.StatusAsync("claude", slot: "2nd"); Assert.Equal("2nd", status.Slot); Assert.Equal("b@example.com", status.AccountLabel);
        await auth.StartAsync("claude", slot: "2nd"); await auth.InputAsync("claude", "x", null, slot: "2nd"); await auth.CancelAsync("claude", slot: "2nd");
        Assert.All(seen, call => Assert.EndsWith("?slot=2nd", call.Url));
        Assert.Equal(["/api/harness-auth/claude?slot=2nd", "/api/harness-auth/claude/start?slot=2nd", "/api/harness-auth/claude/input?slot=2nd", "/api/harness-auth/claude/cancel?slot=2nd"], seen.Select(call => call.Url));
        Assert.DoesNotContain("slot", seen[2].Body); Assert.Equal("{}", seen[1].Body);
        seen.Clear();
        await auth.StatusAsync("claude"); await auth.StartAsync("claude", slot: "1st"); await auth.StatusAsync("codex");
        Assert.Equal(["/api/harness-auth/claude", "/api/harness-auth/claude/start", "/api/harness-auth/codex"], seen.Select(call => call.Url));
    }

    [Fact]
    public void LimitTimesAreShownInJstWithTheDateOnlyWhenNotToday()
    {
        Assert.Equal("23:00", AccountText.ResetTime("2026-11-08T14:00:00Z", Now));       // 23:00 JST, same JST day as 14:00 JST now
        Assert.Equal("11/9 08:00", AccountText.ResetTime("2026-11-08T23:00:00Z", Now));   // 08:00 JST the next day
        Assert.Equal("11/9 00:30", AccountText.ResetTime("2026-11-08T15:30:00Z", Now));    // 00:30 JST crosses midnight: dated
        Assert.Null(AccountText.ResetTime(null, Now)); Assert.Null(AccountText.ResetTime("not a time", Now));
        Assert.Equal("上限中 (23:00に解除)", AccountText.LimitText("all", "2026-11-08T14:00:00Z", Now));
        Assert.Equal("Fableのみ上限中 (23:00に解除)", AccountText.LimitText("fable", "2026-11-08T14:00:00Z", Now));
        Assert.Equal("Opusのみ上限中 (11/9 08:00に解除)", AccountText.LimitText("opus", "2026-11-08T23:00:00Z", Now));
        Assert.Equal("上限中 (解除時刻不明)", AccountText.LimitText("all", null, Now));
        Assert.Equal("Fableのみ上限中 (解除時刻不明)", AccountText.LimitText("fable", null, Now));
    }

    [Fact]
    public void BannerAppearsOnlyWhenAllLimitedIsNotEmpty()
    {
        static AccountsResponse Parse(string json) => JsonSerializer.Deserialize<AccountsResponse>(json, BellApi.Json)!;
        Assert.Empty(AccountText.BannerTexts(Parse(Both), Now));
        Assert.Equal(["両方のアカウントで上限中 (17:00に解除)"], AccountText.BannerTexts(Parse(AllLimited), Now));
        Assert.Empty(AccountText.BannerTexts(null, Now));
        Assert.Equal(["両方のアカウントでFableのみ上限中 (解除時刻不明)"], AccountText.BannerTexts(Parse(Both.Replace("\"allLimited\":[]", "\"allLimited\":[{\"scope\":\"fable\",\"earliestResetAt\":null}]")), Now));
    }

    [Fact]
    public void SlotLinesComeFromTheList()
    {
        var list = JsonSerializer.Deserialize<AccountsResponse>(Both, BellApi.Json)!;
        var first = list.Claude!.Slots[0]; var second = list.Claude.Slots[1];
        Assert.Equal("first@example.com", AccountText.Login(first)); Assert.Equal("Fableのみ上限中 (23:00に解除)", AccountText.LimitText(first.Limits[0].Scope, first.Limits[0].ResetAt, Now));
        // settings-user-flow B20: a count, never the names.
        Assert.Equal("2人が使用", AccountText.SeatsCount(first)); Assert.Equal("0人が使用", AccountText.SeatsCount(second));
        // Mac f37b05a4: the name only when sent.
        Assert.Null(AccountText.Login(second));
        Assert.Null(AccountText.Login(new AccountSlot { Slot = "2nd", LoggedIn = true }));
        Assert.Equal(("1つ目のアカウント", "2つ目のアカウント"), (AccountText.SlotName("1st"), AccountText.SlotName("2nd")));
        // B19: one limit line; the 2nd is not logged in here, so nothing runs on it instead.
        Assert.Equal("Fableが上限中・23:00に戻ります", AccountText.LimitLine(list.Claude, first, Now)); Assert.Null(AccountText.LimitLine(list.Claude, second, Now));
        // #1117: counted from each bot's own account, so 1つ目 + 2つ目 = the AI's members; an older body (no account anywhere) gives null.
        SeatAccount?[] seats = [new("claude", "1st"), new("claude", "2nd"), new("claude", "1st"), null, new("codex", null)];
        Assert.Equal((2, 1), (AccountText.SlotUsers(seats, "claude", "1st"), AccountText.SlotUsers(seats, "claude", "2nd")));
        Assert.Null(AccountText.SlotUsers([null, null], "claude", "1st"));
        Assert.Equal(("いま2人がこのアカウントで動いています", "いまこのアカウントで動いているメンバーはいません"), (AccountText.SlotUsersLine(2), AccountText.SlotUsersLine(0)));
    }

    [Fact]
    public void MemberCardSlotTextIsAbsentWhenTheServerSendsNoAccount()
    {
        Bot Parse(string extra) => JsonSerializer.Deserialize<Bot>($$"""{"id":"b","name":"n","displayName":"n"{{extra}}}""", BellApi.Json)!;
        Assert.Null(Parse("").Account); Assert.Null(AccountText.SeatText(Parse("").Account));
        Assert.Null(AccountText.SeatText(Parse(""","account":null""").Account));
        Assert.Equal("2ndアカウント", AccountText.SeatText(Parse(""","account":{"harness":"claude","slot":"2nd","preferredSlot":"1st"}""").Account));
        Assert.Equal("1stアカウント", AccountText.SeatText(Parse(""","account":{"harness":"claude","slot":"1st","preferredSlot":"2nd"}""").Account));
        Assert.Null(AccountText.SeatText(Parse(""","account":{"harness":"codex","slot":"1st","preferredSlot":"1st"}""").Account));
        Assert.Null(AccountText.SeatText(Parse(""","account":{"harness":"claude","slot":"3rd","preferredSlot":"1st"}""").Account));
    }

    [Fact]
    public void MemberCardRowShowsTheSeatSlotAndRefreshesWhenItMoves()
    {
        RunSta(() =>
        {
            var account = ""","account":{"harness":"claude","slot":"2nd","preferredSlot":"2nd"}""";
            using var workspace = new Workspace(origin => new BellApi(origin, new StubHandler((request, _) => Task.FromResult(StubHandler.Json(request.RequestUri!.AbsolutePath switch
            {
                "/api/session" => """{"authenticated":true,"authMode":"local"}""", "/api/bots" => $$"""{"bots":[{"id":"one","name":"ユキ","displayName":"ユキ","harness":"claude"{{account}}}]}""",
                "/api/owner" => ApiTests.Owner, "/api/rooms" => """{"rooms":[]}""", "/api/queue" => ApiTests.EmptyQueue, _ => ApiTests.Page
            })))));
            Await(workspace.ConnectAsync("http://localhost", listen: false)); var view = new ProfileView { Workspace = workspace };
            Await(workspace.SelectAsync(workspace.Entries[0]));
            // Mac #1124: the slot is a badge on the AI card (automation id bot-account-slot), named as on the settings rows.
            string? Slot() => Descendants<Border>(view).Where(item => System.Windows.Automation.AutomationProperties.GetAutomationId(item) == "bot-account-slot").Select(item => System.Windows.Automation.AutomationProperties.GetName(item)).SingleOrDefault();
            Assert.Equal("2つ目のアカウント", Slot());
            account = ""","account":{"harness":"claude","slot":"1st","preferredSlot":"2nd"}"""; Await(workspace.RefreshManagementAsync()); Pump();
            Assert.Equal("1つ目のアカウント", Slot());
            account = ""; Await(workspace.RefreshManagementAsync()); Pump();
            Assert.Null(Slot());
        });
    }

    // ---- the AIの認証 card ----
    private static Workspace Server(Func<HttpRequestMessage, string, Task<HttpResponseMessage>> accounts, List<string> posts)
        => new(origin => new BellApi(origin, new StubHandler(async (request, token) =>
        {
            var path = request.RequestUri!.AbsolutePath;
            if (request.Method == HttpMethod.Post) { var body = await request.Content!.ReadAsStringAsync(token); posts.Add(path + request.RequestUri.Query + " " + body); return await accounts(request, body); }
            if (path.StartsWith("/api/accounts")) return await accounts(request, "");
            return StubHandler.Json(path switch
            {
                "/api/session" => """{"authenticated":true,"authMode":"local"}""", "/api/bots" => ApiTests.Bots, "/api/queue" => ApiTests.EmptyQueue, "/api/rooms" => ApiTests.Rooms, "/api/owner" => ApiTests.Owner,
                "/api/harness-auth" => """{"harnesses":[{"id":"codex","name":"Codex","members":2,"startWarning":null},{"id":"claude","name":"Claude","members":1,"startWarning":null}]}""",
                "/api/harness-auth/claude" => """{"harness":"claude","slot":"1st","auth":{"status":"authenticated","input_required":false}}""",
                "/api/harness-auth/codex" => """{"harness":"codex","auth":{"status":"authenticated","input_required":false}}""",
                _ => ApiTests.Page
            });
        })));
    private static SettingsWindow OpenCard(Workspace workspace) { Await(workspace.ConnectAsync("http://localhost", listen: false)); var window = new SettingsWindow(workspace); Await(window.InitializeAsync(SettingsPage.Ai)); Pump(); return window; }
    private static string[] Texts(DependencyObject root) => Descendants<TextBlock>(root).Select(text => text.Text).ToArray();

    [Fact]
    public void CardShowsBothSlotRowsAndTheBannerWithoutAnyRuleSwitch()
    {
        RunSta(() =>
        {
            var posts = new List<string>();
            using var workspace = Server((request, _) => Task.FromResult(request.Method == HttpMethod.Get ? StubHandler.Json(AllLimited) : StubHandler.Json("""{"rules":[]}""")), posts);
            var window = OpenCard(workspace); var texts = Texts(window);
            Assert.Contains("1つ目のアカウント", texts); Assert.Contains("2つ目のアカウント", texts); Assert.DoesNotContain("Fableを2ndアカウントで使う", texts);   // Owner ruling 2026-11-09: limits alone pick the slot
            // settings-user-flow B19/B20: one limit line per slot, a count instead of names; the e-mail only on the login screen.
            Assert.DoesNotContain("a@example.com", texts); Assert.DoesNotContain(texts, text => text.StartsWith("使用中: ")); Assert.Contains("1人が使用", texts); Assert.DoesNotContain(texts, text => text.StartsWith("状態"));
            Assert.Contains(texts, text => text.StartsWith("\u26A0 1つ目と2つ目のアカウントがどちらも上限中です（"));
            Assert.Contains("上限中・11/10 08:00に戻ります", texts); Assert.Contains("上限中・戻る時刻は分かりません", texts);
            // B18: a row that works has its badge and chevron only, no filled button.
            Assert.Equal(5, Descendants<TextBlock>(window).Count(text => text.Text == "認証済み")); // the three rows, the page head and the AIの認証 list row
            Assert.DoesNotContain(Descendants<Button>(window), button => button.Content as string is "認証し直す" or "認証する" && button.Visibility == Visibility.Visible);
            Assert.Empty(posts); window.Close();
        });
    }

    [Fact]
    public void OlderServerKeepsTheSingleClaudeRow()
    {
        RunSta(() =>
        {
            using var workspace = Server((_, _) => Task.FromResult(StubHandler.Json("""{"error":"NOT_FOUND"}""", HttpStatusCode.NotFound)), []);
            var window = OpenCard(workspace); var texts = Texts(window);
            Assert.DoesNotContain("1つ目のアカウント", texts); Assert.DoesNotContain("Fableを2ndアカウントで使う", texts); Assert.Contains("Claude", texts);
            Assert.Equal(4, Descendants<TextBlock>(window).Count(text => text.Text == "認証済み")); window.Close(); // two rows, the page head and the list row
        });
    }

    [Fact]
    public void AnotherReadFailureIsAnErrorWithReReadNotTheOldCard()
    {
        RunSta(() =>
        {
            var fail = true;
            using var workspace = Server((_, _) => Task.FromResult(fail ? StubHandler.Json("""{"error":"TEMPORARY_FAILURE"}""", HttpStatusCode.InternalServerError) : StubHandler.Json(Both)), []);
            var window = OpenCard(workspace);
            Assert.Contains(Texts(window), text => text.StartsWith("Claudeのアカウントを確認できませんでした。"));
            Assert.DoesNotContain("1つ目のアカウント", Texts(window));
            Assert.Single(Descendants<TextBlock>(window), text => text.Text == "認証済み"); // Codex only: Claude is not shown as the old row
            fail = false; Descendants<Button>(window).Single(button => button.Content as string == "一覧を更新").RaiseEvent(new RoutedEventArgs(ButtonBase.ClickEvent)); Pump(); Pump();
            Await(Task.Delay(50)); Pump();
            Assert.Contains("2つ目のアカウント", Texts(window)); window.Close();
        });
    }

    private static IEnumerable<T> Descendants<T>(DependencyObject root) where T : DependencyObject
    {
        if (root is T found) yield return found;
        foreach (var child in LogicalTreeHelper.GetChildren(root).OfType<DependencyObject>()) foreach (var item in Descendants<T>(child)) yield return item;
    }
    private static void Pump() { var frame = new DispatcherFrame(); Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() => frame.Continue = false)); Dispatcher.PushFrame(frame); }
    private static void Await(Task task) { var end = DateTime.UtcNow.AddSeconds(5); while (!task.IsCompleted) { if (DateTime.UtcNow > end) throw new TimeoutException(); Pump(); Thread.Sleep(1); } task.GetAwaiter().GetResult(); }
    private static void RunSta(Action action)
    {
        Exception? failure = null; var thread = new Thread(() => { try { SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(Dispatcher.CurrentDispatcher)); action(); } catch (Exception error) { failure = error; } finally { Dispatcher.CurrentDispatcher.InvokeShutdown(); } });
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join(); if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }

    // ---- Kiro's answers (2026-11-08) ----
    [Fact]
    public async Task AnAppRefusal403IsNotALostSignInButANonJson403Is()
    {
        var signIns = 0;
        using var refused = new BellApi(new("http://localhost/"), new StubHandler((_, _) => Task.FromResult(StubHandler.Json("""{"error":"WORK_GRAPH_OWNER_REQUIRED"}""", HttpStatusCode.Forbidden))));
        refused.AuthenticationRequired += () => signIns++;
        var error = await Assert.ThrowsAsync<BellApiException>(() => new HarnessAccountsApi(refused).ReadAsync());
        Assert.Equal("WORK_GRAPH_OWNER_REQUIRED", error.Code); Assert.False(error.RequiresLogin); Assert.Equal(0, signIns);
        using var access = new BellApi(new("http://localhost/"), new StubHandler((_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.Forbidden) { Content = new StringContent("<html>Access denied</html>", System.Text.Encoding.UTF8, "text/html") })));
        access.AuthenticationRequired += () => signIns++;
        var denied = await Assert.ThrowsAsync<BellApiException>(() => new HarnessAccountsApi(access).ReadAsync());
        Assert.True(denied.RequiresLogin); Assert.Equal(1, signIns); Assert.Equal("Cloudflare Accessへログインしてください。", denied.Message);
    }

    [Fact]
    public void TheMemberListShowsTheBothLimitedNoticeOnlyWhileBothAreLimited()
    {
        RunSta(() =>
        {
            var accounts = (HttpStatusCode.OK, AllLimited);
            using var workspace = new Workspace(origin => new BellApi(origin, new StubHandler((request, _) => Task.FromResult(request.RequestUri!.AbsolutePath == "/api/accounts"
                ? StubHandler.Json(accounts.Item2, accounts.Item1)
                : StubHandler.Json(request.RequestUri.AbsolutePath switch
                {
                    "/api/session" => """{"authenticated":true,"authMode":"local"}""", "/api/bots" => ApiTests.Bots,
                    "/api/owner" => ApiTests.Owner, "/api/rooms" => """{"rooms":[]}""", "/api/queue" => ApiTests.EmptyQueue, _ => ApiTests.Page
                })))));
            Await(workspace.ConnectAsync("http://localhost", listen: false));
            Assert.StartsWith("両方のアカウントで上限中", workspace.AccountsBanner);
            accounts = (HttpStatusCode.OK, Both); Await(workspace.RefreshManagementAsync()); Assert.Equal("", workspace.AccountsBanner);
            accounts = (HttpStatusCode.NotFound, """{"error":"NOT_FOUND"}"""); Await(workspace.RefreshManagementAsync()); Assert.Equal("", workspace.AccountsBanner);
            accounts = (HttpStatusCode.OK, AllLimited); Await(workspace.RefreshManagementAsync()); Assert.NotEqual("", workspace.AccountsBanner);
            accounts = (HttpStatusCode.ServiceUnavailable, """{"error":"TEMPORARY"}"""); Await(workspace.RefreshManagementAsync());
            Assert.Equal("", workspace.AccountsBanner); Assert.Null(workspace.ConnectionError);   // an optional notice never fails the list
        });
    }
}
