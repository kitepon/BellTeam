using System.IO;
using System.Text.Json;
using BellTeam.PeerChannel;

namespace BellTeam.Tests;

// The Windows device against the TS connector and signaling server (peer-channel ts/harness.mjs writes the file PC_E2E_FILE names): join, dial, hello, request, ack, answer, result.
// Without PC_E2E_FILE this test does nothing (xunit 2.9 cannot skip at run time); a run counts only when the harness was started, see windows/native/README.md.
public class PeerChannelE2eTests
{
    private static byte[] H(JsonElement e, string name) => Convert.FromHexString(e.GetProperty(name).GetString()!);

    [Fact]
    public async Task DeviceAnswersARequestOfTheTsConnector()
    {
        var path = Environment.GetEnvironmentVariable("PC_E2E_FILE");
        if (path is null) return;
        var v = JsonDocument.Parse(File.ReadAllText(path)).RootElement; var d = v.GetProperty("device"); var c = v.GetProperty("connector");
        var sigPub = H(d, "sig_pub");
        using var sign = Keys.FromScalar(H(d, "sig_priv"), sigPub);
        var me = new DeviceIdentity(sign, sigPub, H(d, "seal_priv"), H(d, "seal_pub"));
        var access = new ServerAccess(new Uri(v.GetProperty("url").GetString()!), new Dictionary<string, string> { ["authorization"] = v.GetProperty("authorization").GetString()! });
        var peer = new ConnectorPeer(c.GetProperty("key_id").GetString()!, c.GetProperty("sig_pub").GetString()!, c.GetProperty("seal_pub").GetString()!, c.GetProperty("connection_id").GetString()!);
        var trace = new List<string>();
        await using var session = new DeviceSession(access, me, peer, new DeviceHello(2, v.GetProperty("registry_hash").GetString()!, "windows e2e", ["test/decision@1"]));
        session.Trace += trace.Add; session.Error += trace.Add;
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(60));
            await session.OpenAsync(cts.Token);
            var wait = (await session.JoinAsync(cts.Token)).First(w => w.ConnectionId == peer.ConnectionId);
            await session.DialAsync(wait, cts.Token);
            var request = await session.NextAsync("request", TimeSpan.FromSeconds(30));
            Assert.Equal(v.GetProperty("rid").GetString(), request.Body.RootElement.GetProperty("rid").GetString());
            session.Ack("request");
            session.Answer(request, "test/answer@1", "{\"choice\":\"yes\"}");
            var result = await session.NextAsync("result", TimeSpan.FromSeconds(30));
            var (body, answer, code) = session.CheckResult(result);
            Assert.Null(code); Assert.NotNull(body); Assert.NotNull(answer);
        }
        catch (Exception) { throw new Exception(string.Join(" | ", trace)); }
    }
}
