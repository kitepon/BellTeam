using System.Net.Http;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;

public sealed class PinTests
{
    private static string Bot(string id, string recent, string? pinnedAt) =>
        "{\"id\":\"" + id + "\",\"name\":\"" + id + "\",\"displayName\":\"" + id + "\",\"harness\":\"codex\",\"online\":true,\"pinnedAt\":" + (pinnedAt is null ? "null" : "\"" + pinnedAt + "\"")
        + ",\"recent\":{\"id\":\"m-" + id + "\",\"at\":\"" + recent + "\",\"message\":\"本文\"}}";

    // a480 (members/profiles.md): pinned first by pinnedAt (the pin order), the rest by recency; one PATCH {pinned}, then the roster is read again.
    [Fact]
    public async Task PinMovesAMemberIntoPinOrderWithOnePatchAndMarksTheRow()
    {
        var patches = new List<string>();
        var second = false;
        using var workspace = new Workspace(origin => new BellApi(origin, new StubHandler(async (request, _) =>
        {
            var path = request.RequestUri!.AbsolutePath;
            if (request.Method == HttpMethod.Patch) { patches.Add(path + " " + await request.Content!.ReadAsStringAsync()); second = true; return StubHandler.Json("""{"bot":{"id":"bot-a","name":"bot-a","harness":"codex"}}"""); }
            return StubHandler.Json(path switch
            {
                "/api/session" => """{"authenticated":true,"authMode":"local"}""",
                "/api/bots" => "{\"bots\":[" + string.Join(",", [Bot("bot-a", "2026-11-21T09:00:00Z", second ? "2026-11-21T01:30:00Z" : null), Bot("bot-b", "2026-11-21T02:00:00Z", "2026-11-21T02:00:00Z"), Bot("bot-c", "2026-11-21T01:00:00Z", "2026-11-21T01:00:00Z")]) + "]}",
                "/api/owner" => ApiTests.Owner, "/api/queue" => ApiTests.EmptyQueue, "/api/rooms" => ApiTests.Rooms, _ => ApiTests.Page
            });
        })));
        await workspace.ConnectAsync("http://localhost", listen: false);
        Assert.Equal(["room-work", "bot-c", "bot-b", "bot-a"], workspace.Entries.Select(item => item.Target.Id));
        Assert.Equal(["📌", "📌", ""], workspace.Entries.Where(item => item.IsMember).Select(item => item.PinBadge.Trim()));
        Assert.Equal("ピン留め", workspace.Entries.Last().PinMenuText);
        Assert.Equal("ピン留めを外す", workspace.Entries.Single(item => item.Target.Id == "bot-b").PinMenuText);

        await workspace.SetPinnedAsync("bot-a", true);
        Assert.Equal(["/api/bots/bot-a {\"pinned\":true}"], patches);
        Assert.Equal(["room-work", "bot-c", "bot-a", "bot-b"], workspace.Entries.Select(item => item.Target.Id));
    }
}
