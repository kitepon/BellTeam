using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using BellTeam.Core;

namespace BellTeam.Tests;

public sealed class StubHandler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> respond) : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => respond(request, cancellationToken);
    public static HttpResponseMessage Json(string json, HttpStatusCode status = HttpStatusCode.OK) => new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
}

public sealed class ApiTests
{
    public const string EmptyQueue = """{"items":[]}""";
    public const string Owner = """{"owner":{"name":"利用者"}}""";
    public const string Bots = """{"bots":[{"id":"bot-bell","name":"ベル","displayName":"ベル 開発","harness":"codex","profileText":"プロフィール","online":true,"recent":{"id":"m1","at":"2026-10-13T01:00:00Z","message":"こんにちは"}}]}""";
    public const string Rooms = """{"rooms":[{"id":"room-work","name":"作業部屋","purpose":"開発","memberIds":["bot-bell"],"recent":null}]}""";
    public const string Page = """{"items":[{"id":"m1","kind":"message","direction":"incoming","at":"2026-10-13T01:00:00Z","message":"**こんにちは**","image_count":2}],"has_more":true}""";

    [Fact]
    public async Task ReadsActualApiShapes()
    {
        using var api = new BellApi(new("http://localhost/"), new StubHandler((request, _) => Task.FromResult(StubHandler.Json(request.RequestUri!.AbsolutePath switch { "/api/bots" => Bots, "/api/owner" => ApiTests.Owner, "/api/queue" => EmptyQueue, "/api/rooms" => Rooms, _ => Page }))));
        Assert.Equal("プロフィール", (await api.GetAsync<BotsResponse>("/api/bots")).Bots[0].ProfileText);
        Assert.Equal("bot-bell", (await api.GetAsync<RoomsResponse>("/api/rooms")).Rooms[0].MemberIds[0]);
        var page = await api.GetAsync<MessagePage>("/api/bots/bot-bell/messages");
        Assert.True(page.HasMore);
        Assert.Equal(2, page.Items[0].ImageCount);
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("{\"bots\":null}")]
    [InlineData("{\"bots\":[{\"id\":\"bot-bell\"}]}")]
    public async Task RejectsMissingOrNullRequiredData(string json)
    {
        using var api = new BellApi(new("http://localhost/"), new StubHandler((_, _) => Task.FromResult(StubHandler.Json(json))));
        await Assert.ThrowsAsync<BellApiException>(() => api.GetAsync<BotsResponse>("/api/bots"));
    }

    [Fact]
    public async Task ServerRejectionKeepsReasonAndNeverRetries()
    {
        var attempts = 0;
        using var api = new BellApi(new("http://localhost/"), new StubHandler((_, _) => { attempts++; return Task.FromResult(StubHandler.Json("""{"error":"SEND_FAILED","message":"作業を受け付けられません"}""", HttpStatusCode.ServiceUnavailable)); }));
        var error = await Assert.ThrowsAsync<BellApiException>(() => api.SendAsync(new("bot-bell", false), "本文", null));
        Assert.Contains("作業を受け付けられません", error.Message);
        Assert.Equal(1, attempts);
    }

    [Fact]
    public async Task SendsRoomTargetsInSharedApiFormat()
    {
        using var api = new BellApi(new("http://localhost/"), new StubHandler(async (request, token) =>
        {
            Assert.Equal("/api/rooms/room-work/messages", request.RequestUri!.AbsolutePath);
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
            Assert.Equal("本文", body.RootElement.GetProperty("message").GetString());
            Assert.Equal("bot-bell", body.RootElement.GetProperty("targets")[0].GetString());
            Assert.Equal(0, body.RootElement.GetProperty("images").GetArrayLength());
            return StubHandler.Json("{\"id\":\"accepted\"}");
        }));
        await api.SendAsync(new("room-work", true), "本文", ["bot-bell"]);
    }

    [Theory]
    [InlineData(302)]
    [InlineData(401)]
    public async Task AuthenticationFailureIsExplicit(int status)
    {
        using var api = new BellApi(new("http://localhost/"), new StubHandler((_, _) => Task.FromResult(StubHandler.Json("{}", (HttpStatusCode)status))));
        var error = await Assert.ThrowsAsync<BellApiException>(() => api.GetAsync<SessionInfo>("/api/session"));
        Assert.Contains("Cloudflare Access", error.Message);
    }

    [Fact]
    public async Task HtmlResponseAndSseEofAreErrors()
    {
        using var html = new BellApi(new("http://localhost/"), new StubHandler((_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("<html>login</html>", Encoding.UTF8, "text/html") })));
        await Assert.ThrowsAsync<BellApiException>(() => html.GetAsync<SessionInfo>("/api/session"));
        using var sse = new BellApi(new("http://localhost/"), new StubHandler((_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("event: ready\ndata: {}\n\n", Encoding.UTF8, "text/event-stream") })));
        var count = 0;
        await Assert.ThrowsAsync<BellApiException>(async () => { await foreach (var item in sse.EventsAsync()) count++; });
        Assert.Equal(1, count);
    }
}
