using System.Text.RegularExpressions;

namespace BellTeam.PeerChannel;

// Admission wire forms of contract 5.3 / 5.4 (0.5.1 rows 1 and 2, 0.5.3): typed code, verify id, safety number, QR text.
public abstract record AdmissionQr(byte[] Fingerprint, byte[] Secret)
{
    public sealed record Verify(string VerifyId, byte[] Fingerprint, byte[] Secret) : AdmissionQr(Fingerprint, Secret);
    // An empty pairing code re-binds an already-paired connection (0.5.3).
    public sealed record Pair(string PairingCode, byte[] Fingerprint, byte[] Secret) : AdmissionQr(Fingerprint, Secret);
}

public static partial class Admission
{
    private const string Crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

    // The typed code: the 80-bit secret itself as 16 Crockford base32 characters in groups of four.
    public static string TypedCode(byte[] secret)
    {
        if (secret.Length != 10) throw new ArgumentException("a typed secret is 10 bytes");
        var bits = secret.Aggregate(System.Numerics.BigInteger.Zero, (all, b) => (all << 8) | b);
        var text = string.Concat(Enumerable.Range(0, 16).Select(i => Crockford[(int)((bits >> ((15 - i) * 5)) & 31)]));
        return string.Join('-', Enumerable.Range(0, 4).Select(i => text.Substring(i * 4, 4)));
    }

    // Case, spaces and hyphens ignored; O reads as 0, I and L as 1. Null unless exactly 16 valid characters.
    public static byte[]? ParseTypedCode(string input)
    {
        var text = new string(input.ToUpperInvariant().Where(c => !char.IsWhiteSpace(c) && c != '-').ToArray()).Replace('O', '0').Replace('I', '1').Replace('L', '1');
        if (text.Length != 16) return null;
        var bits = System.Numerics.BigInteger.Zero;
        foreach (var c in text)
        {
            var value = Crockford.IndexOf(c);
            if (value < 0) return null;
            bits = (bits << 5) | value;
        }
        return Enumerable.Range(0, 10).Select(i => (byte)((bits >> ((9 - i) * 8)) & 0xff)).ToArray();
    }

    // verify_id = base64url(first 16 bytes of SHA-256(LP("pc1-verify-id") || LP(secret))), for the QR secret and the typed one alike.
    public static string VerifyId(byte[] secret) => Bytes.B64Url(Keys.Sha256(Bytes.Join("pc1-verify-id", secret))[..16]);

    // Six digits: the first four bytes of SHA-256(LP("pc1-safety") || LP(fingerprint)) as a big-endian integer, modulo 10^6.
    public static string SafetyNumber(byte[] fingerprint) =>
        (System.Buffers.Binary.BinaryPrimitives.ReadUInt32BigEndian(Keys.Sha256(Bytes.Join("pc1-safety", fingerprint))) % 1_000_000).ToString("D6");

    public static string QrText(AdmissionQr qr)
    {
        if (qr.Fingerprint.Length != 32 || qr.Secret.Length != 16) throw new ArgumentException("fingerprint 32 bytes, secret 16 bytes");
        var head = qr is AdmissionQr.Verify verify ? "PC1VERIFY:" + verify.VerifyId : "PC1PAIR:" + ((AdmissionQr.Pair)qr).PairingCode;
        return head + ":" + Bytes.B64Url(qr.Fingerprint) + ":" + Bytes.B64Url(qr.Secret);
    }

    [GeneratedRegex("^(PC1VERIFY|PC1PAIR):([A-Za-z0-9_-]*):([A-Za-z0-9_-]{43}):([A-Za-z0-9_-]{22})$")]
    private static partial Regex QrShape();

    [GeneratedRegex("^[A-Za-z0-9_-]{22}$")]
    private static partial Regex VerifyIdShape();

    // Anything else (an https link included) is null, so nothing else is ever acted on.
    public static AdmissionQr? ParseQrText(string text)
    {
        var m = QrShape().Match(text);
        if (!m.Success || (m.Groups[1].Value == "PC1VERIFY" && m.Groups[2].Value.Length == 0)) return null;
        var fingerprint = Bytes.FromB64Url(m.Groups[3].Value); var secret = Bytes.FromB64Url(m.Groups[4].Value);
        if (m.Groups[1].Value == "PC1VERIFY") return VerifyIdShape().IsMatch(m.Groups[2].Value) ? new AdmissionQr.Verify(m.Groups[2].Value, fingerprint, secret) : null;
        return new AdmissionQr.Pair(m.Groups[2].Value, fingerprint, secret);
    }
}
