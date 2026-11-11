using System.IO;
using System.Net.Http;
using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using BellTeam.Core;
using BellTeam.App;
using System.Windows;
using System.Windows.Controls;

namespace BellTeam.Tests;

public sealed class UpdateCenterTests
{
    [Theory]
    [InlineData("impact", "containerRestart")]
    [InlineData("compatibility", "compatible")]
    [InlineData("capability", "supported")]
    public async Task MissingPlanBooleanCannotBecomePermission(string section, string field)
    {
        var fixture = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(AppContext.BaseDirectory, "fixtures", "update-center.json")))!;
        var plan = fixture["plans"]![0]!.DeepClone();
        plan[section]!.AsObject().Remove(field);
        var calls = 0;
        using var api = new BellApi(new("http://localhost/"), new StubHandler((_, _) => { calls++; return Task.FromResult(StubHandler.Json(new JsonObject { ["plan"] = plan }.ToJsonString())); }));
        var center = new UpdateCenter(api, new SettingsStore(Path.GetTempPath()));
        await Assert.ThrowsAsync<BellApiException>(() => center.PlanAsync("container"));
        Assert.Equal(1, calls);
    }

    [Fact]
    public async Task DisconnectedStartRetainsRequestAndOnlyReadsTheSameId()
    {
        var fixture = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(AppContext.BaseDirectory, "fixtures", "update-center.json")))!;
        var planJson = fixture["plans"]![0]!.DeepClone();
        planJson["expiresAt"] = DateTimeOffset.UtcNow.AddMinutes(10).ToString("O");
        var calls = new List<string>(); Guid requestId = default; var storedBeforePost = false;
        var directory = Path.Combine(Path.GetTempPath(), "bellteam-update-test-" + Guid.NewGuid());
        try
        {
            var store = new SettingsStore(directory);
            using var api = new BellApi(new("http://localhost/"), new StubHandler(async (request, token) =>
            {
                var path = request.RequestUri!.AbsolutePath; calls.Add(request.Method + " " + path);
                if (path == "/api/updates") return StubHandler.Json(fixture.ToJsonString());
                if (path == "/api/updates/plans") return StubHandler.Json(new JsonObject { ["plan"] = planJson.DeepClone() }.ToJsonString());
                if (request.Method == HttpMethod.Post)
                {
                    var body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(token))!;
                    requestId = Guid.Parse(body["requestId"]!.GetValue<string>());
                    Assert.True(body["confirmContainerRestart"]!.GetValue<bool>());
                    storedBeforePost = store.Load().UpdateRequests.Single().RequestId == requestId;
                    throw new HttpRequestException("切断");
                }
                Assert.Equal("/api/updates/operations/" + requestId, path);
                return StubHandler.Json(new JsonObject { ["operation"] = new JsonObject { ["requestId"] = requestId.ToString(), ["plan"] = planJson.DeepClone(), ["admission"] = "unknown", ["phase"] = "unknown", ["execution"] = "unknown", ["verification"] = "unknown", ["error"] = null, ["reference"] = null } }.ToJsonString());
            }));
            var center = new UpdateCenter(api, store);
            var inventory = await center.InventoryAsync();
            Assert.Equal("container", inventory.Components[0].Id);
            var plan = await center.PlanAsync("container");
            Assert.Equal("BellTeam本体", inventory.Components[0].Name);
            var error = await Assert.ThrowsAsync<BellApiException>(() => center.StartAsync(plan, true));
            Assert.Contains("自動で再送しません", error.Message);
            Assert.True(storedBeforePost);
            var pending = Assert.Single(center.Requests); Assert.Equal(requestId, pending.RequestId); Assert.Null(pending.Result);
            Assert.Equal("unknown", (await center.ReadAsync(pending)).Phase);
            Assert.Equal("unknown", Assert.Single(center.Requests).Result!.Admission);
            await Assert.ThrowsAsync<BellApiException>(() => center.PlanAsync("container"));
            Assert.Single(calls, call => call == "POST /api/updates/operations");
            Assert.Contains("GET /api/updates/operations/" + requestId, calls);
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
    }

    [Fact]
    public async Task MismatchedOrUnverifiedCompletionCannotOverwriteUnknownRequest()
    {
        var fixture = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(AppContext.BaseDirectory, "fixtures", "update-center.json")))!;
        var plan = fixture["plans"]![0]!.DeepClone();
        var request = new UpdateRequest("http://localhost/", Guid.NewGuid(), Guid.Parse(plan["planId"]!.GetValue<string>()), null);
        var directory = Path.Combine(Path.GetTempPath(), "bellteam-update-test-" + Guid.NewGuid());
        try
        {
            var store = new SettingsStore(directory); store.Save(new LocalSettings { UpdateRequests = [request] });
            var result = new JsonObject { ["requestId"] = Guid.NewGuid().ToString(), ["plan"] = plan, ["admission"] = "accepted", ["phase"] = "completed", ["execution"] = "succeeded", ["verification"] = "succeeded", ["error"] = null, ["reference"] = null };
            using var api = new BellApi(new("http://localhost/"), new StubHandler((_, _) => Task.FromResult(StubHandler.Json(new JsonObject { ["operation"] = result.DeepClone() }.ToJsonString()))));
            var center = new UpdateCenter(api, store);
            await Assert.ThrowsAsync<BellApiException>(() => center.ReadAsync(request));
            result["requestId"] = request.RequestId.ToString(); result["verification"] = "unknown";
            await Assert.ThrowsAsync<BellApiException>(() => center.ReadAsync(request));
            Assert.Null(Assert.Single(center.Requests).Result);
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
    }

    private static string Fixture(string name = "update-center") => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", name + ".json"));
    private static SettingsStore TempStore() => new(Path.Combine(Path.GetTempPath(), "BellTeam-view-" + Guid.NewGuid()));
    // Visible text and buttons of the content; the closed 詳細 body is skipped because the user cannot see it.
    private static IEnumerable<DependencyObject> Visible(DependencyObject root)
    {
        yield return root;
        if (root is Expander expander) { if (expander.Header is DependencyObject header) foreach (var item in Visible(header)) yield return item; yield break; }
        foreach (var child in LogicalTreeHelper.GetChildren(root).OfType<DependencyObject>()) foreach (var item in Visible(child)) yield return item;
    }
    private static string[] Texts(UpdateContent content) => Visible(content).OfType<TextBlock>().Select(item => item.Text).ToArray();
    private static Button[] Buttons(UpdateContent content) => Visible(content).OfType<Button>().ToArray();
    private static void Sta(Action body)
    {
        Exception? failure = null;
        var thread = new Thread(() => { try { body(); } catch (Exception error) { failure = error; } finally { System.Windows.Threading.Dispatcher.CurrentDispatcher.InvokeShutdown(); } });
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
        if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }
    // An override returning null falls through to the default routes.
    private static Workspace Connected(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage?>>? custom = null, Func<string>? inventory = null)
    {
        var workspace = new Workspace(origin => new BellApi(origin, new StubHandler(async (request, token) => (custom is null ? null : await custom(request, token)) ?? StubHandler.Json(request.RequestUri!.AbsolutePath switch
        {
            "/api/session" => "{\"authenticated\":true,\"authMode\":\"local\"}", "/api/bots" => ApiTests.Bots, "/api/rooms" => ApiTests.Rooms, "/api/owner" => ApiTests.Owner, "/api/queue" => ApiTests.EmptyQueue, "/api/updates" => (inventory ?? (() => Fixture()))(), _ => ApiTests.Page
        }))));
        workspace.ConnectAsync("http://localhost", listen: false).GetAwaiter().GetResult();
        return workspace;
    }

    [Fact]
    public void UpdateContentDisplaysRealInventoryWithoutOpeningAWindow()
    {
        Sta(() =>
        {
            using var workspace = Connected();
            var content = new UpdateContent(workspace, TempStore()); content.RefreshAsync().GetAwaiter().GetResult();
            var text = Texts(content);
            Assert.Contains("BellTeam本体を更新できます", text); Assert.Contains("新しい版を使えます。", text);
            Assert.Contains(Buttons(content), item => Equals(item.Content, "更新する"));
            Assert.Single(Buttons(content));
            Assert.DoesNotContain(text, item => item.Contains("aaaaaaaaaaaaaaaa") || item.Contains("要求ID") || item.Contains("container") || item.Contains("BELLTEAM") || item.Contains("いつものチーム"));
            Assert.False(Assert.Single(Visible(content).OfType<Expander>()).IsExpanded);
            Assert.Equal(UpdateKind.Available, content.Kind); content.Dispose();
        });
    }

    [Fact]
    public void UpdateScreenKeepsActualStatesAndHidesTechnicalValues()
    {
        Sta(() =>
        {
            var fixture = JsonNode.Parse(Fixture())!;
            var operation = Operation(fixture, "accepted", "applying", "pending", "pending");
            fixture["operation"] = operation; var missingApi = false;
            using var workspace = Connected((request, _) => Task.FromResult<HttpResponseMessage?>(request.RequestUri!.AbsolutePath == "/api/updates" && missingApi ? StubHandler.Json("{\"error\":\"NOT_FOUND\"}", HttpStatusCode.NotFound) : null), () => fixture.ToJsonString());
            var content = new UpdateContent(workspace, TempStore());
            string[] Check(string title, string detail)
            {
                content.RefreshAsync().GetAwaiter().GetResult();
                var text = Texts(content);
                Assert.Contains(title, text); Assert.Contains(detail, text);
                Assert.DoesNotContain(text, item => item.Contains("22222222-2222") || item.Contains("aaaaaaaaaaaaaaaa"));
                Assert.False(Assert.Single(Visible(content).OfType<Expander>()).IsExpanded);
                return text;
            }
            Check("更新しています", "新しい版に切り替えています。完了まで、この画面を閉じても大丈夫です。"); Assert.Empty(Buttons(content));
            operation["admission"] = "unknown"; operation["phase"] = "unknown"; operation["execution"] = "unknown"; operation["verification"] = "unknown";
            var unknownText = Check("更新の結果を確認中", "更新の結果を、まだ確認できていません。"); Assert.DoesNotContain(unknownText, item => item.Contains("記録") || item.Contains("送り直し"));
            Assert.Contains(Buttons(content), item => Equals(item.Content, "状況を確認")); Assert.Contains(Buttons(content), item => Equals(item.Content, "別の更新を選ぶ"));
            operation["admission"] = "accepted"; operation["phase"] = "failed"; operation["execution"] = "failed";
            Check("更新できませんでした", "更新を完了できませんでした。理由は「詳細」で確認できます。"); Assert.Contains(Buttons(content), item => Equals(item.Content, "もう一度更新する"));
            operation["phase"] = "completed"; operation["execution"] = "succeeded"; operation["verification"] = "succeeded";
            Check("BellTeam本体を更新できます", "新しい版を使えます。");
            fixture["operation"] = null; fixture["components"]![0]!["changes"] = new JsonArray();
            Assert.DoesNotContain("更新内容", Check("BellTeam本体を更新できます", "新しい版を使えます。"));
            fixture["operation"] = operation; fixture["components"]![0]!["comparison"]!["state"] = "up_to_date";
            Check("更新しました", "BellTeam本体を新しい版にしました。");
            missingApi = true;
            Check("更新を確認できませんでした", "接続を確かめて、もう一度お試しください。"); Assert.Contains(Buttons(content), item => Equals(item.Content, "状況を確認"));
            content.Dispose();
        });
    }

    [Fact]
    public void UpdateButtonShowsFixedPlanWithoutStartingIt()
    {
        Sta(() =>
        {
            var fixture = JsonNode.Parse(Fixture())!;
            var plan = fixture["plans"]![0]!.DeepClone(); plan["expiresAt"] = DateTimeOffset.UtcNow.AddMinutes(10).ToString("O");
            var calls = new List<string>();
            using var workspace = Connected(async (request, token) =>
            {
                var path = request.RequestUri!.AbsolutePath; calls.Add(request.Method + " " + path);
                if (path != "/api/updates/plans") return null;
                var input = JsonNode.Parse(await request.Content!.ReadAsStringAsync(token))!;
                Assert.Equal("component", input["scope"]!.GetValue<string>()); Assert.Equal("container", input["componentId"]!.GetValue<string>());
                return StubHandler.Json(new JsonObject { ["plan"] = plan.DeepClone() }.ToJsonString());
            }, () => fixture.ToJsonString());
            var content = new UpdateContent(workspace, TempStore()); content.RefreshAsync().GetAwaiter().GetResult();
            Buttons(content).Single().RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            var text = Texts(content);
            Assert.Contains("更新の前に", text); Assert.Contains("BellTeam本体", text); Assert.Contains("会話と処理が一時中断します。", text);
            Assert.False(Buttons(content).Single(item => Equals(item.Content, "更新を始める")).IsEnabled, "the restart consent toggle is required before the update can start");
            var toggle = Visible(content).OfType<CheckBox>().Single(); Assert.Equal("会話と処理が一時止まることを確認しました", toggle.Content);
            toggle.IsChecked = true; toggle.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            Assert.True(Buttons(content).Single(item => Equals(item.Content, "更新を始める")).IsEnabled);
            Assert.Single(calls, call => call == "POST /api/updates/plans");
            Assert.DoesNotContain("POST /api/updates/operations", calls);
            Buttons(content).Single(item => Equals(item.Content, "やめる")).RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            Assert.Contains("BellTeam本体を更新できます", Texts(content)); content.Dispose();

            var second = fixture["components"]![0]!.DeepClone(); second["id"] = "usage"; second["name"] = "利用設定"; fixture["components"]!.AsArray().Add(second);
            calls.Clear();
            var selector = new UpdateContent(workspace, TempStore()); selector.RefreshAsync().GetAwaiter().GetResult();
            Assert.Contains("2つ更新できます", Texts(selector)); Assert.Contains("BellTeam本体・利用設定に新しい版があります。", Texts(selector));
            Buttons(selector).Single(item => Equals(item.Content, "更新する")).RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            Assert.DoesNotContain(calls, call => call.StartsWith("POST "));
            Assert.Contains("どれを更新しますか", Texts(selector));
            Buttons(selector).Single(item => item.Content is Grid && System.Windows.Automation.AutomationProperties.GetName(item) == "BellTeam本体").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            Assert.Single(calls, call => call == "POST /api/updates/plans");
            Assert.DoesNotContain("POST /api/updates/operations", calls); selector.Dispose();
        });
    }

    [Fact]
    public void UpdateScreenWithMacStatusRowsShowsBannerBadgesAndChanges()
    {
        Sta(() =>
        {
            using var workspace = Connected(inventory: () => Fixture("update-center-mixed"));
            var content = new UpdateContent(workspace, TempStore()); content.RefreshAsync().GetAwaiter().GetResult();
            var text = Texts(content);
            Assert.Contains("通知を更新できます", text); Assert.Contains("確認が必要な機能があります", text);
            Assert.Contains("11/8 12:21 の更新はできませんでした。この機能は止まっています。", text); Assert.Contains("☞  BellTeamの管理者に連絡してください。", text);
            Assert.Contains("機能", text); Assert.Contains("更新内容", text); Assert.Contains("機能を更新します。", text);
            Assert.Equal(["最新", "更新あり", "失敗"], text.Where(item => item is "最新" or "更新あり" or "失敗").ToArray());
            Assert.Contains("公開中の最新版 · " + UpdateScreen.Moment("2026-11-08T04:34:47Z") + " に更新", text);
            content.Dispose();
        });
    }

    private static UpdateInventory Inventory(string fixture, Action<JsonNode>? edit = null)
    {
        var node = JsonNode.Parse(Fixture(fixture))!; edit?.Invoke(node);
        return node.Deserialize<UpdateInventory>(BellApi.Json)!;
    }
    private static JsonNode Operation(JsonNode fixture, string admission, string phase, string execution, string verification)
        => new JsonObject { ["requestId"] = "22222222-2222-4222-8222-222222222222", ["plan"] = fixture["plans"]![0]!.DeepClone(), ["admission"] = admission, ["phase"] = phase, ["execution"] = execution, ["verification"] = verification, ["error"] = null, ["reference"] = null };

    [Fact]
    public void EveryMacHeroStateMapsFromTheSameInventoryAndOperationData()
    {
        static (UpdateKind Kind, string Title, string Detail) Hero(UpdateInventory? inventory, bool readFailed = false, bool unread = false)
        {
            var operation = UpdateScreen.Current(inventory, []);
            var kind = UpdateScreen.Kind(inventory, readFailed, operation, unread);
            var (title, detail) = UpdateScreen.Hero(kind, inventory, operation);
            return (kind, title, detail);
        }
        Assert.Equal((UpdateKind.Loading, "確認しています", "最新の状態かどうかを確かめています。"), Hero(null));
        Assert.Equal((UpdateKind.Unreachable, "更新を確認できませんでした", "接続を確かめて、もう一度お試しください。"), Hero(null, readFailed: true));
        foreach (var (phase, wording) in new[] { ("preparing", "準備しています"), ("applying", "新しい版に切り替えています"), ("reconnecting", "再接続しています"), ("verifying", "動作を確かめています") })
            Assert.Equal((UpdateKind.Updating, "更新しています", wording + "。完了まで、この画面を閉じても大丈夫です。"), Hero(Inventory("update-center", node => node["operation"] = Operation(node, "accepted", phase, "pending", "pending"))));
        Assert.Equal((UpdateKind.Unconfirmed, "更新の結果を確認中", "更新の結果を、まだ確認できていません。"), Hero(Inventory("update-center", node => node["operation"] = Operation(node, "unknown", "unknown", "unknown", "unknown"))));
        Assert.Equal(UpdateKind.Unconfirmed, Hero(Inventory("update-center"), unread: true).Kind);
        Assert.Equal((UpdateKind.Failed, "更新できませんでした", "更新を完了できませんでした。理由は「詳細」で確認できます。"), Hero(Inventory("update-center", node => node["operation"] = Operation(node, "accepted", "failed", "failed", "pending"))));
        Assert.Equal(UpdateKind.Failed, Hero(Inventory("update-center", node => node["operation"] = Operation(node, "accepted", "verifying", "succeeded", "failed"))).Kind);
        Assert.Equal((UpdateKind.Completed, "更新しました", "BellTeam本体を新しい版にしました。"), Hero(Inventory("update-center", node => { node["components"]![0]!["comparison"]!["state"] = "up_to_date"; node["operation"] = Operation(node, "accepted", "completed", "succeeded", "succeeded"); })));
        Assert.Equal((UpdateKind.Available, "BellTeam本体を更新できます", "新しい版を使えます。"), Hero(Inventory("update-center")));
        Assert.Equal((UpdateKind.Available, "通知を更新できます", "新しい版を使えます。"), Hero(Inventory("update-center-mixed")));
        Assert.Equal((UpdateKind.UpToDate, "すべて最新です", "今のところ、新しい更新はありません。"), Hero(Inventory("update-center-current")));
        Assert.Equal((UpdateKind.Unknown, "更新を確認できませんでした", "時間をおいて、もう一度確認してください。"), Hero(Inventory("update-center", node => node["components"]![0]!["comparison"]!["state"] = "unknown")));
        // A publication check the server reports as unconfirmed is never shown as "latest".
        var unconfirmed = "{\"catalog\":{\"sha256\":\"" + new string('a', 64) + "\",\"publishedAt\":\"2026-11-08T04:00:00Z\",\"expiresAt\":\"2026-11-09T04:00:00Z\"},\"check\":{\"status\":\"unconfirmed\",\"checkedAt\":null,\"error\":null}}";
        Assert.Equal(UpdateKind.Unknown, Hero(Inventory("update-center-current", node => node["components"]![0]!["publication"] = JsonNode.Parse(unconfirmed))).Kind);
        // Mac Status.waiting: the rest is current and some parts have no version for this body yet; anything unconfirmed keeps the old wording.
        static void AddIncompatible(JsonNode node, string id, string name) { var part = node["components"]![0]!.DeepClone(); part["id"] = id; part["name"] = name; part["comparison"]!["state"] = "incompatible"; node["components"]!.AsArray().Add(part); }
        Assert.Equal((UpdateKind.Waiting, "更新できるものはすべて最新です", "通知・利用設定は、いまの本体に合う版がまだありません。合う版が出ると、ここで更新できます。"),
            Hero(Inventory("update-center-current", node => { AddIncompatible(node, "notifications", "通知"); AddIncompatible(node, "usage", "利用設定"); })));
        Assert.Equal(UpdateKind.Unknown, Hero(Inventory("update-center-current", node => { AddIncompatible(node, "notifications", "通知"); node["components"]![0]!["comparison"]!["state"] = "unavailable"; })).Kind);
        // Several candidates are counted, then named.
        Assert.Equal(("2つ更新できます", "BellTeam本体・利用設定に新しい版があります。"), UpdateScreen.Hero(UpdateKind.Available, Inventory("update-center", node => { var second = node["components"]![0]!.DeepClone(); second["id"] = "usage"; second["name"] = "利用設定"; node["components"]!.AsArray().Add(second); }), null));
    }

    [Fact]
    public void PartBadgesFollowOperationTargetServerToneAndComparison()
    {
        var mixed = Inventory("update-center-mixed");
        Assert.Equal([UpdateBadge.UpToDate, UpdateBadge.Available, UpdateBadge.Failed], mixed.Components.Select(item => UpdateScreen.Badge(item, null)).ToArray());
        Assert.Equal(["最新", "更新あり", "失敗"], mixed.Components.Select(item => UpdateScreen.BadgeText(UpdateScreen.Badge(item, null))).ToArray());
        var running = Inventory("update-center", node => node["operation"] = Operation(node, "accepted", "applying", "pending", "pending"));
        Assert.Equal(UpdateBadge.Updating, UpdateScreen.Badge(running.Components[0], running.Operation)); Assert.Equal("更新中", UpdateScreen.BadgeText(UpdateBadge.Updating));
        var toned = Inventory("update-center-mixed", node => node["components"]![0]!["status"]!["tone"] = "updating");
        Assert.Equal(UpdateBadge.Updating, UpdateScreen.Badge(toned.Components[0], null));
        var unknown = Inventory("update-center", node => node["components"]![0]!["comparison"]!["state"] = "unavailable");
        Assert.Equal(UpdateBadge.Unknown, UpdateScreen.Badge(unknown.Components[0], null)); Assert.Equal("確認できません", UpdateScreen.BadgeText(UpdateBadge.Unknown));
        var incompatible = Inventory("update-center", node => node["components"]![0]!["comparison"]!["state"] = "incompatible");
        Assert.Equal(UpdateBadge.Incompatible, UpdateScreen.Badge(incompatible.Components[0], null)); Assert.Equal("使えない版", UpdateScreen.BadgeText(UpdateBadge.Incompatible));
        // An unreadable per-part status only drops that status (the Mac LenientField).
        var broken = Inventory("update-center-mixed", node => node["components"]![0]!["status"]!["tone"] = "bogus");
        Assert.Null(broken.Components[0].Part); Assert.Equal(UpdateBadge.UpToDate, UpdateScreen.Badge(broken.Components[0], null));
    }

    [Fact]
    public void VersionTextNeverShowsAHashAndPlanWordingKeepsServerValuesForUnknownActions()
    {
        var mixed = Inventory("update-center-mixed");
        Assert.Equal("公開中の最新版", UpdateScreen.VersionName(mixed.Components[0])); Assert.Equal("今の版", UpdateScreen.VersionName(mixed.Components[1]));
        Assert.Equal(UpdateScreen.Moment("2026-11-08T04:34:47Z") + " に更新", UpdateScreen.LastUpdated(mixed.Components[0])); Assert.Null(UpdateScreen.LastUpdated(mixed.Components[1]));
        var named = Inventory("update-center-mixed", node => { node["components"]![0]!["current"]!["version"] = "0.4.5"; node["components"]![1]!["current"]!["origin"] = "builtin"; node["components"]![2]!["current"] = null; });
        Assert.Equal(["版 0.4.5", "最初から入っている版", "版を確認できません"], named.Components.Select(UpdateScreen.VersionName).ToArray());
        var plan = Inventory("update-center").Plans[0];
        Assert.Equal(("更新の前に", "更新を始める", null), UpdateScreen.PlanWording(plan));
        Assert.Equal(("戻す前の確認", "戻す", null), UpdateScreen.PlanWording(plan with { Action = "rollback" }));
        var unknownPlan = UpdateScreen.PlanWording(plan with { Action = "pause" });
        Assert.Equal(("サーバーの計画を確認", "実行する"), (unknownPlan.Title, unknownPlan.Button)); Assert.StartsWith("action: pause / scope: component", unknownPlan.ServerPlan);
    }
}
