using System.Net;
using System.Net.Http;
using System.Text;
using BellTeam.Core;

namespace BellTeam.Tests;

// 「AIの許可待ちを決裁箱へ送る」 (seat-approval-card.md, the pairing view): Core's record, the contract table's words word for word and the three body calls.
public sealed class SeatLinkTests
{
    private sealed class Body(Func<HttpRequestMessage, HttpResponseMessage> answer) : HttpMessageHandler
    {
        public List<(string Method, string Path)> Calls { get; } = [];
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) { lock (Calls) Calls.Add((request.Method.Method, request.RequestUri!.AbsolutePath)); return Task.FromResult(answer(request)); }
    }
    private static HttpResponseMessage Json(string json, HttpStatusCode status = HttpStatusCode.OK) => new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    [Fact]
    public void TheWordsAreTheContractsTableWordForWord()
    {
        Assert.Equal("決裁箱につなぐ", SeatLinkText.Title);
        Assert.Equal(("コード", "確認コード"), (SeatLinkText.CodeLabel, SeatLinkText.SecretLabel));
        Assert.Equal("BellTeamのAIが決裁箱に出す申請と、AIが許可待ちで止まった時の連絡が、決裁箱のアプリに届きます。つなぐのは1回だけです。", SeatLinkText.Line(new() { State = "none" }));
        Assert.Equal("このQRコードが別の画面に出ている時は、決裁箱のアプリで、接続 → 「AIをつなぐ」 → 「QRコードを読む」を開いて読み、許可してください。", SeatLinkText.Line(new() { State = "waiting" }));
        Assert.Equal("QRコードを読めない時は、「AIをつなぐ」の「コードを確認」にコードを入れ、次の画面の16文字のコードの欄に確認コードを入れて、「つなぐ」を押してください。", SeatLinkText.Type);
        Assert.Equal("つながっています。AIの申請と、許可待ちの連絡が、決裁箱に届きます。", SeatLinkText.Line(new() { State = "linked" }));
        Assert.Equal("決裁箱でつなぎが外されています。もう一度つないでください。", SeatLinkText.Line(new() { State = "removed" }));
        Assert.Equal("決裁箱のアプリで「心当たりがない」が押されました。", SeatLinkText.Line(new() { State = "failed", Reason = "rejected" }));
        Assert.Equal("許可の待ち時間が過ぎました。もう一度つないでください。", SeatLinkText.Line(new() { State = "failed", Reason = "expired" }));
        Assert.All(new SeatLink[] { new() { State = "failed", Reason = "other" }, new() { State = "failed" }, new() { State = "unavailable" } }, link => Assert.Equal("いまはつなげません。少し待って、もう一度押してください。", SeatLinkText.Line(link)));
        Assert.Equal(["つなぐ", "やめる", null, "もう一度つなぐ", "もう一度つなぐ", "もう一度つなぐ"], new[] { "none", "waiting", "linked", "removed", "failed", "unavailable" }.Select(state => SeatLinkText.Action(new() { State = state })));
        Assert.Equal([false, false, false, false, true, true], new[] { "none", "waiting", "linked", "removed", "failed", "unavailable" }.Select(state => SeatLinkText.IsFailure(new() { State = state })));   // red only for failed
        Assert.Equal("17:32まで（JST）", SeatLinkText.Until(DateTimeOffset.Parse("2026-11-24T08:32:00Z")));
        // the state badge above the sentence: green linked, gray removed, red failed (and unavailable), none for none and waiting
        Assert.Equal([null, null, ("つながっています", "ok"), ("つなぎが外れています", "muted"), ("つなげませんでした", "err"), ("つなげませんでした", "err")], new[] { "none", "waiting", "linked", "removed", "failed", "unavailable" }.Select(state => SeatLinkText.Badge(new() { State = state })));
    }

    [Fact]
    public async Task TheThreeCallsReadTheBodysShape_ARouteThatCannotSayIsUnavailable_AndABodyWithoutTheRoutesIsAbsent()
    {
        var body = new Body(request => request.RequestUri!.AbsolutePath.EndsWith("/stop", StringComparison.Ordinal) ? Json("{\"state\":\"none\"}")
            : Json("{\"state\":\"waiting\",\"code\":\"WXYZ-1234\",\"typedSecret\":\"ABCD1234EFGH5678\",\"qrText\":\"https://x.example/pair?c=WXYZ-1234\",\"expiresAt\":\"2026-11-24T08:32:00.000Z\"}"));
        var api = new BellApi(new Uri("http://localhost"), body);
        var waiting = await api.StartSeatLinkAsync();
        Assert.Equal(("waiting", "WXYZ-1234", "ABCD1234EFGH5678", "https://x.example/pair?c=WXYZ-1234", true), (waiting.State, waiting.Code, waiting.TypedSecret, waiting.QrText, waiting.Waiting)); Assert.Equal(DateTimeOffset.Parse("2026-11-24T08:32:00Z"), waiting.ExpiresAt);        Assert.Equal("waiting", (await api.SeatLinkAsync()).State); Assert.Equal("none", (await api.StopSeatLinkAsync()).State);
        Assert.Equal([("POST", "/api/approvals/seat-link/start"), ("GET", "/api/approvals/seat-link"), ("POST", "/api/approvals/seat-link/stop")], body.Calls);
        foreach (var status in new[] { HttpStatusCode.ServiceUnavailable, HttpStatusCode.Forbidden, HttpStatusCode.BadGateway })
        {
            var cannot = new BellApi(new Uri("http://localhost"), new Body(_ => Json("{\"error\":\"X\"}", status)));
            Assert.Equal("unavailable", (await cannot.SeatLinkAsync()).State); Assert.Equal("unavailable", (await cannot.StartSeatLinkAsync()).State);
        }
        var older = new BellApi(new Uri("http://localhost"), new Body(_ => Json("{\"error\":\"NOT_FOUND\"}", HttpStatusCode.NotFound)));   // a body older than the routes: absent, the view is not drawn
        Assert.True((await older.SeatLinkAsync()).Absent);
    }
}
