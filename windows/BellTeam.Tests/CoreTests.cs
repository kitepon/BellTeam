using System.IO;
using System.Text;
using System.Text.Json;
using BellTeam.Core;

namespace BellTeam.Tests;

public sealed class CoreTests
{
    [Theory]
    [InlineData("http://192.168.1.2:18891")]
    [InlineData("http://localhost:18891/")]
    [InlineData("http://127.0.0.1:18891")]
    [InlineData("http://10.0.0.2")]
    [InlineData("http://172.16.0.1")]
    [InlineData("http://172.31.255.255")]
    [InlineData("http://169.254.1.1")]
    [InlineData("http://server.local")]
    [InlineData("http://server")]
    [InlineData("http://[::1]")]
    [InlineData("http://[fd00::1]")]
    [InlineData("http://[fe80::1]")]
    [InlineData("https://bellteam.example.com")]
    public void AcceptsSupportedOrigins(string address) => Assert.Equal("/", ServerOrigin.Parse(address).AbsolutePath);

    [Theory]
    [InlineData("http://example.com")]
    [InlineData("http://172.32.0.1")]
    [InlineData("http://192.169.1.1")]
    [InlineData("http://[2001:db8::1]")]
    [InlineData("ftp://localhost")]
    [InlineData("https://user:password@example.com")]
    [InlineData("https://example.com/path")]
    [InlineData("https://example.com?query=1")]
    [InlineData("https://example.com#fragment")]
    [InlineData("not a url")]
    public void RejectsUnsupportedOrigins(string address) => Assert.Throws<ArgumentException>(() => ServerOrigin.Parse(address));

    [Fact]
    public void SettingsRetainConnectionWhenWindowChanges()
    {
        var directory = Path.Combine(Path.GetTempPath(), "bellteam-settings-" + Guid.NewGuid());
        try
        {
            var store = new SettingsStore(directory);
            Assert.Null(store.Load().ServerUrl);
            store.Save(new() { ServerUrl = "http://localhost:18891/" });
            store.Save(store.Load() with { Window = new(12, 34, 1280, 820, false) });
            Assert.Equal("http://localhost:18891/", store.Load().ServerUrl);
            Assert.Equal(34, store.Load().Window!.Top);
            File.WriteAllText(store.FilePath, "broken");
            Assert.Throws<JsonException>(() => store.Load());
        }
        finally { Directory.Delete(directory, true); }
    }

    [Fact]
    public void FailedSendRetainsNewTypingAndNeverSendsTwice()
    {
        var draft = new ConversationDraft { Text = "  先に送る本文  " };
        var sent = draft.BeginSend();
        Assert.Equal("", draft.Text);
        Assert.True(draft.Sending);
        Assert.Throws<InvalidOperationException>(() => draft.BeginSend());
        draft.Text = "送信中に書いた続き";
        draft.FailSend(sent, "受付を確認できませんでした");
        Assert.Equal("先に送る本文\n送信中に書いた続き", draft.Text);
        Assert.False(draft.Sending);
        Assert.NotNull(draft.Error);
    }

    [Fact]
    public async Task ReadsUtf8MultilineSseAndIgnoresKeepalive()
    {
        using var stream = new MemoryStream(Encoding.UTF8.GetBytes(": keepalive\r\n\r\nevent: messages\r\ndata: {\r\ndata: \"type\":\"message\",\r\ndata: \"message\":\"こんにちは\"}\r\n\r\ndata: {}\n\n"));
        var events = new List<JsonElement>();
        await foreach (var item in SseReader.ReadAsync(stream)) events.Add(item);
        Assert.Equal(2, events.Count);
        Assert.Equal("こんにちは", events[0].GetProperty("message").GetString());
    }

    [Theory]
    [InlineData("data: invalid\n\n")]
    [InlineData("data: []\n\n")]
    public async Task InvalidSseIsAnError(string payload)
    {
        using var stream = new MemoryStream(Encoding.UTF8.GetBytes(payload));
        await Assert.ThrowsAsync<BellApiException>(async () => { await foreach (var item in SseReader.ReadAsync(stream)) { } });
    }

    [Fact]
    public void TimelineUpdatesExistingRowsAndRetainsOlderHistory()
    {
        var old = new TimelineMessage { Id = "old", At = DateTimeOffset.Parse("2026-10-12T00:00:00Z"), Message = "以前の会話" };
        var pending = new TimelineMessage { Id = "pending", At = DateTimeOffset.Parse("2026-10-13T00:00:00Z"), Delivery = "queued" };
        var updated = pending with { Delivery = "delivered", Message = "確定した本文" };
        var merged = Timeline.Merge([old, pending], [updated, updated]);
        Assert.Equal(2, merged.Length);
        Assert.Equal("以前の会話", merged[0].Message);
        Assert.Equal("delivered", merged[1].Delivery);
    }
}
