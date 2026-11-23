using System.Text;
using System.Text.Json;
using BellTeam.Core;
using Kitepon.ApprovalBox.Client;
using Kitepon.LoginBilling.Desktop;
using Xunit.Abstractions;

namespace BellTeam.Linux;

// The whole client against approval-box's local dev server. Never runs by default: ABX_INTEROP_URL=http://127.0.0.1:8788 and ABX_INTEROP_PHASE=v1 turn it on (approval-box: DEV_PC_OFFER=off npm run dev:server, Nayuta 2026-11-24).
// The peer path of the component is proven by its own tests (kitepon/approval-box-apps dotnet/); this one proves BellTeam's host part: sign-in, the switch, the list, the origin rule and one answer over /v1.
public sealed class ApprovalBoxInteropTests(ITestOutputHelper output)
{
    private static readonly string? Url = Environment.GetEnvironmentVariable("ABX_INTEROP_URL");
    private static readonly string Phase = Environment.GetEnvironmentVariable("ABX_INTEROP_PHASE") ?? "";

    private static async Task Open(HttpClient http, Uri providerUrl)
    {
        using var made = await http.PostAsync(Url + "/dev/websignin", new StringContent(JsonSerializer.Serialize(new { providerUrl = providerUrl.ToString(), sub = "dev-person" }), Encoding.UTF8, "application/json"));
        var location = JsonDocument.Parse(await made.Content.ReadAsStringAsync()).RootElement.GetProperty("location").GetString()!;
        using var callback = await http.GetAsync(location);
    }

    private static async Task WaitAsync(Func<bool> done) { for (var wait = 0; wait < 200 && !done(); wait++) await Task.Delay(50); }

    [Fact]
    public async Task TheClientReadsAndAnswersOverV1WhilePeerChannelIsOff()
    {
        if (Url is null || Phase != "v1") return;
        var dir = Path.Combine(Path.GetTempPath(), "abx-v1-" + Guid.NewGuid().ToString("N"));
        var account = new LinuxApprovalBoxAccount(Url, new MemoryPassStore());
        await using var client = new LinuxApprovalBoxDevice(account, new OwnerOnlyPeerStorage(dir, "interop", "linux"), () => [("bot-lab", "ラボ")]);
        var states = new List<string>(); client.Source.Changed += () => { lock (states) states.Add(client.Source.State.Status + ":" + client.Source.State.Reason); };
        using var http = new HttpClient();
        using (var config = await http.GetAsync(Url + "/v1/auth/config")) Assert.Contains("\"peer_channel\":false", await config.Content.ReadAsStringAsync());
        client.Attach(new ApprovalsHub(new LinuxWorkspace(origin => new BellApi(origin, new ApprovalsFixture("main"))), client.Source));
        await WaitAsync(() => client.Source.State.Status == ClientStatus.SignedOut);
        Assert.Equal(ClientStatus.SignedOut, client.Source.State.Status);
        await account.SignInAsync("google", CancellationToken.None, uri => Open(http, uri));
        client.Source.Refresh();
        await WaitAsync(() => client.Source.State.Status == ClientStatus.Live);
        output.WriteLine("states: " + string.Join(" > ", states));
        Assert.Equal(ClientStatus.Live, client.Source.State.Status);
        // an AI of the same account files one request through a connection token (two steps: check_token)
        var pass = account.PassHeader()!;
        async Task<JsonElement> Post(string path, object body, string authorization)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, Url + path) { Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json") };
            request.Headers.TryAddWithoutValidation("authorization", authorization);
            using var reply = await http.SendAsync(request); return JsonDocument.Parse(await reply.Content.ReadAsStringAsync()).RootElement.Clone();
        }
        var token = (await Post("/v1/tokens", new { label = "lab AI" }, pass)).GetProperty("token").GetString()!;
        var ask = new Dictionary<string, object> { ["title"] = "決裁箱をv1で確かめる", ["options"] = new[] { new { id = "ok", label = "はい" }, new { id = "no", label = "いいえ" } }, ["session_label"] = "ラボ / v1の確認", ["client"] = "claude-code", ["requester"] = "ラボ" };
        var first = await Post("/connector/v1/decisions", ask, "Bearer " + token);
        ask["check_token"] = (first.TryGetProperty("check_token", out var c) ? c.GetString() : first.GetProperty("error").GetProperty("check_token").GetString())!;
        var filed = await Post("/connector/v1/decisions", ask, "Bearer " + token);
        var id = filed.TryGetProperty("decision_id", out var d) ? d.GetString()! : filed.GetProperty("id").GetString()!;
        await WaitAsync(() => client.Source.Decisions.Any(item => item.Id == id));
        var seen = client.Source.Decisions.First(item => item.Id == id);
        Assert.Equal("pending", seen.Status); Assert.Equal("bellteam", seen.Origin!.Kind); Assert.Equal("name", seen.Origin.Basis);   // the requester "ラボ" is a roster name: rule 2
        Assert.IsType<AnswerResult.Accepted>(await client.Source.AnswerAsync(id, "ok", null, seen.Version));
        await WaitAsync(() => client.Source.Decisions.First(item => item.Id == id).Status == "answered");
        Assert.Equal("ok", client.Source.Decisions.First(item => item.Id == id).Answer!.OptionId);
        try { Directory.Delete(dir, true); } catch (IOException) { }
    }
}
