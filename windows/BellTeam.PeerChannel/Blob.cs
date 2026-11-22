using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text.Json;

namespace BellTeam.PeerChannel;

// Blobs of contract 8.2 / 8.7 and the 0.5.2 ordering rule: binary data-channel messages, each a 40-byte header (32-byte blob_id = SHA-256 of the whole blob,
// then the offset as unsigned 64-bit big-endian) and at most 16 KiB of data, sent after the signed frame that names them, in its blobs[] order, offsets consecutive from 0.
public sealed record BlobMeta(string BlobId, long Size, string ContentType, string Name)
{
    public const int Piece = 16 * 1024, MaxCount = 10;
    public const long MaxEach = 20L * 1024 * 1024, MaxTotal = 50L * 1024 * 1024;
    public static readonly TimeSpan CompleteWithin = TimeSpan.FromSeconds(60);

    public static BlobMeta Of(byte[] bytes, string contentType, string name) => new(Bytes.B64Url(Keys.Sha256(bytes)), bytes.Length, contentType, name);

    // A frame body's blobs[] if it is well formed and within 8.7, else null (the frame is refused invalid).
    public static IReadOnlyList<BlobMeta>? CheckList(JsonElement list)
    {
        if (list.ValueKind != JsonValueKind.Array || list.GetArrayLength() > MaxCount) return null;
        long total = 0; var seen = new HashSet<string>(); var metas = new List<BlobMeta>();
        foreach (var m in list.EnumerateArray())
        {
            if (m.ValueKind != JsonValueKind.Object || Text(m, "blob_id") is not { } id || Text(m, "content_type") is not { } type || Text(m, "name") is not { } name
                || !m.TryGetProperty("size", out var size) || !size.TryGetInt64(out var bytes) || bytes < 0 || bytes > MaxEach || !seen.Add(id)) return null;
            try { if (Bytes.FromB64Url(id).Length != 32) return null; } catch (FormatException) { return null; }
            total += bytes;
            metas.Add(new BlobMeta(id, bytes, type, name));
        }
        return total > MaxTotal ? null : metas;
    }

    private static string? Text(JsonElement e, string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    // The binary messages that carry one blob; an empty blob is one header-only message.
    public static IReadOnlyList<byte[]> Messages(byte[] bytes)
    {
        var id = Keys.Sha256(bytes); var output = new List<byte[]>(); var at = 0;
        do
        {
            var header = new byte[40];
            id.CopyTo(header, 0);
            BinaryPrimitives.WriteUInt64BigEndian(header.AsSpan(32), (ulong)at);
            output.Add([.. header, .. bytes[at..Math.Min(bytes.Length, at + Piece)]]);
            at += Piece;
        } while (at < bytes.Length);
        return output;
    }
}

// Assembles the blobs a verified frame named. A message for a blob nobody named, a gap or a repeat in the offsets, more bytes than the size,
// or a SHA-256 that does not match the blob_id drops that blob (null result with Dropped); its frame then fails invalid.
public sealed class BlobReceiver
{
    private readonly Dictionary<string, (BlobMeta Meta, List<byte[]> Parts, long Got, DateTimeOffset Since)> wanted = [];
    public enum Outcome { Incomplete, Dropped, Complete }

    public void Expect(IEnumerable<BlobMeta> metas, DateTimeOffset now)
    {
        foreach (var meta in metas) wanted.TryAdd(Convert.ToHexStringLower(Bytes.FromB64Url(meta.BlobId)), (meta, [], 0, now));
    }

    public Outcome Accept(byte[] message, out string? blobId, out byte[]? bytes)
    {
        blobId = null; bytes = null;
        if (message.Length < 40) return Outcome.Dropped;
        var id = message[..32]; var offset = BinaryPrimitives.ReadUInt64BigEndian(message.AsSpan(32, 8)); var key = Convert.ToHexStringLower(id);
        if (!wanted.TryGetValue(key, out var w)) return Outcome.Dropped;
        var data = message[40..];
        if (offset != (ulong)w.Got || data.Length > BlobMeta.Piece || w.Got + data.Length > w.Meta.Size) { wanted.Remove(key); return Outcome.Dropped; }
        w.Parts.Add(data);
        w = (w.Meta, w.Parts, w.Got + data.Length, w.Since);
        wanted[key] = w;
        if (w.Got < w.Meta.Size) return Outcome.Incomplete;
        wanted.Remove(key);
        var whole = w.Parts.SelectMany(p => p).ToArray();
        if (!CryptographicOperations.FixedTimeEquals(Keys.Sha256(whole), id)) return Outcome.Dropped;
        blobId = w.Meta.BlobId; bytes = whole;
        return Outcome.Complete;
    }

    // Blobs past their 60 s; they are forgotten here.
    public IReadOnlyList<string> Expired(DateTimeOffset now)
    {
        var gone = wanted.Where(p => now - p.Value.Since > BlobMeta.CompleteWithin).ToList();
        foreach (var p in gone) wanted.Remove(p.Key);
        return gone.Select(p => p.Value.Meta.BlobId).ToList();
    }

    public void Forget(string blobId) => wanted.Remove(Convert.ToHexStringLower(Bytes.FromB64Url(blobId)));
}
