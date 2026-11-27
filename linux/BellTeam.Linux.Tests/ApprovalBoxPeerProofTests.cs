using System.Net.Http.Json;
using System.Reflection;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text.Json;
using Kitepon.ApprovalBox.Client;
using Kitepon.LoginBilling.Desktop;

namespace BellTeam.Linux;

// The peer path of the packaged Approval Box client (0.6.1, login-billing 0.25.1) through BellTeam's own device class, against the loopback dev server of kitepon/approval-box
// (abx-peer-proof-linux-android). Mirrors approval-box-apps Tests/ApprovalBoxClientTests/DevServerE2ETests.swift. Runs only with ABX_PEER_URL (dev server), ABX_PEER_CTL (host control API of
// tools/swift-client-e2e-host.ts) and ABX_PEER_PARENT (lab parent, packages/server/test/lab-parent.ts); every line of evidence goes to ABX_PEER_LOG.
// Not covered: the QR join with a real provider token (the child's key is admitted by the lab parent's signed add, as the Swift test does for device B).
[SupportedOSPlatform("linux")]
public sealed class ApprovalBoxPeerProofTests
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(90) };
    private static readonly string? LogPath = Environment.GetEnvironmentVariable("ABX_PEER_LOG");
    private static void Note(string line) { var text = DateTimeOffset.UtcNow.ToOffset(TimeSpan.FromHours(9)).ToString("HH:mm:ss") + " JST " + line; Console.WriteLine(text); if (LogPath is not null) File.AppendAllText(LogPath, text + "\n"); }

    private static async Task<JsonElement> Post(string url, string path, object? body = null)
    {
        var res = await Http.PostAsJsonAsync(url + path, body ?? new { });
        var json = JsonDocument.Parse(await res.Content.ReadAsStringAsync()).RootElement.Clone();
        Assert.True(res.IsSuccessStatusCode, path + " " + (int)res.StatusCode + " " + json);
        return json;
    }
    private static async Task<JsonElement> Get(string url, string path) => JsonDocument.Parse(await Http.GetStringAsync(url + path)).RootElement.Clone();
    private static async Task Until(string what, Func<Task<bool>> done, int seconds = 60)
    {
        var end = DateTime.UtcNow.AddSeconds(seconds);
        while (!await done()) { if (DateTime.UtcNow > end) Assert.Fail("timeout: " + what); await Task.Delay(200); }
        Note("ok: " + what);
    }
    private static Task Until(string what, Func<bool> done, int seconds = 60) => Until(what, () => Task.FromResult(done()), seconds);

    [Fact]
    public async Task AChildJoinedByAParentReadsHoldsAnswersAndIsRemovedOverThePeerPath()
    {
        var dev = Environment.GetEnvironmentVariable("ABX_PEER_URL"); var ctl = Environment.GetEnvironmentVariable("ABX_PEER_CTL"); var parent = Environment.GetEnvironmentVariable("ABX_PEER_PARENT");
        if (dev is null || ctl is null || parent is null) return;   // like the other PC_E2E_* tests: nothing without the rig

        // Parent: a keyholes parent device that starts the entry and is a pc/1 peer device (its registry genesis).
        var started = await Post(parent, "/start");
        Note("parent started entry=" + started.GetProperty("entry").GetString()![..6] + "...");

        // The connector (the real CLI, pair --json) is paired and bound by the parent (a child cannot claim: parent_required).
        await Post(ctl, "/pair");
        JsonElement waiting = default;
        await Until("connector waiting", async () => { var r = await Get(ctl, "/pair"); waiting = r.GetProperty("last"); return waiting.TryGetProperty("state", out var s) && s.GetString() == "waiting"; });
        await Post(parent, "/connector", new { text = waiting.GetProperty("qr_text").GetString(), code = waiting.GetProperty("code").GetString() });
        await Until("connector bound", async () => (await Get(ctl, "/pair")).GetProperty("last").GetProperty("state").GetString() == "bound");
        await Post(ctl, "/daemon");
        Note("connector daemon running");

        // The child: BellTeam's own device class (LinuxApprovalBoxDevice, the production ChildJoin options and peer storage), its device key seeded and admitted by the parent's signed add.
        var dir = Path.Combine(Path.GetTempPath(), "abx-peer-proof-" + Guid.NewGuid().ToString("N"));
        var state = Path.Combine(dir, "approval-box-child"); Directory.CreateDirectory(state);
        var keys = new DeviceKeys(new FileDeviceKeyStore(Path.Combine(state, "device-key")));
        await keys.ForAccountAsync("google", "lab-" + Guid.NewGuid().ToString("N"), () => Task.CompletedTask, default);
        var childKey = keys.Pub ?? throw new InvalidOperationException("no child key");
        var addJson = (await Post(parent, "/add", new { child_pub = childKey })).GetProperty("add");
        var add = new Add(addJson.GetProperty("key").GetString()!, addJson.GetProperty("role").GetString()!, addJson.GetProperty("issued").GetInt64(), addJson.GetProperty("signer").GetString()!, addJson.GetProperty("s").GetString()!);
        await new KeyholeClient(new Uri(dev + "/v1/"), "dev.kitepon.approvalbox", keys, null).SendAddAsync(add, default);
        File.WriteAllBytes(Path.Combine(state, "joined"), []);
        Note("child key admitted by the parent (keys/accept), joined marker written");

        await using var device = new LinuxApprovalBoxDevice(LinuxApprovalBoxDevice.ChildJoin(dir), LinuxApprovalBoxDevice.LinuxHasEngine ? new OwnerOnlyPeerStorage(dir, "neon-lab", "linux") : null, () => [], new Uri(dev));
        var source = device.Source;
        Assert.Equal(JoinPhase.Joined, source.Join!.Phase);
        var client = (ApprovalBoxClient)typeof(LinuxApprovalBoxDevice).GetField("client", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(device)!;
        _ = client.StartAsync();

        // 5.3: the child's registry slot is admitted by the parent's peer device from the child's offer.
        await Until("child needs approval", () => source.State.Status == ClientStatus.NeedsApproval);
        client.RequestApproval();
        await Until("child waiting with an offer", () => source.State.Status == ClientStatus.Waiting && source.State.Offer is not null);
        // The offer's verify id is opened on the signal socket a moment after the code shows; a parent that scans too early is told verify_unknown_verify and scans again.
        string childPeerKey;
        for (var attempt = 0; ; attempt++)
        {
            var res = await Http.PostAsJsonAsync(parent + "/admit", new { text = source.State.Offer!.QrPayload });
            var body = await res.Content.ReadAsStringAsync();
            if (res.IsSuccessStatusCode) { Note("parent admitted the child's offer: " + body); childPeerKey = JsonDocument.Parse(body).RootElement.GetProperty("key_id").GetString()!; break; }
            Assert.True(attempt < 20 && body.Contains("verify_unknown_verify"), "admit " + (int)res.StatusCode + " " + body);
            await Task.Delay(500);
        }
        await Until("child live", () => source.State.Status == ClientStatus.Live);
        Note("adapter=" + client.Adapter);
        Note("registry as the parent sees it: " + (await Get(parent, "/registry")));
        Assert.Equal("peer", client.Adapter);

        // A request with an image, filed by the real connector, over /pc/v1 only.
        var filed = await Post(ctl, "/request", new { title = "peer-proof-1", image = true });
        var id = filed.GetProperty("decision_id").GetString()!; var sentSha = filed.GetProperty("image_sha256").GetString()!;
        await Until("request on the child", () => source.Decisions.Any(d => d.Id == id));
        var decision = source.Decisions.First(d => d.Id == id);
        var attachment = Assert.Single(decision.RequestAttachments!);
        var bytes = await source.AttachmentAsync(id, attachment.Id!);
        var gotSha = Convert.ToHexStringLower(SHA256.HashData(bytes!));
        Note("image sha256 sent=" + sentSha + " received=" + gotSha + " bytes=" + bytes!.Length);
        Assert.Equal(sentSha, gotSha);
        Assert.Equal("peer", client.Adapter);

        Assert.IsType<AnswerResult.Accepted>(await source.HoldAsync(id, true));
        await Until("held at the connector", async () => (await Get(ctl, "/decision/" + id)).GetProperty("status").GetString() == "held");
        Assert.IsType<AnswerResult.Accepted>(await source.HoldAsync(id, false));
        await Until("pending at the connector", async () => (await Get(ctl, "/decision/" + id)).GetProperty("status").GetString() == "pending");
        Assert.IsType<AnswerResult.Accepted>(await source.AnswerAsync(id, "ok", "yes", source.Decisions.First(d => d.Id == id).Version));
        await Until("answered at the connector", async () => (await Get(ctl, "/decision/" + id)).GetProperty("status").GetString() == "answered");
        Assert.Equal("peer", client.Adapter);

        // Removal of the running child by the parent, both ways a parent does it: first its peer device removes the child from the registry (the child reads device_removed), then the parent
        // removes the child's keyhole (keys/others: the library's removed event ends the child's key; its /pc/v1 socket closes 4401).
        await Post(parent, "/remove-device", new { key_id = childPeerKey });
        Note("parent's peer device removed the child from the registry");
        await Until("child reads device_removed", () => { source.Refresh(); return source.State.Status == ClientStatus.NeedsApproval && source.State.Note == "device_removed"; }, 60);
        Note("child state=" + source.State.Status + "/" + source.State.Note + " join=" + source.Join!.Phase);
        await Post(parent, "/remove-others");
        Note("parent removed the child's keyhole (keys/others)");
        await Until("child removed", () => { source.Refresh(); return source.Join!.Phase == JoinPhase.NotJoined && source.Join.Removed && source.State.Status == ClientStatus.SignedOut; }, 90);
        Note("child state=" + source.State.Status + "/" + source.State.Reason + " join=" + source.Join!.Phase + " removed=" + source.Join.Removed + " adapter=" + (client.Adapter ?? "none"));
        Assert.Equal("not_signed_in", source.State.Reason);
        Assert.NotEqual("v1", client.Adapter);
    }
}
