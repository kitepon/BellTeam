using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Reflection;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;

public sealed class PlanningTests
{
    private const string FakeSecret = "模擬の秘密-DO-NOT-LOG";
    private const string FeatureJson = """{"id":"callBridge","title":"通話ブリッジ","enabled":false,"status":"disabled","fields":[{"key":"token","label":"トークン","secret":true,"value":"","configured":true},{"key":"url","label":"URL","secret":false,"value":"http://localhost","configured":true}]}""";
    private const string ScheduleJson = """{"id":"schedule-a","name":"予定","kind":"cron","prompt":"確認","expression":"0 9 * * 1-5","timezone":"Asia/Tokyo","nextRunAt":"2026-10-15T00:00:00.000Z","enabled":true,"targets":null}""";
    [Theory]
    [InlineData("once", "once", null)]
    [InlineData("hourly", "cron", "15 * * * *")]
    [InlineData("daily", "cron", "15 9 * * *")]
    [InlineData("weekly", "cron", "15 9 * * 1,3")]
    [InlineData("cron", "cron", "0 9 * * 1-5")]
    [InlineData("interval_days", "interval_days", null)]
    [InlineData("interval_hours", "interval_hours", null)]
    public void TimingPayloadMatchesServerAndOmitsIrrelevantFields(string frequency, string kind, string? expression)
    {
        var draft = new ScheduleDraft { Frequency = frequency, Content = "前\r\n後", Minute = 15, Hour = 9, Weekdays = [3, 1], Timezone = "Asia/Tokyo" };
        var body = draft.Payload(false, []);
        Assert.Equal(kind, body["kind"]); Assert.Equal("前\n後", body["prompt"]); Assert.False(body.ContainsKey("command")); Assert.False(body.ContainsKey("targets"));
        if (expression is not null) Assert.Equal(expression, body["expression"]); else Assert.False(body.ContainsKey("expression"));
        if (frequency == "once") { Assert.True(DateTimeOffset.TryParse((string)body["at"]!, out _)); Assert.False(body.ContainsKey("timezone")); }
        else Assert.Equal("Asia/Tokyo", body["timezone"]);
        if (frequency == "interval_days") { Assert.Equal(2, body["intervalDays"]); Assert.Equal("09:15", body["time"]); }
        if (frequency == "interval_hours") { Assert.Equal(3, body["intervalHours"]); Assert.Equal(9, body["startHour"]); Assert.Equal(18, body["endHour"]); }
    }
    [Fact]
    public void ExistingCronAndTimezoneStayExactAndRoomsNeverSendCommand()
    {
        var original = JsonSerializer.Deserialize<Schedule>(ScheduleJson, BellApi.Json)!;
        var draft = ScheduleDraft.From(original); Assert.Equal("0 9 * * 1-5", draft.Payload(true, ["bot-bell"])["expression"]); Assert.Equal("Asia/Tokyo", draft.Timezone);
        Assert.Equal(new[] { "bot-bell" }, draft.Payload(true, ["bot-bell"])["targets"]);
        Assert.Null(draft.Payload(true, [])["targets"]);
        draft.Action = "command"; Assert.Throws<ArgumentException>(() => draft.Payload(true, []));
        Assert.False(draft.Payload(false, []).ContainsKey("prompt"));
        draft.Action = "prompt"; draft.Frequency = "weekly"; draft.Weekdays.Clear(); Assert.Throws<ArgumentException>(() => draft.Payload(false, []));
    }
    [Fact]
    public async Task ScheduleCrudAndRunUseExactRoutesAndMethods()
    {
        var seen = new List<(string, string)>();
        using var api = new BellApi(new("http://localhost/"), new StubHandler((request, _) =>
        {
            seen.Add((request.Method.Method, request.RequestUri!.AbsolutePath));
            return Task.FromResult(request.Method == HttpMethod.Delete ? new HttpResponseMessage(HttpStatusCode.NoContent) : StubHandler.Json(request.Method == HttpMethod.Get ? "{\"schedules\":[" + ScheduleJson + "]}" : request.RequestUri.AbsolutePath.EndsWith("/run") ? "{\"ran\":\"schedule-a\"}" : "{\"schedule\":" + ScheduleJson + "}"));
        }));
        var planning = new PlanningApi(api);
        foreach (var room in new[] { false, true })
        {
            var target = new ChatTarget(room ? "room-a" : "bot-bell", room); var entry = new ScheduledEntry(target, "担当", JsonSerializer.Deserialize<Schedule>(ScheduleJson, BellApi.Json)!);
            Assert.Single((await planning.SchedulesAsync(target)).Schedules);
            await planning.SaveScheduleAsync(target, null, new ScheduleDraft { Content = "依頼" }.Payload(room, []));
            await planning.SaveScheduleAsync(target, "schedule-a", new ScheduleDraft { Content = "依頼" }.Payload(room, []));
            await planning.RunScheduleAsync(entry); await planning.DeleteScheduleAsync(entry);
            var prefix = target.Path + "/schedules";
            Assert.Equal(new[] { ("GET", prefix), ("POST", prefix), ("PUT", prefix + "/schedule-a"), ("POST", prefix + "/schedule-a/run"), ("DELETE", prefix + "/schedule-a") }, seen.TakeLast(5));
        }
    }
    [Theory]
    [InlineData(200, 1)]
    [InlineData(404, 3)]
    [InlineData(401, 1)]
    [InlineData(500, 1)]
    public async Task AllSchedulesOnlyFallsBackForOlderServers(int status, int requests)
    {
        var seen = new List<string>();
        using var api = new BellApi(new("http://localhost/"), new StubHandler((request, _) =>
        {
            seen.Add(request.RequestUri!.AbsolutePath);
            return Task.FromResult(request.RequestUri.AbsolutePath != "/api/schedules" ? StubHandler.Json("{\"schedules\":[" + ScheduleJson + "]}")
                : status == 200 ? StubHandler.Json("{\"sources\":[{\"kind\":\"bot\",\"id\":\"bot-a\",\"name\":\"担当\",\"schedules\":[" + ScheduleJson + "]},{\"kind\":\"room\",\"id\":\"room-a\",\"name\":\"相談\",\"schedules\":[]}]}")
                : new HttpResponseMessage((HttpStatusCode)status));
        }));
        var planning = new PlanningApi(api);
        var owners = new[] { (new ChatTarget("bot-a", false), "担当"), (new ChatTarget("room-a", true), "相談") };
        if (status is 200 or 404)
        {
            var sources = await planning.AllSchedulesAsync(owners);
            Assert.Equal(2, sources.Length);
            Assert.False(sources[0].Target.IsRoom); Assert.True(sources[1].Target.IsRoom);
            Assert.Single(sources[0].Schedules);
        }
        else await Assert.ThrowsAsync<BellApiException>(() => planning.AllSchedulesAsync(owners));
        Assert.Equal(requests, seen.Count);
        Assert.Equal("/api/schedules", seen[0]);
    }
    [Fact]
    public async Task OwnerAndRulesOnlySendChangedTextWithLf()
    {
        var original = new OwnerProfile { Name = "オーナー", Profile = "原\n文", Links = [new("情報", "https://example.com/")] };
        Assert.Empty((original with { Profile = "原\r\n文", Links = [new("情報", "https://example.com/")] }).ChangesFrom(original));
        using var api = new BellApi(new("http://localhost/"), new StubHandler(async (request, token) =>
        {
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token)); Assert.Single(body.RootElement.EnumerateObject());
            if (request.Method == HttpMethod.Patch) { Assert.Equal("/api/owner", request.RequestUri!.AbsolutePath); Assert.Equal("新\n文", body.RootElement.GetProperty("profile").GetString()); return StubHandler.Json("{\"owner\":{\"name\":\"オーナー\"}}"); }
            Assert.Equal("/api/user-rules", request.RequestUri!.AbsolutePath); Assert.Equal("決まり\n続き", body.RootElement.GetProperty("text").GetString()); return StubHandler.Json("{\"text\":\"決まり\\n続き\"}");
        }));
        var planning = new PlanningApi(api); await planning.SaveOwnerAsync((original with { Profile = "新\r\n文" }).ChangesFrom(original)); await planning.SaveRulesAsync("決まり\r\n続き");
    }
    [Theory]
    [InlineData(400)]
    [InlineData(307)]
    [InlineData(500)]
    public async Task FeatureErrorsNeverExposeSecret(int status)
    {
        using var api = new BellApi(new("http://localhost/"), new StubHandler(async (request, token) =>
        {
            Assert.Equal(HttpMethod.Patch, request.Method);
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
            Assert.Equal(FakeSecret, body.RootElement.GetProperty("values").GetProperty("token").GetString()); Assert.False(body.RootElement.TryGetProperty("enabled", out _));
            return StubHandler.Json(JsonSerializer.Serialize(new { error = FakeSecret }), (HttpStatusCode)status);
        }));
        var output = new StringWriter(); var previous = Console.Out; var previousError = Console.Error;
        try
        {
            Console.SetOut(output); Console.SetError(output);
            var error = await Assert.ThrowsAsync<BellApiException>(() => new PlanningApi(api).SaveFeatureAsync("callBridge", null, new() { ["token"] = FakeSecret }));
            Assert.DoesNotContain(FakeSecret, error.ToString()); Assert.DoesNotContain(FakeSecret, output.ToString()); Assert.Null(error.InnerException);
        }
        finally { Console.SetOut(previous); Console.SetError(previousError); }
    }
    [Fact]
    public void FeatureEditorPreservesEmptySecretsClearsInputsAndSendsExplicitRemoval()
    {
        RunSta(() =>
        {
            using var workspace = WorkspaceWithFeatures(); Await(workspace.ConnectAsync("http://localhost", listen: false));
            var editor = new FeatureEditor(workspace, "callBridge", "通話ブリッジ"); Await(editor.InitializeAsync());
            Assert.Empty(editor.CollectChanges()); var password = Descendants<PasswordBox>(editor).Single(); password.Password = FakeSecret;
            Assert.Equal(FakeSecret, editor.CollectChanges()["token"]);
            typeof(Window).GetMethod("OnDeactivated", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(editor, [EventArgs.Empty]);
            Assert.Empty(password.Password); Assert.Empty(editor.CollectChanges());
            Descendants<CheckBox>(editor).Single(box => (string)box.Content == "保存すると登録済みの値を消す").IsChecked = true;
            Assert.Equal("", editor.CollectChanges()["token"]); Assert.Single(editor.CollectChanges());
            Descendants<CheckBox>(editor).Single(box => (string)box.Content == "保存すると登録済みの値を消す").IsChecked = false;
            password.Password = FakeSecret; editor.Close(); Assert.Empty(password.Password);
        });
    }
    [Fact]
    public void FeatureEditorFailedSaveClearsPasswordAndShowsNoSecret()
    {
        RunSta(() =>
        {
            var posted = false;
            using var workspace = WorkspaceWithFeatures((request, _) => { posted = true; return Task.FromResult(StubHandler.Json(JsonSerializer.Serialize(new { error = FakeSecret }), HttpStatusCode.BadRequest)); });
            Await(workspace.ConnectAsync("http://localhost", listen: false));
            var editor = new FeatureEditor(workspace, "callBridge", "追加機能"); Await(editor.InitializeAsync());
            var password = Descendants<PasswordBox>(editor).Single(); password.Password = FakeSecret;
            Descendants<Button>(editor).Single(button => (string)button.Content == "保存").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            Pump(); Assert.True(posted); Assert.Empty(password.Password);
            Assert.All(Descendants<TextBlock>(editor), text => Assert.DoesNotContain(FakeSecret, text.Text)); editor.Close();
        });
    }
    [Fact]
    public async Task FeatureResponsesDiscardSecretAndApplyErrorDetails()
    {
        using var api = new BellApi(new("http://localhost/"), new StubHandler((_, _) => Task.FromResult(StubHandler.Json("{\"settings\":[" + FeatureJson.Replace("\"value\":\"\"", "\"value\":\"" + FakeSecret + "\"") + "]}"))));
        var setting = Assert.Single(await new PlanningApi(api).FeaturesAsync());
        Assert.Empty(setting.Fields.Single(field => field.Secret).Value); Assert.DoesNotContain(FakeSecret, JsonSerializer.Serialize(setting));
    }
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task FeatureTransportAndMalformedJsonNeverExposeSecret(bool transport)
    {
        using var api = new BellApi(new("http://localhost/"), new StubHandler((_, _) => transport
            ? Task.FromException<HttpResponseMessage>(new HttpRequestException(FakeSecret))
            : Task.FromResult(StubHandler.Json("{\"setting\":\"" + FakeSecret + "\"}"))));
        var planning = new PlanningApi(api);
        var error = await Assert.ThrowsAsync<BellApiException>(() => planning.SaveFeatureAsync("callBridge", false, new() { ["token"] = FakeSecret }));
        Assert.DoesNotContain(FakeSecret, error.ToString()); Assert.Null(error.InnerException);
        var readError = await Assert.ThrowsAsync<BellApiException>(() => planning.FeaturesAsync()); Assert.DoesNotContain(FakeSecret, readError.ToString());
    }
    [Fact]
    public async Task FeaturePatchDoesNotFollow307WithSecret()
    {
        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start(); var port = ((IPEndPoint)listener.LocalEndpoint).Port; var attempts = 0;
        var server = Task.Run(async () =>
        {
            try
            {
                while (true)
                {
                    using var socket = await listener.AcceptTcpClientAsync(stop.Token); using var stream = socket.GetStream();
                    var header = new StringBuilder(); var next = new byte[1];
                    while (!header.ToString().EndsWith("\r\n\r\n", StringComparison.Ordinal)) { if (await stream.ReadAsync(next, stop.Token) == 0) throw new IOException(); header.Append((char)next[0]); }
                    Interlocked.Increment(ref attempts);
                    await stream.WriteAsync(Encoding.ASCII.GetBytes($"HTTP/1.1 307 Temporary Redirect\r\nLocation: http://127.0.0.1:{port}/redirect\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"), stop.Token);
                }
            }
            catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
        });
        try
        {
            using var api = new BellApi(new($"http://127.0.0.1:{port}/"));
            var error = await Assert.ThrowsAsync<BellApiException>(() => new PlanningApi(api).SaveFeatureAsync("callBridge", null, new() { ["token"] = FakeSecret }));
            Assert.DoesNotContain(FakeSecret, error.ToString()); Assert.Equal(1, attempts);
        }
        finally { stop.Cancel(); await server; }
    }
    [Fact]
    public void ProfileEditorDoesNotSendUneditedMultilineFields()
    {
        RunSta(() =>
        {
            var writes = 0;
            using var workspace = new Workspace(origin => new BellApi(origin, new StubHandler((request, _) =>
            {
                if (request.Method != HttpMethod.Get) writes++;
                return Task.FromResult(StubHandler.Json(request.RequestUri!.AbsolutePath switch
                {
                    "/api/session" => "{\"authenticated\":true,\"authMode\":\"local\"}", "/api/bots" => ApiTests.Bots, "/api/queue" => ApiTests.EmptyQueue, "/api/rooms" => ApiTests.Rooms,
                    "/api/owner" => "{\"owner\":{\"name\":\"オーナー\",\"profile\":\"原\\n文\",\"links\":[]}}", "/api/user-rules" => "{\"text\":\"決まり\\n続き\"}", _ => ApiTests.Page
                }));
            })));
            Await(workspace.ConnectAsync("http://localhost", listen: false));
            var editor = new SettingsWindow(workspace); Await(editor.InitializeAsync(SettingsPage.Profile));
            foreach (var text in Descendants<TextBox>(editor).Where(text => text.AcceptsReturn)) text.Text = text.Text.Replace("\n", "\r\n");
            Descendants<Button>(editor).Single(button => (string)button.Content == "保存").RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); Pump(); Assert.Equal(0, writes); editor.Close();
        });
    }
    [Fact]
    public void StopPageSendsOnePatchAndShowsTheReturnedState()
    {
        RunSta(() =>
        {
            var patches = new List<string>();
            using var workspace = new Workspace(origin => new BellApi(origin, new StubHandler(async (request, _) =>
            {
                if (request.Method == HttpMethod.Patch) { patches.Add(await request.Content!.ReadAsStringAsync()); return StubHandler.Json("""{"control":{"paused":true,"state":"stopped","unconfirmedBotIds":[]}}"""); }
                return StubHandler.Json(request.RequestUri!.AbsolutePath switch
                {
                    "/api/session" => "{\"authenticated\":true,\"authMode\":\"local\"}", "/api/bots" => ApiTests.Bots, "/api/queue" => ApiTests.EmptyQueue, "/api/rooms" => ApiTests.Rooms, "/api/owner" => ApiTests.Owner,
                    "/api/ai-control" => """{"control":{"paused":false,"state":"enabled","unconfirmedBotIds":[]}}""", _ => ApiTests.Page
                });
            })));
            Await(workspace.ConnectAsync("http://localhost", listen: false));
            var editor = new SettingsWindow(workspace); Await(editor.InitializeAsync(SettingsPage.Stop));
            var toggle = Descendants<System.Windows.Controls.Primitives.ToggleButton>(editor).Single(); Assert.False(toggle.IsChecked);
            toggle.IsChecked = true; toggle.RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); Pump(); Pump();
            Assert.Equal(["{\"paused\":true}"], patches);
            Assert.Contains(Descendants<TextBlock>(editor), text => text.Text == "停止中"); editor.Close();
        });
    }
    private static Workspace WorkspaceWithFeatures(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>>? write = null) => new(origin => new BellApi(origin, new StubHandler((request, token) =>
        request.Method != HttpMethod.Get ? write!(request, token) : Task.FromResult(StubHandler.Json(request.RequestUri!.AbsolutePath switch
        { "/api/session" => "{\"authenticated\":true,\"authMode\":\"local\"}", "/api/bots" => ApiTests.Bots, "/api/queue" => ApiTests.EmptyQueue, "/api/rooms" => ApiTests.Rooms, "/api/owner" => ApiTests.Owner, "/api/settings" => "{\"settings\":[" + FeatureJson + "]}", _ => ApiTests.Page })))));
    // ---- the Mac schedule page and editor (PR 9) ----
    [Fact]
    public void NextRunIsPrintedLikeTheMacCardAndAMissingOneIsUndecided()
    {
        Assert.Equal("10月14日(水) 9:00", ScheduleText.Format(new DateTime(2026, 10, 14, 9, 0, 0)));
        Assert.Equal("11月8日(日) 18:20", ScheduleText.Format(new DateTime(2026, 11, 8, 18, 20, 0)));
        Assert.Equal("12月1日(火) 0:05", ScheduleText.Format(new DateTime(2026, 12, 1, 0, 5, 0)));
        Assert.Equal("次回未定", ScheduleText.Next(null));
        Assert.Equal("次回 " + ScheduleText.Format(DateTimeOffset.Parse("2026-10-14T00:00:00Z").LocalDateTime), ScheduleText.Next("2026-10-14T00:00:00Z"));
        Assert.Equal("次回 未定", ScheduleText.Next("not a date"));
    }
    [Fact]
    public void OnlyAOneTimeScheduleGetsTheCalendarIcon()
    {
        var calendar = SchedulesWindow.KindGlyph("once");
        Assert.All(new[] { "cron", "interval_days", "interval_hours" }, kind => Assert.NotEqual(calendar, SchedulesWindow.KindGlyph(kind)));
        Assert.Equal(SchedulesWindow.KindGlyph("cron"), SchedulesWindow.KindGlyph("interval_hours"));
    }
    [Theory]
    [InlineData("15 * * * *", "hourly")]
    [InlineData("0 9 * * *", "daily")]
    [InlineData("0 19 * * 5", "weekly")]
    [InlineData("0 9 * * 1,3", "weekly")]
    [InlineData("0 9 * * 1-5", "cron")]
    [InlineData("*/5 * * * *", "cron")]
    [InlineData("0 9 1 * *", "cron")]
    [InlineData("0 9 * * 7", "cron")]
    [InlineData("00 9 * * *", "cron")]
    public void ACronExpressionOpensAsAMacRepeatOnlyWhenNothingIsLost(string expression, string frequency)
    {
        var draft = ScheduleDraft.From(new Schedule { Id = "a", Kind = "cron", Prompt = "確認", Expression = expression, Timezone = "Asia/Tokyo" });
        Assert.Equal(frequency, draft.Frequency);
        Assert.Equal(expression, draft.Payload(false, [])["expression"]);
    }
    private static Workspace ScheduleWorkspace(List<(string Method, string Path)> requests, HttpStatusCode write = HttpStatusCode.OK) => new(origin => new BellApi(origin, new StubHandler((request, _) =>
    {
        var path = request.RequestUri!.AbsolutePath;
        if (request.Method != HttpMethod.Get) { requests.Add((request.Method.Method, path)); return Task.FromResult(write == HttpStatusCode.OK ? StubHandler.Json("{\"schedule\":" + ScheduleJson + "}") : new HttpResponseMessage(write)); }
        return Task.FromResult(StubHandler.Json(path switch
        {
            "/api/session" => """{"authenticated":true,"authMode":"local"}""", "/api/bots" => ApiTests.Bots, "/api/rooms" => ApiTests.Rooms, "/api/owner" => ApiTests.Owner, "/api/queue" => ApiTests.EmptyQueue, _ => ApiTests.Page
        }));
    })));
    [Fact]
    public void TheWeeklyRepeatIsCalledMaiShuuAndStaysTheSameCronOnTheWire()
    {
        RunSta(() =>
        {
            var requests = new List<(string, string)>();
            using var workspace = ScheduleWorkspace(requests); Await(workspace.ConnectAsync("http://localhost", listen: false));
            var view = new ScheduleEditorView(workspace, null);
            Assert.Equal("毎週", ScheduleEditorView.Frequencies.Single(option => option.Id == "weekly").Label);
            Assert.DoesNotContain(Descendants<TextBlock>(view), text => text.Text == "曜日");
            Assert.Equal(["日", "月", "火", "水", "木", "金", "土"], Descendants<System.Windows.Controls.Primitives.ToggleButton>(view).Select(toggle => System.Windows.Automation.AutomationProperties.GetName(toggle)));
            view.Prefill(nameText: "週次", text: "確認", frequencyId: "weekly", weekdays: [1, 3]);
            var body = view.Collect(out _);
            Assert.Equal("cron", body["kind"]); Assert.Matches(@"^\d+ \d+ \* \* 1,3$", (string)body["expression"]!); Assert.Equal("確認", body["prompt"]); Assert.Equal(ScheduleDraft.LocalTimezone(), body["timezone"]);
            Assert.Empty(requests); view.Dispose();
        });
    }
    [Fact]
    public void TheEditorStopsOnTheMacErrorsBeforeAnyRequestAndASaveIsSentOnce()
    {
        RunSta(() =>
        {
            var requests = new List<(string, string)>(); var closed = false;
            using var workspace = ScheduleWorkspace(requests, HttpStatusCode.InternalServerError); Await(workspace.ConnectAsync("http://localhost", listen: false));
            var view = new ScheduleEditorView(workspace, null) { Closer = () => closed = true };
            view.Prefill(text: " "); Await(view.SaveAsync()); Assert.Equal("実行内容を入力してください。", view.ErrorText);
            view.Prefill(text: "確認", frequencyId: "weekly", weekdays: []); Await(view.SaveAsync()); Assert.Equal("曜日を選んでください。", view.ErrorText);
            Assert.Empty(requests);
            view.Prefill(weekdays: [2]); Await(view.SaveAsync());
            // An unknown result is shown as unknown, the sheet stays open, and nothing is sent again by itself.
            Assert.Single(requests); Assert.Equal("POST", requests[0].Item1); Assert.StartsWith("操作の結果を確認できませんでした。", view.ErrorText); Assert.False(closed); Assert.True(view.CanSave);
            view.Dispose();
        });
    }
    [Fact]
    public void AnExistingRoomScheduleIsPutWholeWithItsRepliersAndNoCommand()
    {
        RunSta(() =>
        {
            var requests = new List<(string, string)>(); var closed = false;
            using var workspace = ScheduleWorkspace(requests); Await(workspace.ConnectAsync("http://localhost", listen: false));
            var entry = new ScheduledEntry(new ChatTarget("room-work", true), "作業部屋", JsonSerializer.Deserialize<Schedule>(ScheduleJson.Replace("\"targets\":null", "\"targets\":[\"bot-bell\"]"), BellApi.Json)!);
            var view = new ScheduleEditorView(workspace, entry) { Closer = () => closed = true };
            var body = view.Collect(out var owner);
            Assert.True(owner.Target.IsRoom); Assert.Equal(new[] { "bot-bell" }, body["targets"]); Assert.Equal("0 9 * * 1-5", body["expression"]); Assert.Equal("Asia/Tokyo", body["timezone"]); Assert.False(body.ContainsKey("command"));
            Await(view.SaveAsync()); Assert.Equal(("PUT", "/api/rooms/room-work/schedules/schedule-a"), requests.Single()); Assert.True(closed);
            view.Dispose();
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
}
