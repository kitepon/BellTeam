using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;

namespace BellTeam.PeerChannel;

public sealed class AdmissionException(string code, string message) : Exception(message) { public string Code { get; } = code; } // binding_failed | binding_expired

// The starter side of contract 5.3 for a device that signed in natively: it shows a typed code and a QR, a verified device of the same account joins and admits it (pc1-join / pc1-admit over verify.* signals),
// and the snapshot that names this device becomes its first trusted registry. A port of ts/src/connector/pairing.ts (5.4) with the device fields of 5.2.
public sealed class DeviceAdmission
{
    public const int BindingMs = 5 * 60_000;
    private readonly DeviceIdentity me; private readonly string platform, protection;
    private readonly byte[] qrSecret = RandomNumberGenerator.GetBytes(16), typedSecret = RandomNumberGenerator.GetBytes(10);
    private readonly long started;

    public DeviceAdmission(DeviceIdentity me, string platform, string protection, long now) { this.me = me; this.platform = platform; this.protection = protection; started = now; }

    private byte[] Fingerprint => Keys.Fingerprint(me.SigPub, me.SealPublic);
    public string TypedCode => Admission.TypedCode(typedSecret);
    public string QrText => Admission.QrText(new AdmissionQr.Verify(Admission.VerifyId(qrSecret), Fingerprint, qrSecret));
    public string SafetyNumber => Admission.SafetyNumber(Fingerprint);
    public DateTimeOffset ExpiresAt => DateTimeOffset.FromUnixTimeMilliseconds(started + BindingMs);

    // Opens the verify ids, waits for an approver, runs join -> admit and returns the admitted snapshot with the holder it makes. Ends by itself at the 5 minutes (binding_expired); nothing is left open.
    public async Task<(SignedSnapshot Snapshot, Holder Holder)> CompleteAsync(ServerAccess server, string account, Func<long>? clock = null, CancellationToken ct = default)
    {
        long Now() => clock?.Invoke() ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var deadline = started + BindingMs;
        var secrets = new Dictionary<string, byte[]> { [Admission.VerifyId(qrSecret)] = qrSecret, [Admission.VerifyId(typedSecret)] = typedSecret };
        await using var socket = await SignalSocket.OpenAsync(server, ct);
        var inbox = Channel.CreateUnbounded<JsonDocument>();
        socket.Message += doc => inbox.Writer.TryWrite(doc);
        socket.Closed += () => inbox.Writer.TryComplete();
        socket.Start();
        async Task<JsonDocument> Next(Func<JsonElement, bool> match)
        {
            while (true)
            {
                var left = deadline - Now();
                if (left <= 0) throw new AdmissionException("binding_expired", "the approver did not finish the binding within 5 minutes");
                using var wait = CancellationTokenSource.CreateLinkedTokenSource(ct); wait.CancelAfter(TimeSpan.FromMilliseconds(left));
                try
                {
                    var doc = await inbox.Reader.ReadAsync(wait.Token);
                    if (match(doc.RootElement)) return doc;
                    doc.Dispose();
                }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested) { throw new AdmissionException("binding_expired", "the approver did not finish the binding within 5 minutes"); }
                catch (ChannelClosedException) { throw new AdmissionException("binding_failed", "the signaling socket closed"); }
            }
        }
        static string? Text(JsonElement e, string name) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

        foreach (var id in secrets.Keys) await socket.SendAsync("{\"type\":\"verify.open\",\"verify_id\":\"" + id + "\"}", ct);
        using var joined = await Next(m => Text(m, "type") == "verify.joined" && Text(m, "verify_id") is { } id && secrets.ContainsKey(id));
        var verifyId = Text(joined.RootElement, "verify_id")!; var peer = Text(joined.RootElement, "peer")!; var secret = secrets[verifyId];
        var nonce = RandomNumberGenerator.GetBytes(16); var nonceText = Bytes.B64Url(nonce);
        var joinPayload = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new
        {
            v = "pc/1", purpose = "join", account_hint = (string?)null, sig_pub = Bytes.B64Url(me.SigPub), seal_pub = Bytes.B64Url(me.SealPublic), platform, protection, nonce = nonceText, expires_at = started + BindingMs,
        }));
        var env = JsonSerializer.Serialize(new { dir = "starter", nonce = nonceText, payload = Bytes.B64Url(joinPayload), tag = Bytes.B64Url(Binding.Tag(secret, "starter", nonce, joinPayload)) });
        await socket.SendAsync("{\"type\":\"signal\",\"verify_id\":\"" + verifyId + "\",\"to\":" + JsonSerializer.Serialize(peer) + ",\"env\":" + env + "}", ct);

        using var reply = await Next(m => Text(m, "type") == "signal" && Text(m, "verify_id") == verifyId && m.TryGetProperty("env", out var e) && Text(e, "dir") == "approver");
        var re = reply.RootElement.GetProperty("env");
        byte[] admitBytes, tag;
        try { admitBytes = Bytes.FromB64Url(Text(re, "payload")!); tag = Bytes.FromB64Url(Text(re, "tag")!); } catch (Exception e) when (e is FormatException or ArgumentNullException or NullReferenceException) { throw new AdmissionException("binding_failed", "the approver's envelope is not base64url"); }
        if (Text(re, "nonce") != nonceText) throw new AdmissionException("binding_failed", "the approver answered another nonce");
        if (!Binding.Check(secret, "approver", nonce, Bytes.Join(joinPayload, admitBytes), tag)) throw new AdmissionException("binding_failed", "the approver's tag does not check"); // covers join and admit
        using var admit = ParseAdmit(admitBytes);
        var a = admit.RootElement;
        if (Text(a, "purpose") != "admit" || Text(a, "join_nonce") != nonceText || Text(a, "account") != account) throw new AdmissionException("binding_failed", "pc1-admit does not answer this join");
        if (!a.TryGetProperty("expires_at", out var exp) || !exp.TryGetInt64(out var expires) || expires <= Now()) throw new AdmissionException("binding_expired", "pc1-admit has expired");
        if (!a.TryGetProperty("registry_version", out var rv) || !rv.TryGetInt64(out var version) || Text(a, "registry_hash") is not { } hashText || Text(a, "approver_key_id") is not { } approverId) throw new AdmissionException("binding_failed", "pc1-admit is incomplete");

        // The approver uploads the snapshot before it answers: the one whose hash it named, signed by it, listing this device (5.2 step 4).
        using var http = new HttpClient();
        for (var tries = 0; ; tries++)
        {
            var slot = (await SignalHttp.FetchMirrorAsync(http, server, ct)).FirstOrDefault(s => Bytes.B64Url(s.Hash()) == hashText);
            if (slot is not null)
            {
                var holder = Registry.Adopt(slot, slot.Hash(), account);
                var body = SnapshotBody.Parse(slot.Body);
                if (holder is null || body is null || body.Version != version || Bytes.B64Url(slot.Signer) != approverId || !holder.Active.ContainsKey(Bytes.B64Url(me.KeyId))) throw new AdmissionException("binding_failed", "the admitted snapshot does not name this device");
                return (slot, holder);
            }
            if (tries >= 5 || Now() >= deadline) throw new AdmissionException("binding_failed", "the admitted snapshot is not in the mirror");
            await Task.Delay(500, ct);
        }
    }

    private static JsonDocument ParseAdmit(byte[] bytes)
    {
        try { return JsonDocument.Parse(new UTF8Encoding(false, true).GetString(bytes)); }
        catch (Exception e) when (e is JsonException or ArgumentException) { throw new AdmissionException("binding_failed", "pc1-admit is not JSON"); }
    }
}
