using System.Net;
using System.Net.Http;
using System.Text;
using BellTeam.Core;

namespace BellTeam.Tests;

public class HomeSessionsTests
{
    private sealed class Home : HttpMessageHandler
    {
        public readonly List<string> Calls = [];
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            Calls.Add(request.Method + " " + request.RequestUri!.AbsolutePath);
            var body = request.Method == HttpMethod.Get
                ? """{"sessions":[{"id":"S1","kind":"account","appKind":"windows","passId":"P1","state":"active","created":"2026-11-20T10:00:00.000Z","lastUse":"2026-11-21T10:00:00.000Z","current":true},{"id":"S2","kind":"account","appKind":"apple","state":"none","created":"2026-11-19T10:00:00.000Z","current":false},{"id":"S3","kind":"console","state":"unknown","current":false}]}"""
                : """{"ok":true}""";
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
        }
    }

    [Fact]
    public async Task EveryDeviceOfTheServerIsListedWithItsKindAndAnOwnRowAndAnotherOneIsEndedAtTheHome()
    {
        var home = new Home(); using var api = new BellApi(new("http://localhost/"), home) { SessionToken = "abc" };
        var rows = await new PlanningApi(api).HomeSessionsAsync();
        Assert.Equal(["Windows", "iPhone・iPad・Mac", "サーバーのコンソールのコード"], rows.Select(HomeSessionText.KindOf));
        Assert.Equal(["ログアウト", "ログアウトさせる", "ログアウトさせる"], rows.Select(HomeSessionText.Button));
        Assert.Equal("入った日時 " + HomeSessionText.Time(rows[0].Created!.Value) + "・最後に使った日時 " + HomeSessionText.Time(rows[0].LastUse!.Value), HomeSessionText.Times(rows[0]));
        Assert.Equal("入った日時 " + HomeSessionText.Time(rows[1].Created!.Value), HomeSessionText.Times(rows[1]));
        Assert.Equal("", HomeSessionText.Times(rows[2]));
        await new PlanningApi(api).EndHomeSessionAsync("S 2");
        Assert.Equal(["GET /api/home/sessions", "DELETE /api/home/sessions/S%202"], home.Calls);
    }
}
