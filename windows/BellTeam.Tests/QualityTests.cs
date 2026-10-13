using System.Net;
using System.Net.Http;
using System.Text.Json;
using BellTeam.Core;
using BellTeam.App;

namespace BellTeam.Tests;

public sealed class QualityTests
{
    [Fact]
    public void ActivityGroupsOneBotAndStatusAndKeepsUnknownDeliveriesSeparate()
    {
        var running = new QueueItem { Id = "run", BotId = "bot-one", BotName = "ユキ", Status = "running" };
        var items = Enumerable.Range(0, 12).Select(index => running with { Id = index.ToString() }).Concat([
            running with { Id = "wait", Status = "queued" }, running with { Id = "other", BotId = "bot-two" },
            running with { Id = "legacy-one", BotId = null }, running with { Id = "legacy-two", BotId = null }
        ]);
        var display = QueueItem.DisplayItems(items); Assert.Equal(5, display.Length); Assert.Single(display, item => item.BotId == "bot-one" && item.Status == "running"); Assert.Equal(2, display.Count(item => item.BotId is null));
    }
    [Fact]
    public async Task CreateMemberAndRestartUseTheirActualServerMethods()
    {
        var paths = new Queue<string>(["/api/bots", "/api/bots/bot-new/restart"]);
        using var api = new BellApi(new("http://localhost/"), new StubHandler(async (request, token) =>
        {
            var expected = paths.Dequeue(); Assert.Equal(HttpMethod.Post, request.Method); Assert.Equal(expected, request.RequestUri!.AbsolutePath);
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
            if (expected == "/api/bots") { Assert.Equal("新しいメンバー", body.RootElement.GetProperty("name").GetString()); Assert.Equal("背景\n次の行", body.RootElement.GetProperty("profileText").GetString()); Assert.False(body.RootElement.GetProperty("fastMode").GetBoolean()); Assert.False(body.RootElement.TryGetProperty("id", out _)); return StubHandler.Json("{\"bot\":{\"name\":\"新しいメンバー\",\"harness\":\"codex\"}}"); }
            Assert.Empty(body.RootElement.EnumerateObject()); return StubHandler.Json("{\"ok\":true}");
        }));
        var management = new ManagementApi(api); await management.CreateBotAsync(new() { Name = " 新しいメンバー ", Harness = "codex", ProfileText = "背景\r\n次の行" }); await management.RestartBotAsync("bot-new"); Assert.Empty(paths);
    }
    [Fact]
    public async Task SidebarWorkingStateAndConversationActivityUpdateFromQueue()
    {
        var active = true;
        using var workspace = new App.Workspace(origin => new BellApi(origin, new StubHandler((request, _) => Task.FromResult(StubHandler.Json(request.RequestUri!.AbsolutePath switch
        {
            "/api/session" => "{\"authenticated\":true,\"authMode\":\"local\"}", "/api/bots" => ApiTests.Bots, "/api/rooms" => ApiTests.Rooms,
            "/api/owner" => ApiTests.Owner, "/api/queue" => active ? "{\"items\":[{\"id\":\"a\",\"botId\":\"bot-bell\",\"botName\":\"ベル\",\"status\":\"running\",\"context\":\"room\",\"contextId\":\"room-work\"},{\"id\":\"b\",\"botId\":\"bot-bell\",\"botName\":\"ベル\",\"status\":\"running\",\"context\":\"room\",\"contextId\":\"room-work\"}]}" : ApiTests.EmptyQueue, _ => ApiTests.Page
        })))));
        await workspace.ConnectAsync("http://localhost", listen: false); Assert.True(workspace.Entries.Single(entry => !entry.Target.IsRoom).Working);
        await workspace.SelectAsync(workspace.Entries.Single(entry => entry.Target.IsRoom)); Assert.True(workspace.HasActivity); Assert.Equal("◌  ベル · 処理中", workspace.ActivityText);
        active = false; await workspace.RefreshManagementAsync(); Assert.False(workspace.HasActivity); Assert.False(workspace.Entries.Single(entry => !entry.Target.IsRoom).Working);
    }
    [Fact]
    public void SameNamedMembersStillSwitchTheInspectorToTheSelectedId()
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            try
            {
                using var workspace = new Workspace(origin => new BellApi(origin, new StubHandler((request, _) => Task.FromResult(StubHandler.Json(request.RequestUri!.AbsolutePath switch
                {
                    "/api/session" => "{\"authenticated\":true,\"authMode\":\"local\"}", "/api/bots" => "{\"bots\":[{\"id\":\"one\",\"name\":\"同名\",\"displayName\":\"同名\"},{\"id\":\"two\",\"name\":\"同名\",\"displayName\":\"同名\"}]}", "/api/owner" => ApiTests.Owner, "/api/rooms" => "{\"rooms\":[]}", "/api/queue" => ApiTests.EmptyQueue, _ => ApiTests.Page
                })))));
                workspace.ConnectAsync("http://localhost", listen: false).GetAwaiter().GetResult(); var view = new ProfileView { Workspace = workspace };
                workspace.SelectAsync(workspace.Entries[0]).GetAwaiter().GetResult(); workspace.SelectAsync(workspace.Entries[1]).GetAwaiter().GetResult();
                Assert.Equal("two", view.Children.OfType<AvatarTile>().Single().Entry!.Target.Id);
            }
            catch (Exception error) { failure = error; }
        });
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join(); if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }
    [Fact]
    public void EditedThemeUpdatesExistingBubbleWithoutReplacingSelectableText()
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            try
            {
                var color = "indigo";
                using var workspace = new Workspace(origin => new BellApi(origin, new StubHandler((request, _) => Task.FromResult(StubHandler.Json(request.RequestUri!.AbsolutePath switch
                {
                    "/api/session" => "{\"authenticated\":true,\"authMode\":\"local\"}", "/api/bots" => JsonSerializer.Serialize(new { bots = new[] { new { id = "one", name = "ユキ", displayName = "ユキ", color } } }), "/api/owner" => ApiTests.Owner, "/api/rooms" => "{\"rooms\":[]}", "/api/queue" => ApiTests.EmptyQueue, _ => ApiTests.Page
                })))));
                workspace.ConnectAsync("http://localhost", listen: false).GetAwaiter().GetResult(); workspace.SelectAsync(workspace.Entries.Single()).GetAwaiter().GetResult();
                var card = new MessageCard { Workspace = workspace, Message = new() { Id = "example", At = DateTimeOffset.Now, Direction = "incoming", Message = "選択できる本文" } };
                var row = Assert.IsType<System.Windows.Controls.StackPanel>(card.Content); var bubble = row.Children.OfType<System.Windows.Controls.Border>().Single(); var body = Assert.IsType<System.Windows.Controls.StackPanel>(bubble.Child).Children.OfType<MarkdownView>().Single(); var document = body.Document;
                color = "rose"; workspace.RefreshManagementAsync().GetAwaiter().GetResult();
                Assert.Equal(System.Windows.Media.Color.FromArgb(46, 232, 107, 148), Assert.IsType<System.Windows.Media.SolidColorBrush>(bubble.Background).Color); Assert.Same(document, body.Document);
            }
            catch (Exception error) { failure = error; }
            finally { System.Windows.Threading.Dispatcher.CurrentDispatcher.InvokeShutdown(); }
        });
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join(); if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }
}
