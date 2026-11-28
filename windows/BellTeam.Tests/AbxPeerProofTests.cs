using System.IO;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using BellTeam.App;
using Kitepon.ApprovalBox.Client;

namespace BellTeam.Tests;

// abx-peer-proof-windows: the peer path of Kitepon.ApprovalBox.Client 0.5.4 as BellTeam Windows builds it (DpapiPeerStorage, the shipped datachannel.dll, ClientApprovalSource),
// against the Approval Box dev server with peer_channel on (approval-box docs/architecture/peer-channel-adoption.md section 8) and the lab control server windows/BellTeam.Tests/e2e/abxpeer-lab.ts
// (the connector side plus the lab phone: pairing, a request with an image, admitting a new device, removing one).
// Run (an approval-box checkout, Node 24, npm ci): `git apply e2e/abxpeer-dev-approve-labRemove.patch` (one lab function, labRemove; not upstream), copy e2e/abxpeer-lab.ts to packages/connector/test/,
// `cd packages/server && DEV_DATA=<dir> PORT=8788 npm run dev:server`, `cd packages/connector && DEV_URL=http://127.0.0.1:8788 DEV_DATA=<dir> LAB_PORT=8799 node test/abxpeer-lab.ts` (fresh data dir and a fresh lab process for every run: pairing is once), then this test.
// PC_E2E_ABX_PEER_URL = the dev server (http://127.0.0.1:8788), PC_E2E_ABX_PEER_LAB = the lab control server (http://127.0.0.1:8799), PC_E2E_ABX_PEER_LOG = optional step log file.
// The sign-in is the dev server's fake one (a pass of the same person the lab phone uses); the child join is not part of this proof. Without the variables this test does nothing (xunit 2.9 cannot skip at run time).
public class AbxPeerProofTests
{
    private static readonly byte[] Png = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6ioAAAAASUVORK5CYII=");

