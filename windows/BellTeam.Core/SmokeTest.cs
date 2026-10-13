using System.Text.Json;

namespace BellTeam.Core;

public static class SmokeTest
{
    public static async Task<int> RunAsync(string address, string output)
    {
        var result = new Dictionary<string, object?> { ["server"] = address, ["startedAt"] = DateTimeOffset.Now };
        var exitCode = 1;
        try
        {
            using var api = new BellApi(ServerOrigin.Parse(address));
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(45));
            var session = await api.GetAsync<SessionInfo>("/api/session", timeout.Token);
            result["session"] = session;
            if (!session.Authenticated) throw new BellApiException("認証が必要です。");
            var bots = await api.GetAsync<BotsResponse>("/api/bots", timeout.Token);
            var rooms = await api.GetAsync<RoomsResponse>("/api/rooms", timeout.Token);
            result["bots"] = bots.Bots.Length;
            result["rooms"] = rooms.Rooms.Length;
            var target = bots.Bots.FirstOrDefault() is { } bot ? new ChatTarget(bot.Id, false)
                : rooms.Rooms.FirstOrDefault() is { } room ? new ChatTarget(room.Id, true)
                : throw new BellApiException("読み取りを確かめる会話がありません。");
            var page = await api.GetAsync<MessagePage>(target.Path + "/messages?limit=10", timeout.Token);
            result["conversation"] = new { target.Id, target.IsRoom, messages = page.Items.Length, page.HasMore };
            await foreach (var item in api.EventsAsync(timeout.Token))
            {
                result["sse"] = new { connected = true, firstEvent = item };
                break;
            }
            result["ok"] = true;
            exitCode = 0;
        }
        catch (Exception error)
        {
            result["ok"] = false;
            result["error"] = error.Message;
        }
        result["finishedAt"] = DateTimeOffset.Now;
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(output))!);
        await File.WriteAllTextAsync(output, JsonSerializer.Serialize(result, new JsonSerializerOptions(BellApi.Json) { WriteIndented = true }));
        return exitCode;
    }
}
