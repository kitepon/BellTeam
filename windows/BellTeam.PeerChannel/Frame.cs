using System.Security.Cryptography;
using System.Text;

namespace BellTeam.PeerChannel;

// A frame of contract 8.1: type, body bytes as sent, signature. The device signs answers and holds; it never edits a body it checks.
public sealed record Frame(string T, byte[] B, byte[] S)
{
    public static readonly string[] Types = ["hello", "registry", "request", "amend", "cancel", "answer", "hold", "result", "ack", "state", "bye"];

    // ECDSA over LP("pc1-frame") || LP(t) || LP(sid) || LP(body bytes).
    public static Frame Sign(ECDsa key, string t, byte[] sid, byte[] body) => new(t, body, Keys.Sign(key, "pc1-frame", Bytes.Utf8(t), sid, body));
    public bool Verify(byte[] sid, byte[] sigPub) => Keys.Verify(sigPub, S, "pc1-frame", Bytes.Utf8(T), sid, B);

    // SHA-256 of the exact request/amend body bytes the person saw.
    public static byte[] RequestHash(byte[] requestBody) => Keys.Sha256(requestBody);

    // The JSON the data channel carries: {"t":...,"b":base64url,"s":base64url}, in this key order.
    public byte[] Serialize() => Bytes.Utf8("{\"t\":" + System.Text.Json.JsonSerializer.Serialize(T) + ",\"b\":\"" + Bytes.B64Url(B) + "\",\"s\":\"" + Bytes.B64Url(S) + "\"}");
}

// Transport chunks of contract 8.1: a serialized frame over 16 KiB travels as {mid, seq, last, d} messages; a smaller one travels as itself.
// Chunks carry no signature; the frame signature covers the reassembled frame.
public sealed record Chunk(string Mid, long Seq, bool Last, string D)
{
    public const int ChunkBytes = 16 * 1024, MaxBodyBytes = 1024 * 1024, MaxFrameBytes = 1_400_000;
    public static readonly TimeSpan Reassembly = TimeSpan.FromSeconds(30);

    public string Json() => "{\"mid\":\"" + Mid + "\",\"seq\":" + Seq + ",\"last\":" + (Last ? "true" : "false") + ",\"d\":\"" + D + "\"}";

    // The frame itself up to 16 KiB, else its chunks (as JSON text, in order).
    public static IReadOnlyList<byte[]> ToMessages(byte[] frame, byte[] mid)
    {
        if (frame.Length <= ChunkBytes) return [frame];
        var messages = new List<byte[]>();
        for (int at = 0, seq = 0; at < frame.Length; at += ChunkBytes, seq++)
            messages.Add(Bytes.Utf8(new Chunk(Bytes.B64Url(mid), seq, at + ChunkBytes >= frame.Length, Bytes.B64Url(frame[at..Math.Min(frame.Length, at + ChunkBytes)])).Json()));
        return messages;
    }

    // Null for anything that is not a frame of at most 1 MiB body.
    public static Frame? ParseFrame(byte[] bytes)
    {
        try
        {
            using var document = System.Text.Json.JsonDocument.Parse(new UTF8Encoding(false, true).GetString(bytes));
            var root = document.RootElement;
            if (root.ValueKind != System.Text.Json.JsonValueKind.Object || !root.TryGetProperty("t", out var t) || !root.TryGetProperty("b", out var b) || !root.TryGetProperty("s", out var s)
                || t.ValueKind != System.Text.Json.JsonValueKind.String || b.ValueKind != System.Text.Json.JsonValueKind.String || s.ValueKind != System.Text.Json.JsonValueKind.String) return null;
            var frame = new Frame(t.GetString()!, Bytes.FromB64Url(b.GetString()!), Bytes.FromB64Url(s.GetString()!));
            return frame.B.Length <= MaxBodyBytes ? frame : null;
        }
        catch (Exception error) when (error is System.Text.Json.JsonException or FormatException or ArgumentException) { return null; }
    }
}

// One per session; dropped with the session. A missing, repeated or out-of-order chunk, an oversize frame or 30 s drops the partial frame.
public sealed class Reassembler
{
    public enum Outcome { Incomplete, Dropped, Complete }
    private (string Mid, long Next, List<byte[]> Parts, int Size, DateTimeOffset Started)? current;

    public Outcome Accept(Chunk chunk, DateTimeOffset now, out byte[]? whole)
    {
        whole = null;
        if (current is { } old && now - old.Started > Chunk.Reassembly) current = null;
        byte[] data;
        try { data = Bytes.FromB64Url(chunk.D); } catch (FormatException) { current = null; return Outcome.Dropped; }
        if (chunk.Seq == 0 && current is null) current = (chunk.Mid, 0, [], 0, now);
        if (current is not { } cur || chunk.Mid != cur.Mid || chunk.Seq != cur.Next || data.Length > Chunk.ChunkBytes || cur.Size + data.Length > Chunk.MaxFrameBytes) { current = null; return Outcome.Dropped; }
        cur.Parts.Add(data);
        current = (cur.Mid, cur.Next + 1, cur.Parts, cur.Size + data.Length, cur.Started);
        if (!chunk.Last) return Outcome.Incomplete;
        current = null;
        whole = cur.Parts.SelectMany(part => part).ToArray();
        return Outcome.Complete;
    }
}