    [Fact]
    public async Task ThePeerPathPairsAnswersHoldsAdmitsAndLosesARemovedDevice()
    {
        var url = Environment.GetEnvironmentVariable("PC_E2E_ABX_PEER_URL"); var lab = Environment.GetEnvironmentVariable("PC_E2E_ABX_PEER_LAB");
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

        // The same person as the lab phone: the dev server's fake sign-in (section 8) gives a pass.
        async Task<string> SignIn()
        {
            var nonce = (await (await http.PostAsJsonAsync(url + "/auth/v1/signin/nonce", new { })).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("nonce").GetString()!;
            var idToken = (await (await http.PostAsJsonAsync(url + "/dev/id-token", new { provider = "apple", nonce, sub = "dev-person" })).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id_token").GetString()!;
            var signed = await (await http.PostAsJsonAsync(url + "/auth/v1/signin", new { provider = "apple", idToken, nonce })).Content.ReadFromJsonAsync<JsonElement>();
            return "Bearer " + signed.GetProperty("pass").GetString()!;
        }
        var pass = await SignIn();

        var dir = Path.Combine(Path.GetTempPath(), "bt-peerproof-" + Guid.NewGuid().ToString("N"));
        var storage = new DpapiPeerStorage(dir, "bt-proof-" + Environment.MachineName);
        var client = new ApprovalBoxClient(new ApprovalBoxClientOptions { BaseUri = new Uri(url), PassProvider = (_, _) => ValueTask.FromResult<string?>(pass), Peer = storage });
        await using var source = new ClientApprovalSource(client);
        try
        {
            // 1. pairing (the connector's, approved by the lab phone): the account now holds a registry this device cannot verify.
            var paired = await Lab("/pair"); Log("1 pairing: connector " + paired.GetProperty("connection_id").GetString() + " paired and approved by the lab phone");

            // 2. this device: the package reads the selector (peer_channel true), finds the registry it cannot verify and asks to be admitted.
            await client.StartAsync();
            await WaitFor("NeedsApproval", () => client.State.Status == ClientStatus.NeedsApproval);
            Log("2 start: state NeedsApproval (reason " + client.State.Reason + ", note " + client.State.Note + ")");
            client.RequestApproval();
            await WaitFor("Waiting with an offer", () => client.State.Status == ClientStatus.Waiting && client.State.Offer is not null);
            var offer = client.State.Offer!; Log("2 request approval: Waiting, offer code length " + offer.Code.Length + ", QR payload " + offer.QrPayload.Split(':')[0]);

            // 3. second-device verify: the lab phone (a verified device) checks the offer and admits this device.
            // The device opens its verify ids on the signal socket a moment after it shows the offer; the lab phone says unknown_verify until then, so it is asked again (each attempt is logged).
            JsonElement admitted = default; var attempts = 0;
            while (true)
            {
                attempts++;
                using var r = await http.PostAsJsonAsync(lab + "/admit", new { text = offer.QrPayload }); var body = await r.Content.ReadAsStringAsync();
                if (r.IsSuccessStatusCode) { admitted = JsonDocument.Parse(body).RootElement.Clone(); break; }
                Log("3 admit attempt " + attempts + ": " + body); Assert.True(body.Contains("unknown_verify") && attempts < 40, body); await Task.Delay(250);
            }
            Log("3 admit succeeded on attempt " + attempts);
            var keyId = admitted.GetProperty("key_id").GetString()!;
            Log("3 admit: the lab phone admitted platform " + admitted.GetProperty("platform").GetString() + ", registry version " + admitted.GetProperty("registry_version").GetInt32());
            await WaitFor("Live", () => client.State.Status == ClientStatus.Live);
            Log("3 state Live");

            // 4. a request with an image from the connector reaches this device over the data channel, picture included.
            var filed = await Lab("/request", new { title = "peer proof", context = "windows", options = new[] { new { id = "go", label = "go" }, new { id = "wait", label = "wait" } }, images = new[] { new { name = "p.png", type = "image/png", data = Convert.ToBase64String(Png) } } });
            var id = filed.GetProperty("decision_id").GetString()!;
            await WaitFor("the decision", () => client.Decisions.Open.Any(d => d.Id == id));
            var d = client.Decisions.Open.Single(x => x.Id == id);
            Assert.Equal("pending", d.Status); Assert.Single(d.RequestAttachments);
            var bytes = await client.AttachmentAsync(id, d.RequestAttachments[0].Id);
            Assert.Equal(Png, bytes);
            Log("4 request: arrived with title '" + d.Title + "', 1 image of " + bytes!.Length + " bytes read back equal");

            // 5. hold, unhold: the connector sees the status each time.
            Assert.IsType<AnswerResult.Accepted>(await client.HoldAsync(id));
            await WaitFor("held at the connector", () => Lab("/decision", new { id }).GetAwaiter().GetResult().GetProperty("status").GetString() == "held");
            Log("5 hold: connector status held");
            Assert.IsType<AnswerResult.Accepted>(await client.UnholdAsync(id));
            await WaitFor("pending at the connector", () => Lab("/decision", new { id }).GetAwaiter().GetResult().GetProperty("status").GetString() == "pending");
            Log("5 unhold: connector status pending");

            // 6. answer: the connector holds the answer for its seat.
            d = client.Decisions.Open.Single(x => x.Id == id);
            Assert.IsType<AnswerResult.Accepted>(await client.AnswerAsync(id, "go", null, d.Version));
            await WaitFor("answered at the connector", () => Lab("/decision", new { id }).GetAwaiter().GetResult().GetProperty("status").GetString() == "answered");
            var answered = await Lab("/decision", new { id });
            Assert.Equal("go", answered.GetProperty("answer").GetProperty("option_id").GetString());
            Log("6 answer: connector status answered, option go");

            // 7. removal of the running device: the lab phone signs the registry without it; the running client must leave Live and say so.
            var removed = await Lab("/remove", new { key_id = keyId });
            Log("7 remove: the lab phone signed registry version " + removed.GetProperty("registry_version").GetInt32() + " without this device");
            // client-component 4.1 T4: a running device finds a removal only when its endpoint (re)starts (start() or retryNow()), never by a push. Wait a while to show it stays Live, then ask it to reconnect (the screen's 今すぐ試す).
            var until = DateTime.UtcNow.AddSeconds(Math.Max(1, int.Parse(Environment.GetEnvironmentVariable("PC_E2E_ABX_PEER_PUSH_WAIT") ?? "20")));
            while (client.State.Status != ClientStatus.NeedsApproval && DateTime.UtcNow < until) await Task.Delay(250);
            Log("7 " + (client.State.Status == ClientStatus.NeedsApproval ? "the running device noticed the removal by itself" : "no push in the wait (as T4 says): still " + client.State.Status) + " (note " + client.State.Note + ")");
            if (client.State.Status != ClientStatus.NeedsApproval) { client.RetryNow(); await WaitFor("NeedsApproval after RetryNow", () => client.State.Status == ClientStatus.NeedsApproval, 30); Log("7 after RetryNow: " + client.State.Status + ", note " + client.State.Note); }
            Assert.Equal("device_removed", client.State.Note);
        }
        finally { await client.DisposeAsync(); try { Directory.Delete(dir, true); } catch { } }
    }
}
