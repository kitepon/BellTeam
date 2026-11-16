using System.Net;
using System.Text.Json;
using BellTeam.Core;

namespace BellTeam.Tests;

// conversation forward.md: the Core half of forwarding a message and showing what came from elsewhere.
public sealed class ForwardTests
{
    private static TimelineMessage Row(string json) => JsonSerializer.Deserialize<TimelineMessage>(json, BellApi.Json)!;

    [Fact]
    public void OriginIsReadAndTheContentIsSplitFromTheCommentByCodePoints()
    {
        // "これお願い" is 5 code points, then a blank line (2), so the content starts at 7; the astral character counts once.
        var row = Row("""{"id":"f1","at":"2026-11-16T12:00:00Z","direction":"outgoing","message":"😀お願い\n\n元の発言","origin":{"kind":"forward","from":{"id":"bot-a","name":"ベル"},"at":"2026-11-16T11:00:00Z","content_start":5}}""");
        Assert.Equal(new MessageOrigin("forward", "ベル", DateTimeOffset.Parse("2026-11-16T11:00:00Z"), 5), row.Origin);
        Assert.Equal(("😀お願い", "元の発言"), Timeline.OriginParts(row) is var (comment, content) ? (comment, content.TrimStart('\n')) : default);
        Assert.Equal("転送", Timeline.OriginMark(row.Origin!));
        var share = Row("""{"id":"f2","at":"2026-11-16T12:00:00Z","message":"本文\nhttps://example.com","origin":{"kind":"share","app":"LINE","urls":["https://example.com"],"content_start":0}}""");
        Assert.Equal(("", "本文\nhttps://example.com"), Timeline.OriginParts(share));
        Assert.Equal("共有 · LINE", Timeline.OriginMark(share.Origin!));
        Assert.Equal("共有", Timeline.OriginMark(new MessageOrigin("share")));
    }

    [Fact]
    public void AnUnknownOrMalformedOriginIsANormalMessage()
    {
        foreach (var bad in new[] { "\"x\"", "5", "[]", "{}", "{\"kind\":\"other\"}" })
        {
            var row = Row($$"""{"id":"f3","at":"2026-11-16T12:00:00Z","message":"本文","origin":{{bad}}}""");
            Assert.Equal(("", "本文"), Timeline.OriginParts(row));
            Assert.True(row.Origin is null or { Kind: "" });
        }
    }

    [Fact]
    public async Task ForwardIsSentAsASourceAndTheServersRefusalsAreSaidPlainly()
    {
        string? body = null;
        var api = new BellApi(new Uri("http://localhost"), new StubHandler(async (request, _) => { body = await request.Content!.ReadAsStringAsync(); return StubHandler.Json("""{"delivery_id":"d1"}"""); }));
        await api.SendAsync(new ChatTarget("bot-two", false), "これお願い", [], null, default, forward: new ForwardSource("room", "planning", "m7"));
        using var json = JsonDocument.Parse(body!);
        Assert.Equal(("room", "planning", "m7"), (json.RootElement.GetProperty("forward").GetProperty("source").GetProperty("kind").GetString(), json.RootElement.GetProperty("forward").GetProperty("source").GetProperty("id").GetString(), json.RootElement.GetProperty("forward").GetProperty("message_id").GetString()));
        Assert.False(json.RootElement.TryGetProperty("reply_to", out _));
        Assert.Contains("画像つき", Timeline.ForwardRefusal(new BellApiException("x", HttpStatusCode.UnsupportedMediaType, "FILE_NOT_SUPPORTED")));
        Assert.Contains("見つかりません", Timeline.ForwardRefusal(new BellApiException("x", HttpStatusCode.NotFound, "FORWARD_SOURCE_NOT_FOUND")));
        Assert.Equal("そのまま", Timeline.ForwardRefusal(new BellApiException("そのまま", HttpStatusCode.BadRequest, "OTHER")));
    }

    [Fact]
    public void BotToBotRowsCanBeForwardedButNotARequestCardOrAnEcho()
    {
        TimelineMessage Plain(string id, string kind) => new() { Id = id, At = DateTimeOffset.Now, Kind = kind, Message = "t" };
        Assert.True(Timeline.IsForwardable(Plain("m", "peer")));
        Assert.True(Timeline.IsForwardable(Plain("m", "message")));
        Assert.False(Timeline.IsForwardable(Plain(PendingSend.NewId(), "message")));
        Assert.False(Timeline.IsForwardable(Plain("m", "status")));
    }
}
