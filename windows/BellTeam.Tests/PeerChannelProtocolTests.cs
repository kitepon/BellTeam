using System.IO;
using System.Text;
using System.Text.Json;
using BellTeam.PeerChannel;

namespace BellTeam.Tests;

// vectors/pc1-ts.json (snapshots, HPKE info, envelopes, frames, chunks, registry frame, ack, answer and result checks) and vectors/pc1-hold-blob.json (hold frame, blob messages): contract 6.4, 8.1-8.3, 0.5.2.
public class PeerChannelProtocolTests
{
    private static byte[] H(string hex) => Convert.FromHexString(hex);
    private static string X(byte[] bytes) => Convert.ToHexStringLower(bytes);
    private static JsonElement Fixture(string name) => JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "peer-channel", name))).RootElement;
    private static string S(JsonElement e, string name) => e.GetProperty(name).GetString()!;
    private static byte[] U(JsonElement e, string name) => Encoding.UTF8.GetBytes(S(e, name));
    private static readonly JsonElement Pc1 = Fixture("pc1.json");
    private static JsonElement Named(string name) => Pc1.GetProperty("keys")[name == "a" ? 0 : 1];

    private sealed class Receiver(JsonElement me, string? sender, IEnumerable<ulong> used, long now) : IEnvelopeReceiver
    {
        private readonly HashSet<ulong> usedSeqs = used.ToHashSet();
        public byte[] Me => H(S(me, "key_id")); public byte[] SealPrivate => H(S(me, "seal_priv")); public byte[] SealPublic => H(S(me, "seal_pub")); public long Now => now;
        public byte[]? SenderSigPub(byte[] from) => sender is null ? null : H(S(Named(sender), "sig_pub"));
        public bool SeqUsed(byte[] from, byte[] sid, ulong seq) => usedSeqs.Contains(seq);
        public void RecordSeq(byte[] from, byte[] sid, ulong seq) => usedSeqs.Add(seq);
    }

    private static string Name(EnvelopeDrop drop) => drop switch { EnvelopeDrop.UnknownSender => "unknown_sender", EnvelopeDrop.SeqUsed => "seq_used", EnvelopeDrop.BadSignature => "bad_signature", EnvelopeDrop.NotForMe => "not_for_me", EnvelopeDrop.OpenFailed => "open_failed", EnvelopeDrop.BadPlaintext => "bad_plaintext", _ => "clock_skew" };
    private static string Name(AnswerCode code) => code switch { AnswerCode.NotVerified => "not_verified", AnswerCode.UnknownRequest => "unknown_request", AnswerCode.StaleVersion => "stale_version", AnswerCode.AlreadyDecided => "already_decided", AnswerCode.Replayed => "replayed", AnswerCode.ClockSkew => "clock_skew", _ => "invalid" };
    private static string Name(FrameChecks.ResultCode code) => code switch { FrameChecks.ResultCode.NotVerified => "not_verified", FrameChecks.ResultCode.Invalid => "invalid", _ => "answer_not_verified" };

    [Fact]
    public void SnapshotsHpkeInfoAndEnvelopesOfTheTsVectors()
    {
        var v = Fixture("pc1-ts.json"); var now = v.GetProperty("now_ms").GetInt64();
        foreach (var c in v.GetProperty("snapshot").EnumerateArray())
        {
            var key = Named(S(c, "signer")); var pub = H(S(key, "sig_pub"));
            var snapshot = new SignedSnapshot(U(c, "body_utf8"), H(S(key, "key_id")), H(S(c, "sig")));
            Assert.Equal(S(c, "hash"), X(snapshot.Hash())); Assert.True(snapshot.Verify(pub));
            using var own = Keys.FromScalar(H(S(key, "sig_priv")), pub);
            Assert.True(SignedSnapshot.Sign(snapshot.Body, own, snapshot.Signer).Verify(pub));
        }
        foreach (var c in v.GetProperty("hpke_info91").EnumerateArray())
        {
            var info = H(S(c, "info")); Assert.Equal(91, info.Length);
            var r = Named(S(c, "receiver")); var skE = PeerChannelHpkeTests.DeriveScalar(H(S(c, "ikmE")));
            var (enc, context) = Hpke.SetupBaseS(H(S(r, "seal_pub")), info, skE, Hpke.PublicPoint(skE));
            Assert.Equal(S(c, "enc"), X(enc)); Assert.Equal(S(c, "ct"), X(context.Seal([], H(S(c, "plaintext")))));
            Assert.Equal(S(c, "plaintext"), X(Hpke.Open(H(S(r, "seal_priv")), H(S(r, "seal_pub")), enc, info, H(S(c, "ct")))));
        }
        foreach (var c in v.GetProperty("envelope").EnumerateArray())
        {
            var e = Envelope.FromJson(JsonDocument.Parse($"{{\"from\":\"{Bytes.B64Url(H(S(c, "from")))}\",\"to\":\"{Bytes.B64Url(H(S(c, "to")))}\",\"sid\":\"{Bytes.B64Url(H(S(c, "sid")))}\",\"seq\":{c.GetProperty("seq").GetUInt64()},\"enc\":\"{Bytes.B64Url(H(S(c, "enc")))}\",\"ct\":\"{Bytes.B64Url(H(S(c, "ct")))}\",\"sig\":\"{Bytes.B64Url(H(S(c, "sig")))}\"}}").RootElement);
            if (c.TryGetProperty("ikmE", out var ikm))
            {
                Assert.Equal(S(c, "info"), X(Envelope.Info(e.From, e.To, e.Sid, e.Seq)));
                Assert.Equal(c.GetProperty("padded_len").GetInt32(), Envelope.Pad(S(c, "plaintext_utf8")).Length);
                var sender = Named(S(c, "sender")); var pub = H(S(sender, "sig_pub")); using var key = Keys.FromScalar(H(S(sender, "sig_priv")), pub);
                var mine = Envelope.Seal(key, e.From, e.To, H(S(Named(S(c, "receiver")), "seal_pub")), e.Sid, e.Seq, S(c, "plaintext_utf8"), PeerChannelHpkeTests.DeriveScalar(H(ikm.GetString()!)));
                Assert.Equal(S(c, "enc"), X(mine.Enc)); Assert.Equal(S(c, "ct"), X(mine.Ct));
                Assert.True(mine.VerifySignature(pub));
            }
            var senderName = c.TryGetProperty("sender", out var sn) ? (sn.ValueKind == JsonValueKind.Null ? null : sn.GetString()) : "a";
            var used = c.TryGetProperty("used_seq", out var us) ? us.EnumerateArray().Select(x => x.GetUInt64()) : [];
            var (plain, drop) = EnvelopeOpener.Open(e, new Receiver(Named(S(c, "receiver")), senderName, used, c.TryGetProperty("now_ms", out var nm) ? nm.GetInt64() : now));
            Assert.Equal(S(c, "expect"), drop is { } d ? Name(d) : "ok");
            plain?.Dispose();
        }
    }

    [Fact]
    public void EnvelopesOfEverySealerVerifyAndOpenThroughTheReceiverChecks()
    {
        foreach (var c in Fixture("pc1-envelope.json").GetProperty("cases").EnumerateArray())
        {
            var e = new Envelope(H(S(c, "from")), H(S(c, "to")), H(S(c, "sid")), c.GetProperty("seq").GetUInt64(), H(S(c, "enc")), H(S(c, "ct")), H(S(c, "sig")));
            Assert.True(e.VerifySignature(H(S(Named("a"), "sig_pub"))));
            using var expected = JsonDocument.Parse(S(c, "plaintext_utf8"));
            var (plain, drop) = EnvelopeOpener.Open(e, new Receiver(Named("b"), "a", [], expected.RootElement.GetProperty("ts").GetInt64()));
            Assert.Null(drop); Assert.Equal(expected.RootElement.GetProperty("kind").GetString(), plain!.RootElement.GetProperty("kind").GetString());
            plain.Dispose();
        }
    }

    [Fact]
    public void FramesChunksRegistryFrameAckAndTheChecksOfTheTsVectors()
    {
        var v = Fixture("pc1-ts.json"); var now = v.GetProperty("now_ms").GetInt64();
        foreach (var c in v.GetProperty("frame").EnumerateArray()) Assert.True(new Frame(S(c, "t"), U(c, "body_utf8"), H(S(c, "sig"))).Verify(H(S(c, "sid")), H(S(Named(S(c, "signer")), "sig_pub"))));

        var ch = v.GetProperty("chunk"); var text = U(ch, "frame_utf8");
        var expected = ch.GetProperty("chunks").EnumerateArray().Select(x => new Chunk(S(x, "mid"), x.GetProperty("seq").GetInt64(), x.GetProperty("last").GetBoolean(), S(x, "d"))).ToList();
        Assert.Equal(expected.Select(x => x.Json()), Chunk.ToMessages(text, H(S(ch, "mid"))).Select(Encoding.UTF8.GetString));
        var r = new Reassembler(); byte[]? whole = null;
        foreach (var x in expected) r.Accept(x, DateTimeOffset.FromUnixTimeMilliseconds(now), out whole);
        Assert.Equal(text, whole);
        Assert.True(Chunk.ParseFrame(whole!)!.Verify(H(S(ch, "sid")), H(S(Named(S(ch, "signer")), "sig_pub"))));
        foreach (var d in ch.GetProperty("drops").EnumerateArray())
        {
            var r2 = new Reassembler();
            Assert.Contains(Reassembler.Outcome.Dropped, d.GetProperty("seqs").EnumerateArray().Select(i => r2.Accept(expected[i.GetInt32()], DateTimeOffset.FromUnixTimeMilliseconds(now), out _)).ToList());
        }

        var rf = v.GetProperty("registry_frame"); var rpub = H(S(Named(S(rf, "signer")), "sig_pub"));
        var snapshot = FrameChecks.RegistryFrameSnapshot(new Frame(S(rf, "t"), U(rf, "body_utf8"), H(S(rf, "sig"))), H(S(rf, "sid")), rpub)!;
        Assert.Equal(S(rf, "snapshot_hash"), X(snapshot.Hash())); Assert.True(snapshot.Verify(rpub));

        foreach (var c in v.GetProperty("ack").EnumerateArray())
        {
            Assert.True(new Frame(S(c, "t"), U(c, "body_utf8"), H(S(c, "sig"))).Verify(H(S(c, "sid")), H(S(Named(S(c, "signer")), "sig_pub"))));
            using var body = JsonDocument.Parse(S(c, "body_utf8"));
            Assert.Equal(S(body.RootElement, "result") == "refused:stale_version", body.RootElement.TryGetProperty("current", out _));
        }

        var ac = v.GetProperty("answer_check"); var device = Named(S(ac, "device"));
        foreach (var c in ac.GetProperty("cases").EnumerateArray())
        {
            OutboxRequest? request = null; var seen = new List<string>();
            if (c.GetProperty("request").ValueKind == JsonValueKind.Object)
            {
                var q = c.GetProperty("request"); seen = q.GetProperty("seen").EnumerateArray().Select(x => x.GetString()!).ToList();
                request = new OutboxRequest(S(q, "state") switch { "open" => RequestState.Open, "answered" => RequestState.Answered, "cancelled" => RequestState.Cancelled, _ => RequestState.Expired }, q.GetProperty("rv").GetInt64(), [H(S(q, "request_hash"))]);
            }
            var context = new AnswerContext(H(S(ac, "sid")), H(S(device, "key_id")), H(S(device, "sig_pub")), _ => !c.TryGetProperty("active", out var a) || a.GetBoolean(), seen.Contains, _ => request, now, _ => !c.TryGetProperty("valid", out var ok) || ok.GetBoolean());
            var answer = c.GetProperty("answer");
            var (body, code) = FrameChecks.CheckAnswer(new Frame(S(answer, "t"), U(answer, "body_utf8"), H(S(answer, "sig"))), context);
            Assert.Equal(S(c, "expect"), code is { } k ? Name(k) : "ok");
            body?.Dispose();
        }

        var rc = v.GetProperty("result_check"); var connector = Named(S(rc, "connector")); var a0 = Named("a");
        foreach (var c in rc.GetProperty("cases").EnumerateArray())
        {
            var result = c.GetProperty("result");
            var (body, answer, code) = FrameChecks.CheckResult(new Frame(S(result, "t"), U(result, "body_utf8"), H(S(result, "sig"))), new ResultContext(H(S(rc, "sid")), H(S(connector, "sig_pub")), id => id == Bytes.B64Url(H(S(a0, "key_id"))) ? H(S(a0, "sig_pub")) : null));
            Assert.Equal(S(c, "expect"), code is { } k ? Name(k) : "ok");
            body?.Dispose(); answer?.Dispose();
        }
    }

    [Fact]
    public void HoldFrameAndBlobMessagesOfTheHoldBlobVectors()
    {
        var v = Fixture("pc1-hold-blob.json"); var a = Named("a"); var h = v.GetProperty("hold");
        var frame = new Frame(S(h, "t"), U(h, "body_utf8"), H(S(h, "sig")));
        Assert.True(frame.Verify(H(S(h, "sid")), H(S(a, "sig_pub"))));
        AnswerContext Context(long rv, RequestState state = RequestState.Open, byte[]? sid = null) =>
            new(sid ?? H(S(h, "sid")), H(S(a, "key_id")), H(S(a, "sig_pub")), _ => true, _ => false, _ => new OutboxRequest(state, rv, []), 1700000000000, _ => true);
        var (ok, code) = FrameChecks.CheckHold(frame, Context(2));
        Assert.Null(code); Assert.True(ok!.RootElement.GetProperty("held").GetBoolean());
        Assert.Equal(AnswerCode.StaleVersion, FrameChecks.CheckHold(frame, Context(3)).Code);
        Assert.Equal(AnswerCode.AlreadyDecided, FrameChecks.CheckHold(frame, Context(2, RequestState.Answered)).Code);
        Assert.Equal(AnswerCode.NotVerified, FrameChecks.CheckHold(frame, Context(2, sid: H(new string('b', 32)))).Code);

        var b = v.GetProperty("blob"); var size = b.GetProperty("size").GetInt32();
        var bytes = Enumerable.Range(0, size).Select(i => (byte)(i % 251)).ToArray();
        var messages = BlobMeta.Messages(bytes);
        Assert.Equal(b.GetProperty("messages").EnumerateArray().Select(x => x.GetString()!), messages.Select(X));
        var receiver = new BlobReceiver(); receiver.Expect([new BlobMeta(S(b, "blob_id_b64url"), size, "application/octet-stream", "v")], DateTimeOffset.UnixEpoch);
        byte[]? done = null; var last = BlobReceiver.Outcome.Incomplete;
        foreach (var m in messages) last = receiver.Accept(m, out _, out done);
        Assert.Equal(BlobReceiver.Outcome.Complete, last); Assert.Equal(S(b, "sha256"), X(Keys.Sha256(done!)));

        var bad = new BlobReceiver(); bad.Expect([new BlobMeta(S(b, "blob_id_b64url"), size, "x", "v")], DateTimeOffset.UnixEpoch);
        Assert.Equal(BlobReceiver.Outcome.Dropped, bad.Accept(messages[1], out _, out _)); // a gap in the offsets
        Assert.Equal(BlobReceiver.Outcome.Dropped, new BlobReceiver().Accept(messages[0], out _, out _)); // a blob nobody named
        Assert.Single(BlobMeta.Messages([]));
        using var list = JsonDocument.Parse("[{\"blob_id\":\"" + S(b, "blob_id_b64url") + "\",\"size\":5,\"content_type\":\"a\",\"name\":\"b\"}]");
        Assert.NotNull(BlobMeta.CheckList(list.RootElement));
        using var dup = JsonDocument.Parse("[{\"blob_id\":\"" + S(b, "blob_id_b64url") + "\",\"size\":5,\"content_type\":\"a\",\"name\":\"b\"},{\"blob_id\":\"" + S(b, "blob_id_b64url") + "\",\"size\":5,\"content_type\":\"a\",\"name\":\"b\"}]");
        Assert.Null(BlobMeta.CheckList(dup.RootElement));
    }
}
