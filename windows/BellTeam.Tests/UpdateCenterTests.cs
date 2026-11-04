using System.IO;
using System.Net.Http;
using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using BellTeam.Core;
using BellTeam.App;
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

    [Fact]
    public void UpdateCenterDisplaysRealInventoryWithoutOpeningAWindow()
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            try
            {
                var inventory = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "update-center.json"));
                using var workspace = new Workspace(origin => new BellApi(origin, new StubHandler((request, _) => Task.FromResult(StubHandler.Json(request.RequestUri!.AbsolutePath switch
                {
                    "/api/session" => "{\"authenticated\":true,\"authMode\":\"local\"}", "/api/bots" => ApiTests.Bots, "/api/rooms" => ApiTests.Rooms, "/api/owner" => ApiTests.Owner, "/api/queue" => ApiTests.EmptyQueue, "/api/updates" => inventory, _ => ApiTests.Page
                })))));
                workspace.ConnectAsync("http://localhost", listen: false).GetAwaiter().GetResult();
                var window = new UpdateCenterWindow(workspace, new SettingsStore(Path.Combine(Path.GetTempPath(), "BellTeam-view-" + Guid.NewGuid()))); window.InitializeAsync().GetAwaiter().GetResult();
                var dock = Assert.IsType<DockPanel>(window.Content);
                var body = Assert.IsType<StackPanel>(dock.Children.OfType<ScrollViewer>().Single().Content);
                var sections = body.Children.OfType<Border>().Select(border => border.Child).OfType<StackPanel>().ToArray();
                var text = body.Children.OfType<TextBlock>().Concat(sections.SelectMany(section => section.Children.OfType<TextBlock>())).Select(item => item.Text).ToArray();
                Assert.Contains("更新があります", text);
                Assert.Contains(sections.SelectMany(section => section.Children.OfType<Button>()), item => Equals(item.Content, "更新する"));
                Assert.Single(sections.SelectMany(section => section.Children.OfType<Button>()));
                Assert.DoesNotContain(text, item => item.Contains("aaaaaaaaaaaaaaaa") || item.Contains("要求ID") || item.Contains("container"));
                Assert.False(Assert.Single(body.Children.OfType<Expander>()).IsExpanded);
                Assert.False(window.IsVisible); window.Close();
            }
            catch (Exception error) { failure = error; }
            finally { System.Windows.Threading.Dispatcher.CurrentDispatcher.InvokeShutdown(); }
        });
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
        if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }

    [Fact]
    public void UpdateScreenKeepsActualStatesAndHidesTechnicalValues()
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            try
            {
                var fixture = JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "update-center.json")))!;
                var savedPlan = fixture["plans"]![0]!.DeepClone();
                var operation = new JsonObject { ["requestId"] = "22222222-2222-4222-8222-222222222222", ["plan"] = savedPlan, ["admission"] = "accepted", ["phase"] = "applying", ["execution"] = "pending", ["verification"] = "pending", ["error"] = null, ["reference"] = null };
                fixture["operation"] = operation;
                string expected = "更新しています"; var missingApi = false;
                using var workspace = new Workspace(origin => new BellApi(origin, new StubHandler((request, _) => Task.FromResult(request.RequestUri!.AbsolutePath == "/api/updates" && missingApi ? StubHandler.Json("{\"error\":\"NOT_FOUND\"}", HttpStatusCode.NotFound) : StubHandler.Json(request.RequestUri.AbsolutePath switch
                {
                    "/api/session" => "{\"authenticated\":true,\"authMode\":\"local\"}", "/api/bots" => ApiTests.Bots, "/api/rooms" => ApiTests.Rooms, "/api/owner" => ApiTests.Owner, "/api/queue" => ApiTests.EmptyQueue, "/api/updates" => fixture.ToJsonString(), _ => ApiTests.Page
                })))));
                workspace.ConnectAsync("http://localhost", listen: false).GetAwaiter().GetResult();
                var window = new UpdateCenterWindow(workspace, new SettingsStore(Path.Combine(Path.GetTempPath(), "BellTeam-view-" + Guid.NewGuid())));
                string[] Check()
                {
                    window.InitializeAsync().GetAwaiter().GetResult();
                    var body = Assert.IsType<StackPanel>(Assert.IsType<DockPanel>(window.Content).Children.OfType<ScrollViewer>().Single().Content);
                    var text = body.Children.OfType<TextBlock>().Concat(body.Children.OfType<Border>().Select(border => border.Child).OfType<StackPanel>().SelectMany(section => section.Children.OfType<TextBlock>())).Select(item => item.Text).ToArray();
                    Assert.Contains(expected, text);
                    Assert.DoesNotContain(text, item => item.Contains("22222222-2222") || item.Contains("aaaaaaaaaaaaaaaa"));
                    Assert.False(Assert.Single(body.Children.OfType<Expander>()).IsExpanded);
                    return text;
                }
                Check();
                operation["admission"] = "unknown"; operation["phase"] = "unknown"; operation["execution"] = "unknown"; operation["verification"] = "unknown"; expected = "更新の結果を確認中";
                var unknownText = Check(); Assert.Contains("更新の結果をまだ確認できません。", unknownText); Assert.DoesNotContain(unknownText, item => item.Contains("記録") || item.Contains("送り直し"));
                operation["admission"] = "accepted"; operation["phase"] = "failed"; operation["execution"] = "failed"; expected = "更新を完了できませんでした"; Check();
                operation["phase"] = "completed"; operation["execution"] = "succeeded"; operation["verification"] = "succeeded"; expected = "更新があります"; Check();
                fixture["operation"] = null; fixture["components"]![0]!["changes"] = new JsonArray();
                var noChanges = Check(); Assert.DoesNotContain("今回の更新", noChanges); Assert.DoesNotContain(noChanges, item => item.Contains("変更内容はありません") || item.Contains("公開版"));
                fixture["components"]![0]!["published"]!["version"] = "0.4.5";
                Assert.Contains("公開版 0.4.5", Check());
                fixture["operation"] = operation;
                fixture["components"]![0]!["comparison"]!["state"] = "up_to_date"; expected = "BellTeam本体を更新しました"; Check();
                missingApi = true; expected = "更新を確認できませんでした"; Check();
                window.Close();
            }
            catch (Exception error) { failure = error; }
            finally { System.Windows.Threading.Dispatcher.CurrentDispatcher.InvokeShutdown(); }
        });
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
        if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }

    [Fact]
    public void UpdateButtonShowsFixedPlanWithoutStartingIt()
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            try
            {
                var fixture = JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "update-center.json")))!;
                var plan = fixture["plans"]![0]!.DeepClone(); plan["expiresAt"] = DateTimeOffset.UtcNow.AddMinutes(10).ToString("O");
                var calls = new List<string>();
                using var workspace = new Workspace(origin => new BellApi(origin, new StubHandler(async (request, token) =>
                {
                    var path = request.RequestUri!.AbsolutePath; calls.Add(request.Method + " " + path);
                    if (path == "/api/updates/plans")
                    {
                        var input = JsonNode.Parse(await request.Content!.ReadAsStringAsync(token))!;
                        Assert.Equal("component", input["scope"]!.GetValue<string>()); Assert.Equal("container", input["componentId"]!.GetValue<string>());
                        return StubHandler.Json(new JsonObject { ["plan"] = plan.DeepClone() }.ToJsonString());
                    }
                    return StubHandler.Json(path switch { "/api/session" => "{\"authenticated\":true,\"authMode\":\"local\"}", "/api/bots" => ApiTests.Bots, "/api/rooms" => ApiTests.Rooms, "/api/owner" => ApiTests.Owner, "/api/queue" => ApiTests.EmptyQueue, "/api/updates" => fixture.ToJsonString(), _ => ApiTests.Page });
                })));
                workspace.ConnectAsync("http://localhost", listen: false).GetAwaiter().GetResult();
                var window = new UpdateCenterWindow(workspace, new SettingsStore(Path.Combine(Path.GetTempPath(), "BellTeam-view-" + Guid.NewGuid())));
                window.InitializeAsync().GetAwaiter().GetResult();
                var body = Assert.IsType<StackPanel>(Assert.IsType<DockPanel>(window.Content).Children.OfType<ScrollViewer>().Single().Content);
                var card = Assert.IsType<StackPanel>(body.Children.OfType<Border>().First().Child);
                card.Children.OfType<Button>().Single().RaiseEvent(new System.Windows.RoutedEventArgs(Button.ClickEvent));
                card = Assert.IsType<StackPanel>(body.Children.OfType<Border>().First().Child);
                Assert.Contains(card.Children.OfType<TextBlock>(), item => item.Text.Contains("BellTeam本体"));
                Assert.Contains(card.Children.OfType<TextBlock>(), item => item.Text.Contains("会話と処理が一時中断"));
                Assert.Equal("更新を始める", card.Children.OfType<Button>().Single().Content);
                Assert.Single(calls, call => call == "POST /api/updates/plans");
                Assert.DoesNotContain("POST /api/updates/operations", calls);
                window.Close();
                var second = fixture["components"]![0]!.DeepClone(); second["id"] = "usage"; second["name"] = "利用設定"; fixture["components"]!.AsArray().Add(second);
                calls.Clear();
                var selector = new UpdateCenterWindow(workspace, new SettingsStore(Path.Combine(Path.GetTempPath(), "BellTeam-view-" + Guid.NewGuid())));
                selector.InitializeAsync().GetAwaiter().GetResult();
                var selectorBody = Assert.IsType<StackPanel>(Assert.IsType<DockPanel>(selector.Content).Children.OfType<ScrollViewer>().Single().Content);
                var selectorCard = Assert.IsType<StackPanel>(selectorBody.Children.OfType<Border>().First().Child);
                selectorCard.Children.OfType<Button>().Single().RaiseEvent(new System.Windows.RoutedEventArgs(Button.ClickEvent));
                Assert.DoesNotContain(calls, call => call.StartsWith("POST "));
                selectorCard = Assert.IsType<StackPanel>(selectorBody.Children.OfType<Border>().First().Child);
                Assert.Contains(selectorCard.Children.OfType<Button>(), item => Equals(item.Content, "利用設定"));
                selectorCard.Children.OfType<Button>().Single(item => Equals(item.Content, "BellTeam本体")).RaiseEvent(new System.Windows.RoutedEventArgs(Button.ClickEvent));
                Assert.Single(calls, call => call == "POST /api/updates/plans");
                Assert.DoesNotContain("POST /api/updates/operations", calls); selector.Close();
            }
            catch (Exception error) { failure = error; }
            finally { System.Windows.Threading.Dispatcher.CurrentDispatcher.InvokeShutdown(); }
        });
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
        if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }
}
