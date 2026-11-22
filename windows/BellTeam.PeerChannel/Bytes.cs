using System.Buffers.Binary;
using System.Buffers.Text;
using System.Text;

namespace BellTeam.PeerChannel;

// Byte encodings of contract 3.1: LP, u64 big-endian, base64url without padding. Every signed, tagged or hashed input is built from these.
public static class Bytes
{
    public static byte[] Utf8(string text) => Encoding.UTF8.GetBytes(text);

    public static byte[] Lp(byte[] bytes)
    {
        var output = new byte[4 + bytes.Length];
        BinaryPrimitives.WriteUInt32BigEndian(output, (uint)bytes.Length);
        bytes.CopyTo(output, 4);
        return output;
    }

    // LP(a) || LP(b) || ...: every field joined with its length.
    public static byte[] Join(params byte[][] fields) => fields.SelectMany(Lp).ToArray();
    public static byte[] Join(string label, params byte[][] fields) => Join([Utf8(label), .. fields]);

    public static byte[] U64(ulong value)
    {
        var output = new byte[8];
        BinaryPrimitives.WriteUInt64BigEndian(output, value);
        return output;
    }

    public static string B64Url(byte[] bytes) => Base64Url.EncodeToString(bytes);

    public static byte[] FromB64Url(string text)
    {
        if (!text.All(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-') || text.Length % 4 == 1) throw new FormatException("not base64url");
        return Base64Url.DecodeFromChars(text);
    }
}
