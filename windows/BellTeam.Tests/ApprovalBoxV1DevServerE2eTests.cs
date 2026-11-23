using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using BellTeam.App;
using BellTeam.Core;
using BellTeam.PeerChannel;
using Kitepon.LoginBilling.Desktop;

namespace BellTeam.Tests;

// The /v1 path against approval-box's own dev server with DEV_PC_OFFER=off (production's peer_channel false): `set DEV_PC_OFFER=off`, `npm run dev:server` in kitepon/approval-box packages/server.
// PC_E2E_ABX_V1_URL=http://127.0.0.1:8788 turns it on; without it this test does nothing. Found the null-text answer refusal (0.8.1).
public class ApprovalBoxV1DevServerE2eTests
{
    [Fact]
    public async Task V1PathEndToEnd()
    {
        var url = Environment.GetEnvironmentVariable("PC_E2E_ABX_V1_URL"); if (url is null) return;
        var dir = Path.Combine(Path.GetTempPath(), "bt-abx-" + Guid.NewGuid().ToString("N"));
        var log = new List<string>();
        var account = new ApprovalBoxAccount(url, new MemoryPassStore());
        await using var box = new ApprovalBoxDevice(dir, account);
        var src = box.Device; src.Changed += () => log.Add(src.State.Status + ":" + src.State.Reason + " n=" + src.Decisions.Count);
        src.Start();
        for (var i = 0; i < 100 && src.State.Status == RuntimeStatus.Connecting; i++) await Task.Delay(50);
        log.Add("before sign-in: " + src.State.Status + ":" + src.State.Reason);
        using var browser = new HttpClient();
        await account.SignInAsync("google", CancellationToken.None, async provider =>
        {
            using var answer = await browser.PostAsync(new Uri(new Uri(url), "/dev/websignin"), new StringContent(JsonSerializer.Serialize(new { providerUrl = provider.ToString() }), Encoding.UTF8, "application/json"));
            using var doc = JsonDocument.Parse(await answer.Content.ReadAsStringAsync());
            using var back = await browser.GetAsync(doc.RootElement.GetProperty("location").GetString());
        });
        Assert.True(account.SignedIn); src.Refresh();
        for (var i = 0; i < 200 && src.State.Status != RuntimeStatus.Live; i++) await Task.Delay(50);
        log.Add("after sign-in: " + src.State.Status + ":" + src.State.Reason);
        Assert.True(src.State.Status == RuntimeStatus.Live, string.Join(" | ", log));
        // an AI of the same account files one request through a connection token
        var access = await account.AccessAsync(CancellationToken.None); var bearer = access.Headers["authorization"];
        async Task<JsonElement> Post(string path, object body, string auth) { using var r = new HttpRequestMessage(HttpMethod.Post, new Uri(new Uri(url), path)) { Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json") }; r.Headers.TryAddWithoutValidation("authorization", auth); using var a = await browser.SendAsync(r); return JsonDocument.Parse(await a.Content.ReadAsStringAsync()).RootElement.Clone(); }
        var token = (await Post("/v1/tokens", new { label = "windows live check" }, bearer)).GetProperty("token").GetString()!;
        var ask = new { title = "Windows 0.8.0 live check: answer yes", options = new[] { new { id = "ok", label = "はい" }, new { id = "no", label = "いいえ" } }, session_label = "windows-live", client = "claude-code", requester = "anis" };
        var first = await Post("/connector/v1/decisions", ask, "Bearer " + token);
        var ct = first.TryGetProperty("check_token", out var c1) ? c1.GetString() : first.GetProperty("error").GetProperty("check_token").GetString();
        var filed = await Post("/connector/v1/decisions", new { ask.title, ask.options, ask.session_label, ask.client, ask.requester, check_token = ct }, "Bearer " + token);
        var id = filed.TryGetProperty("decision_id", out var d1) ? d1.GetString() : filed.GetProperty("id").GetString();
        log.Add("filed " + id);
        ViewDecision? seen = null;
        for (var i = 0; i < 200 && seen is null; i++) { seen = src.Decisions.FirstOrDefault(d => d.Id == id); await Task.Delay(50); }
        Assert.True(seen is not null, "the decision reached the client (SSE or list): " + string.Join(" | ", log));
        log.Add("client sees: " + seen!.Title + " status=" + seen.Status + " v" + seen.Version + " origin=" + seen.Origin?.Tool + "/" + seen.Requester?.Name);
        var outcome = await src.AnswerAsync(id!, "ok", null, seen.Version);
        log.Add("answer ack=" + outcome.Ack);
        ViewDecision? done = null;
        for (var i = 0; i < 200 && done?.Status != "answered"; i++) { done = src.Decisions.FirstOrDefault(d => d.Id == id); await Task.Delay(50); }
        log.Add("after answer: status=" + done?.Status + " answer=" + done?.Answer?.OptionId);
        Assert.True(done?.Status == "answered", string.Join(" | ", log));
    }
}
