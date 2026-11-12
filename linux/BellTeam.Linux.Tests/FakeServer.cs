using System.Net;
using System.Text;

namespace BellTeam.Linux;

// Answers the reads Workspace makes from an in-memory body; anything else is a 404 (the optional reads treat that as absent).
internal sealed class FakeServer(string session = """{"authenticated":true,"authMode":"local"}""", bool down = false) : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        if (down) throw new HttpRequestException("connection refused");
        var body = request.RequestUri!.PathAndQuery switch
        {
            "/api/session" => session,
            "/api/setup" => """{"phase":"ready","harnesses":[],"complete":true}""",
            "/api/bots?avatar=omit" => """{"bots":[{"id":"b1","name":"ベル","displayName":"ベル","online":true}]}""",
            "/api/rooms?avatar=omit" => """{"rooms":[]}""",
            "/api/queue" => """{"items":[]}""",
            "/api/owner?avatar=omit" => """{"owner":{"name":"利用者"}}""",
            "/api/bots/b1/messages?limit=30" => """{"items":[{"id":"m1","at":"2026-11-12T00:00:00Z","message":"hi","direction":"incoming"}],"has_more":false}""",
            _ => null
        };
        return Task.FromResult(body is null ? new HttpResponseMessage(HttpStatusCode.NotFound) : new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
    }
}
