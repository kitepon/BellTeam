using System.IO;
using System.Net.Http;
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
                var window = new UpdateCenterWindow(workspace); window.InitializeAsync().GetAwaiter().GetResult();
                var dock = Assert.IsType<DockPanel>(window.Content);
                var body = Assert.IsType<StackPanel>(dock.Children.OfType<ScrollViewer>().Single().Content);
                var sections = body.Children.OfType<Border>().Select(border => border.Child).OfType<StackPanel>().ToArray();
                Assert.Contains(sections.SelectMany(section => section.Children.OfType<TextBlock>()), item => item.Text.Contains("稼働版:") && item.Text.Contains("公開版:") && item.Text.Contains("更新あり"));
                Assert.Contains(sections.SelectMany(section => section.Children.OfType<Button>()), item => Equals(item.Content, "更新計画を確認"));
                Assert.False(window.IsVisible); window.Close();
            }
            catch (Exception error) { failure = error; }
            finally { System.Windows.Threading.Dispatcher.CurrentDispatcher.InvokeShutdown(); }
        });
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
        if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }
}
