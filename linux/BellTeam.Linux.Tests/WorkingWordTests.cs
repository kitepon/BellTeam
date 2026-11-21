using System.Text.Json;
using BellTeam.Core;

namespace BellTeam.Linux;

// a471-spinner-words-linux: the working row reads the server's workingWord from /api/queue (working-word.md).
public sealed class WorkingWordTests
{
    [Fact]
    public void ARunningRowShowsTheServersWordAndAnOlderServerKeepsTheOldLine()
    {
        var response = JsonSerializer.Deserialize<QueueResponse>("""{"items":[{"id":"1","botId":"a","botName":"ユキ","status":"running","workingWord":"Mulling"},{"id":"2","botId":"a","botName":"ユキ","status":"queued"},{"id":"3","botId":"b","botName":"ベル","status":"running"}]}""", BellApi.Json)!;
        Assert.Equal(["ユキ · Mulling…", "ユキ · 送信待ち", "ベル · 処理中"], response.Items.Select(item => item.Line("部屋")));
    }
}
