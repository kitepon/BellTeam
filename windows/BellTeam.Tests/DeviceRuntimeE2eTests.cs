using System.IO;
using System.Net.Http;
using System.Text.Json;
using BellTeam.PeerChannel;

namespace BellTeam.Tests;

// DeviceRuntime against the TS connector and signaling server of peer-channel (ts/harness-rt.mjs writes the file PC_E2E_RUNTIME_FILE names; start it first, see windows/native/README.md).
// Without the variable this test does nothing (xunit 2.9 cannot skip at run time).
public class DeviceRuntimeE2eTests
{
    private static byte[] H(JsonElement e, string name) => Convert.FromHexString(e.GetProperty(name).GetString()!);

    [Fact]
    public async Task TheRuntimeReceivesHoldsAndAnswersADecisionOfTheTsConnector()
    {
        var path = Environment.GetEnvironmentVariable("PC_E2E_RUNTIME_FILE");
        if (path is null) return;
        var v = JsonDocument.Parse(File.ReadAllText(path)).RootElement; var d = v.GetProperty("device");
        var sigPub = H(d, "sig_pub");
        using var sign = Keys.FromScalar(H(d, "sig_priv"), sigPub);
        var me = new DeviceIdentity(sign, sigPub, H(d, "seal_priv"), H(d, "seal_pub"));
        var access = new ServerAccess(new Uri(v.GetProperty("url").GetString()!), new Dictionary<string, string> { ["authorization"] = v.GetProperty("authorization").GetString()! });
        var hash = Bytes.FromB64Url(v.GetProperty("registry_hash").GetString()!);
        var book = new DecisionBook(); var trace = new List<string>();
        async Task<Holder?> Registry(ServerAccess a, CancellationToken ct)
        {
            using var http = new HttpClient();
            var slots = await SignalHttp.FetchMirrorAsync(http, a, ct);
            return slots.Select(s => BellTeam.PeerChannel.Registry.Adopt(s, hash, "acct-win")).FirstOrDefault(h => h is not null);
        }
        await using var runtime = new DeviceRuntime(new(me, "windows runtime e2e", _ => Task.FromResult(access), Registry, book));
        runtime.Trace += trace.Add;
        runtime.Start();
        try
        {
            await Until(() => book.Find(v.GetProperty("rid").GetString()!) is not null, "request in the book", trace);
            var entry = book.FindByDecision("K-E2E001")!;
            Assert.Equal(("runtime e2e", DecisionStatus.Pending, RuntimeStatus.Live), (entry.Title, entry.Status, runtime.State.Status));
            Assert.Equal("ok", (await runtime.HoldAsync("K-E2E001", true)).Ack);
            Assert.Equal(DecisionStatus.Held, book.FindByDecision("K-E2E001")!.Status);
            await Assert.ThrowsAsync<ArgumentException>(() => runtime.AnswerAsync("K-E2E001", "maybe", null));
            Assert.Equal("ok", (await runtime.AnswerAsync("K-E2E001", "yes", "理由")).Ack);
            await Until(() => book.FindByDecision("K-E2E001")!.Status == DecisionStatus.Answered, "result in the book", trace);
            var answered = book.FindByDecision("K-E2E001")!;
            Assert.Equal(("yes", "理由"), (answered.Answer!.OptionId, answered.Answer.Text));
        }
        catch (Exception e) when (e is not Xunit.Sdk.XunitException) { throw new Exception(string.Join(" | ", trace), e); }
    }

    private static async Task Until(Func<bool> done, string what, List<string> trace)
    {
        for (var i = 0; i < 300 && !done(); i++) await Task.Delay(100);
        Assert.True(done(), "timeout: " + what + " | " + string.Join(" | ", trace));
    }
}
