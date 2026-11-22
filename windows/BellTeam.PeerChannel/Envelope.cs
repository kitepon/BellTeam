using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace BellTeam.PeerChannel;

// Signaling envelope (contract 6.4): HPKE-sealed to the receiver, ECDSA-signed by the sender. A port of ts/src/envelope.ts.
public sealed record Envelope(byte[] From, byte[] To, byte[] Sid, ulong Seq, byte[] Enc, byte[] Ct, byte[] Sig)
{
    // LP("pc1-signal-info") || LP(from) || LP(to) || LP(sid) || LP(seq): 91 bytes for 16-byte ids.
    public static byte[] Info(byte[] from, byte[] to, byte[] sid, ulong seq) => Bytes.Join("pc1-signal-info", from, to, sid, Bytes.U64(seq));
    private static byte[][] SignedFields(byte[] from, byte[] to, byte[] sid, ulong seq, byte[] enc, byte[] ct) => [from, to, sid, Bytes.U64(seq), enc, ct];

    // The plaintext is padded with spaces to 1024, 2048 or 4096 bytes.
    public static byte[] Pad(string json)
    {
        var bytes = Bytes.Utf8(json);
        var size = new[] { 1024, 2048, 4096 }.Cast<int?>().FirstOrDefault(n => bytes.Length <= n) ?? throw new ArgumentOutOfRangeException(nameof(json), "envelope plaintext over 4096 bytes");
        var output = Enumerable.Repeat((byte)0x20, size).ToArray();
        bytes.CopyTo(output, 0);
        return output;
    }

    public static Envelope Seal(ECDsa senderKey, byte[] senderId, byte[] to, byte[] toSealPub, byte[] sid, ulong seq, string plaintextJson) =>
        Finish(senderKey, senderId, to, sid, seq, Hpke.Seal(toSealPub, Info(senderId, to, sid, seq), Pad(plaintextJson)));

    // The same with a fixed ephemeral key, for the known-answer vectors only.
    internal static Envelope Seal(ECDsa senderKey, byte[] senderId, byte[] to, byte[] toSealPub, byte[] sid, ulong seq, string plaintextJson, byte[] skE)
    {
        var (enc, context) = Hpke.SetupBaseS(toSealPub, Info(senderId, to, sid, seq), skE, Hpke.PublicPoint(skE));
        return Finish(senderKey, senderId, to, sid, seq, (enc, context.Seal([], Pad(plaintextJson))));
    }

    private static Envelope Finish(ECDsa key, byte[] from, byte[] to, byte[] sid, ulong seq, (byte[] Enc, byte[] Ct) box) =>
        new(from, to, sid, seq, box.Enc, box.Ct, Keys.Sign(key, "pc1-signal", SignedFields(from, to, sid, seq, box.Enc, box.Ct)));

    public bool VerifySignature(byte[] sigPub) => Keys.Verify(sigPub, Sig, "pc1-signal", SignedFields(From, To, Sid, Seq, Enc, Ct));

    public string ToJson() => "{\"from\":\"" + Bytes.B64Url(From) + "\",\"to\":\"" + Bytes.B64Url(To) + "\",\"sid\":\"" + Bytes.B64Url(Sid) + "\",\"seq\":" + Seq + ",\"enc\":\"" + Bytes.B64Url(Enc) + "\",\"ct\":\"" + Bytes.B64Url(Ct) + "\",\"sig\":\"" + Bytes.B64Url(Sig) + "\"}";

    public static Envelope FromJson(JsonElement j) => new(Bytes.FromB64Url(j.GetProperty("from").GetString()!), Bytes.FromB64Url(j.GetProperty("to").GetString()!), Bytes.FromB64Url(j.GetProperty("sid").GetString()!),
        j.GetProperty("seq").GetUInt64(), Bytes.FromB64Url(j.GetProperty("enc").GetString()!), Bytes.FromB64Url(j.GetProperty("ct").GetString()!), Bytes.FromB64Url(j.GetProperty("sig").GetString()!));
}

public interface IEnvelopeReceiver
{
    byte[] Me { get; }                                    // own key id
    byte[] SealPrivate { get; }
    byte[] SealPublic { get; }
    byte[]? SenderSigPub(byte[] from);                    // active key in the receiver's registry, else null
    bool SeqUsed(byte[] from, byte[] sid, ulong seq);
    void RecordSeq(byte[] from, byte[] sid, ulong seq);
    long Now { get; }                                     // Unix ms
}

public enum EnvelopeDrop { UnknownSender, SeqUsed, BadSignature, NotForMe, OpenFailed, BadPlaintext, ClockSkew }

public static class EnvelopeOpener
{
    public const long WindowMs = 10 * 60_000;
    private static readonly string[] Kinds = ["offer", "answer", "candidate", "end"];

    // Check order N6: known sender and fresh seq, then signature, record seq, then open, parse, ts.
    public static (JsonDocument? Plaintext, EnvelopeDrop? Drop) Open(Envelope e, IEnvelopeReceiver r)
    {
        if (!e.To.AsSpan().SequenceEqual(r.Me)) return (null, EnvelopeDrop.NotForMe);
        var sigPub = r.SenderSigPub(e.From);
        if (sigPub is null) return (null, EnvelopeDrop.UnknownSender);
        if (r.SeqUsed(e.From, e.Sid, e.Seq)) return (null, EnvelopeDrop.SeqUsed);
        if (!e.VerifySignature(sigPub)) return (null, EnvelopeDrop.BadSignature);
        r.RecordSeq(e.From, e.Sid, e.Seq);
        byte[] plain;
        try { plain = Hpke.Open(r.SealPrivate, r.SealPublic, e.Enc, Envelope.Info(e.From, e.To, e.Sid, e.Seq), e.Ct); }
        catch (CryptographicException) { return (null, EnvelopeDrop.OpenFailed); }
        JsonDocument document;
        try { document = JsonDocument.Parse(new UTF8Encoding(false, true).GetString(plain)); }
        catch (Exception error) when (error is JsonException or ArgumentException) { return (null, EnvelopeDrop.BadPlaintext); }
        var p = document.RootElement;
        if (p.ValueKind != JsonValueKind.Object || !p.TryGetProperty("kind", out var kind) || kind.ValueKind != JsonValueKind.String || !Kinds.Contains(kind.GetString())
            || !p.TryGetProperty("ts", out var ts) || !ts.TryGetDouble(out var stamp)) { document.Dispose(); return (null, EnvelopeDrop.BadPlaintext); }
        if (Math.Abs(r.Now - stamp) > WindowMs) { document.Dispose(); return (null, EnvelopeDrop.ClockSkew); }
        return (document, null);
    }
}
