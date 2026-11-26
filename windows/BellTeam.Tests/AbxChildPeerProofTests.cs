using System.IO;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using BellTeam.App;
using Kitepon.ApprovalBox.Client;
using Kitepon.LoginBilling.Desktop;

namespace BellTeam.Tests;

// abx-peer-proof-windows, the keyhole-child part (Nayuta 2026-11-26): the packaged client 0.5.4 as BellTeam's window runs it, a CHILD of a keyholes parent (docs/client-component.md 9), on the peer path only.
// Lab: windows/BellTeam.Tests/e2e/abxchild-lab.ts (see AbxPeerProofTests for the Approval Box checkout and the dev server). The lab parent A starts a new entry (keys/start), makes the registry, pairs and approves the connector,
// signs the lbk1 add for this child, admits the child's peer offer and removes it. The child is PRE-SEEDED: its key is made here (Windows CNG, a name of its own, never BellTeam's real child key), it sends the add (keys/accept) and
// the "joined" marker is written. The real join (a provider sign-in and the parent's LAN reply) is NOT run here (covered by the production join on 2026-11-24). The form is ours (ChildJoinOptions.Form) over the same Desktop library the shipped form uses.
// PC_E2E_ABX_PEER_URL = the dev server, PC_E2E_ABX_CHILD_LAB = the lab control server (http://127.0.0.1:8798), PC_E2E_ABX_PEER_LOG = optional step log. Without them this test does nothing.
public class AbxChildPeerProofTests
{
    private static readonly byte[] Png = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6ioAAAAASUVORK5CYII=");
    private const string AppId = "dev.kitepon.approvalbox";

    // The child's own form: keys in Windows CNG under a test-only name, signing through the library's KeyholeClient.
    private sealed class ProofForm : IChildJoinForm
    {
        private readonly DeviceKeys keys; private readonly KeyholeClient keyholes; private readonly string name;
        public ProofForm(Uri baseUri, string keyName) { name = keyName; keys = new DeviceKeys(new CngDeviceKeyStore(keyName)); keyholes = new KeyholeClient(new Uri(baseUri, "/v1/"), AppId, keys); }
        public bool HasKey => keys.Pub is not null;
        public string? Pub => keys.Pub;
        public Task<string> MakeKeyAsync() => keys.ForAccountAsync("apple", "proof-child-" + Guid.NewGuid().ToString("N"), () => Task.CompletedTask, default);
        public Task AcceptAddAsync(Add add) => keyholes.SendAddAsync(add, default);
        public string? Header(string method, Uri url, byte[] body) => keyholes.Header(method, url, body);
        public void UseServerTime(long nowMs) => keyholes.UseServerTime(nowMs);
        public Task<IChildJoinRequest> MakeRequestAsync(string provider, CancellationToken ct) => throw new ChildJoinException("not_run");
        public async Task LeaveAsync(CancellationToken ct) { try { await keyholes.LeaveAsync(ct); } finally { keys.DeleteKey(); } }
        public void Forget() => keys.DeleteKey();
        public void Delete() { try { keys.DeleteKey(); } catch { } }
    }

    private sealed class Counting(HttpMessageHandler inner, List<string> paths) : DelegatingHandler(inner)
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) { lock (paths) paths.Add(request.Method + " " + request.RequestUri!.AbsolutePath); return base.SendAsync(request, ct); }
    }

    [Fact]
    public async Task AKeyholeChildOnThePeerPathPairsAnswersHoldsAndLosesItsKeyholeWhenTheParentRemovesIt()
    {
        var url = Environment.GetEnvironmentVariable("PC_E2E_ABX_PEER_URL"); var lab = Environment.GetEnvironmentVariable("PC_E2E_ABX_CHILD_LAB");
        if (url is null || lab is null) return;
        var logFile = Environment.GetEnvironmentVariable("PC_E2E_ABX_PEER_LOG");
        void Log(string line) { var s = DateTime.Now.ToString("HH:mm:ss.fff") + " " + line; Console.WriteLine(s); if (logFile is not null) File.AppendAllText(logFile, s + "\n"); }
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(90) };
        async Task<JsonElement> Lab(string path, object? body = null)
        {
            using var r = await http.PostAsJsonAsync(lab + path, body ?? new { });
            var text = await r.Content.ReadAsStringAsync();
            Assert.True(r.IsSuccessStatusCode, path + " -> " + text);
            return JsonDocument.Parse(text).RootElement.Clone();
        }
        async Task WaitFor(string what, Func<bool> done, int seconds = 60)
        {
            var until = DateTime.UtcNow.AddSeconds(seconds);
            while (!done()) { Assert.True(DateTime.UtcNow < until, "timed out waiting for " + what); await Task.Delay(100); }
        }

        var dir = Path.Combine(Path.GetTempPath(), "bt-childproof-" + Guid.NewGuid().ToString("N"));
        var stateDir = Path.Combine(dir, "approval-box-child"); Directory.CreateDirectory(stateDir);
        var form = new ProofForm(new Uri(url), "bt-proof-child-" + Guid.NewGuid().ToString("N"));
        var paths = new List<string>();
        ApprovalBoxClient? client = null;
        try
        {
            // a. join, pre-seeded: lab parent A starts its entry (keys/start), makes the registry, pairs and approves the connector; this child makes its key, sends A's lbk1 add (keys/accept), the marker is written.
            var started = await Lab("/start"); Log("a lab parent A: entry " + started.GetProperty("entry").GetString() + ", registry made, connector " + started.GetProperty("connection_id").GetString() + " paired and approved by A");
            var pub = await form.MakeKeyAsync(); Log("a child key made in Windows CNG (public " + pub[..8] + "...)");
            var add = await Lab("/add", new { pub });
            await form.AcceptAddAsync(new Add(add.GetProperty("key").GetString()!, add.GetProperty("role").GetString()!, add.GetProperty("issued").GetInt64(), add.GetProperty("signer").GetString()!, add.GetProperty("s").GetString()!));
            File.WriteAllBytes(Path.Combine(stateDir, "joined"), []);
            var storage = new DpapiPeerStorage(dir, "bt-childproof-" + Environment.MachineName);
            client = new ApprovalBoxClient(new ApprovalBoxClientOptions { BaseUri = new Uri(url), Join = new ChildJoinOptions { StateDirectory = stateDir, Form = form }, Peer = storage, Transport = new Counting(new HttpClientHandler(), paths) });
            await using var source = new ClientApprovalSource(client);
            Assert.Equal(JoinStatus.Joined, client.JoinState.Status); Log("a join state Joined (marker + key); the real QR join with a provider sign-in is not run here");

            // b. peer path: start -> NeedsApproval -> RequestApproval -> Waiting -> A's peer device admits the offer -> Live.
            await client.StartAsync();
            await WaitFor("NeedsApproval", () => client.State.Status == ClientStatus.NeedsApproval);
            Log("b start: NeedsApproval (reason " + client.State.Reason + ")");
            client.RequestApproval();
            await WaitFor("Waiting with an offer", () => client.State.Status == ClientStatus.Waiting && client.State.Offer is not null);
            var offer = client.State.Offer!; Log("b request approval: Waiting, QR payload " + offer.QrPayload.Split(':')[0]);
            JsonElement admitted = default; var attempts = 0;
            while (true)
            {
                attempts++;
                using var r = await http.PostAsJsonAsync(lab + "/admit", new { text = offer.QrPayload }); var body = await r.Content.ReadAsStringAsync();
                if (r.IsSuccessStatusCode) { admitted = JsonDocument.Parse(body).RootElement.Clone(); break; }
                Log("b admit attempt " + attempts + ": " + body); Assert.True(body.Contains("unknown_verify") && attempts < 40, body); await Task.Delay(250);
            }
            var keyId = admitted.GetProperty("key_id").GetString()!;
            Log("b admit by the keyholes parent succeeded on attempt " + attempts + " (platform " + admitted.GetProperty("platform").GetString() + ", registry v" + admitted.GetProperty("registry_version").GetInt32() + ")");
            await WaitFor("Live", () => client.State.Status == ClientStatus.Live); Log("b state Live");

            var filed = await Lab("/request", new { title = "child peer proof", context = "windows", options = new[] { new { id = "go", label = "go" }, new { id = "wait", label = "wait" } }, images = new[] { new { name = "p.png", type = "image/png", data = Convert.ToBase64String(Png) } } });
            var id = filed.GetProperty("decision_id").GetString()!;
            await WaitFor("the decision", () => client.Decisions.Open.Any(d => d.Id == id));
            var d = client.Decisions.Open.Single(x => x.Id == id);
            Assert.Single(d.RequestAttachments);
            var bytes = await client.AttachmentAsync(id, d.RequestAttachments[0].Id);
            Assert.Equal(Png, bytes); Log("b request over /pc/v1: arrived, 1 image of " + bytes!.Length + " bytes read back equal");
            Assert.IsType<AnswerResult.Accepted>(await client.HoldAsync(id));
            await WaitFor("held at the connector", () => Lab("/decision", new { id }).GetAwaiter().GetResult().GetProperty("status").GetString() == "held"); Log("b hold: connector status held");
            Assert.IsType<AnswerResult.Accepted>(await client.UnholdAsync(id));
            await WaitFor("pending at the connector", () => Lab("/decision", new { id }).GetAwaiter().GetResult().GetProperty("status").GetString() == "pending"); Log("b unhold: connector status pending");
            d = client.Decisions.Open.Single(x => x.Id == id);
            Assert.IsType<AnswerResult.Accepted>(await client.AnswerAsync(id, "go", null, d.Version));
            await WaitFor("answered at the connector", () => Lab("/decision", new { id }).GetAwaiter().GetResult().GetProperty("status").GetString() == "answered");
            Assert.Equal("go", (await Lab("/decision", new { id })).GetProperty("answer").GetProperty("option_id").GetString()); Log("b answer: the filer received option go");
            string[] seen; lock (paths) seen = [.. paths.Select(p => p.Split(' ')[1]).Distinct().Order()];
            Log("b paths this child called through the package (distinct): " + string.Join(", ", seen));
            Assert.DoesNotContain(seen, p => p.StartsWith("/v1/decisions") || p.StartsWith("/v1/events") || p.StartsWith("/v1/connections"));   // no /v1 read: the peer path only

            // c. removal: A removes the child from the registry and its keyhole (keys/others); the child must lose both its device and its sign-in.
            var removed = await Lab("/remove", new { key_id = keyId });
            Log("c remove: A signed registry v" + removed.GetProperty("registry_version").GetInt32() + " without the child and removed " + removed.GetProperty("keyholes_removed").GetInt32() + " keyhole(s)");
            var until = DateTime.UtcNow.AddSeconds(30);
            while (client.JoinState.Status == JoinStatus.Joined && DateTime.UtcNow < until) await Task.Delay(250);
            Log("c after up to 30 s without a call: join " + client.JoinState.Status + " (" + client.JoinState.Reason + "), state " + client.State.Status + " (" + client.State.Reason + ")");
            if (client.JoinState.Status == JoinStatus.Joined) { client.RetryNow(); await WaitFor("NotJoined after RetryNow", () => client.JoinState.Status != JoinStatus.Joined, 30); Log("c after RetryNow: join " + client.JoinState.Status + " (" + client.JoinState.Reason + "), state " + client.State.Status + " (" + client.State.Reason + ")"); }
            Assert.Equal(JoinStatus.NotJoined, client.JoinState.Status); Assert.Equal("removed", client.JoinState.Reason);
            await WaitFor("SignedOut", () => client.State.Status == ClientStatus.SignedOut, 15); Log("c final: join NotJoined(removed), state SignedOut (" + client.State.Reason + ")");
            Assert.False(File.Exists(Path.Combine(stateDir, "joined"))); Assert.False(form.HasKey);
        }
        finally { if (client is not null) await client.DisposeAsync(); form.Delete(); try { Directory.Delete(dir, true); } catch { } }
    }
}
