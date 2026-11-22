using System.Security.Cryptography;
using System.Text;

namespace BellTeam.PeerChannel;

// RFC 9180 mode_base for the one pc1 suite (contract 3.1): DHKEM(P-256, HKDF-SHA256) 0x0010, HKDF-SHA256 0x0001, AES-256-GCM 0x0002.
// Built on .NET primitives only (ECDiffieHellman, HKDF, AesGcm); no other suite, mode, PSK or auth exists here (Nayuta's ruling, subject to Airi's acceptance).
public sealed class HpkeContext
{
    private const int Nk = 32, Nn = 12, Nh = 32;
    private readonly byte[] key, baseNonce, exporterSecret;
    private ulong sequence;

    internal HpkeContext(byte[] shared, byte[] info)
    {
        var context = Hpke.Cat([0], Hpke.Extract(Hpke.Suite, [], "psk_id_hash", []), Hpke.Extract(Hpke.Suite, [], "info_hash", info));
        var secret = Hpke.Extract(Hpke.Suite, shared, "secret", []);
        key = Hpke.Expand(Hpke.Suite, secret, "key", context, Nk);
        baseNonce = Hpke.Expand(Hpke.Suite, secret, "base_nonce", context, Nn);
        exporterSecret = Hpke.Expand(Hpke.Suite, secret, "exp", context, Nh);
    }

    private byte[] Nonce()
    {
        var nonce = (byte[])baseNonce.Clone();
        for (var i = 0; i < 8; i++) nonce[Nn - 1 - i] ^= (byte)(sequence >> (8 * i));
        return nonce;
    }

    // Sender side: the ciphertext is the encrypted text with the 16-byte tag appended.
    public byte[] Seal(byte[] aad, byte[] plaintext)
    {
        var output = new byte[plaintext.Length + 16];
        using var aes = new AesGcm(key, 16);
        aes.Encrypt(Nonce(), plaintext, output.AsSpan(0, plaintext.Length), output.AsSpan(plaintext.Length), aad);
        sequence++;
        return output;
    }

    // Throws CryptographicException for a changed ciphertext, aad or position; the sequence moves only on success.
    public byte[] Open(byte[] aad, byte[] ciphertext)
    {
        if (ciphertext.Length < 16) throw new CryptographicException("ciphertext shorter than the tag");
        var plain = new byte[ciphertext.Length - 16];
        using var aes = new AesGcm(key, 16);
        aes.Decrypt(Nonce(), ciphertext.AsSpan(0, plain.Length), ciphertext.AsSpan(plain.Length), plain, aad);
        sequence++;
        return plain;
    }

    public byte[] Export(byte[] exporterContext, int length) => Hpke.Expand(Hpke.Suite, exporterSecret, "sec", exporterContext, length);
}

public static class Hpke
{
    private static readonly byte[] KemSuite = Cat(Ascii("KEM"), I2(0x0010));
    internal static readonly byte[] Suite = Cat(Ascii("HPKE"), I2(0x0010), I2(0x0001), I2(0x0002));

    internal static byte[] Cat(params byte[][] parts) => parts.SelectMany(part => part).ToArray();
    private static byte[] I2(int value) => [(byte)(value >> 8), (byte)value];
    private static byte[] Ascii(string text) => Encoding.ASCII.GetBytes(text);

    internal static byte[] Extract(byte[] suite, byte[] salt, string label, byte[] ikm) =>
        HKDF.Extract(HashAlgorithmName.SHA256, Cat(Ascii("HPKE-v1"), suite, Ascii(label), ikm), salt);

    internal static byte[] Expand(byte[] suite, byte[] prk, string label, byte[] info, int length) =>
        HKDF.Expand(HashAlgorithmName.SHA256, prk, length, Cat(I2(length), Ascii("HPKE-v1"), suite, Ascii(label), info));

    internal static byte[] KemExtract(string label, byte[] ikm) => Extract(KemSuite, [], label, ikm);
    internal static byte[] KemExpand(byte[] prk, string label, byte[] info, int length) => Expand(KemSuite, prk, label, info, length);

    private static ECDiffieHellman Key(byte[] point, byte[]? scalar = null)
    {
        if (point.Length != 65 || point[0] != 4) throw new ArgumentException("a P-256 public key is the 65-byte uncompressed point");
        return ECDiffieHellman.Create(new ECParameters { Curve = ECCurve.NamedCurves.nistP256, D = scalar, Q = new ECPoint { X = point[1..33], Y = point[33..65] } });
    }

    // DHKEM shared secret: the ECDH x-coordinate, then ExtractAndExpand over enc || pkRm.
    private static byte[] SharedSecret(ECDiffieHellman own, byte[] other, byte[] enc, byte[] pkRm)
    {
        using var peer = Key(other);
        var dh = own.DeriveRawSecretAgreement(peer.PublicKey);
        return KemExpand(KemExtract("eae_prk", dh), "shared_secret", Cat(enc, pkRm), 32);
    }

    // The public point of a private scalar (known-answer tests only).
    internal static byte[] PublicPoint(byte[] scalar)
    {
        using var key = ECDiffieHellman.Create(new ECParameters { Curve = ECCurve.NamedCurves.nistP256, D = scalar });
        var p = key.ExportParameters(false);
        return [4, .. p.Q.X!, .. p.Q.Y!];
    }

    // The fresh sender context for pkRm: enc goes to the recipient, the context seals.
    public static (byte[] Enc, HpkeContext Context) SetupBaseS(byte[] pkRm, byte[] info)
    {
        using var ephemeral = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256);
        var p = ephemeral.ExportParameters(false);
        return Sender(pkRm, info, ephemeral, [4, .. p.Q.X!, .. p.Q.Y!]);
    }

    // The same with a fixed ephemeral key, for the RFC 9180 known answers only.
    internal static (byte[] Enc, HpkeContext Context) SetupBaseS(byte[] pkRm, byte[] info, byte[] skE, byte[] pkEm)
    {
        using var ephemeral = Key(pkEm, skE);
        return Sender(pkRm, info, ephemeral, pkEm);
    }

    private static (byte[], HpkeContext) Sender(byte[] pkRm, byte[] info, ECDiffieHellman ephemeral, byte[] enc) =>
        (enc, new HpkeContext(SharedSecret(ephemeral, pkRm, enc, pkRm), info));

    // skR is the 32-byte private scalar; pkRm its 65-byte point.
    public static HpkeContext SetupBaseR(byte[] enc, byte[] skR, byte[] pkRm, byte[] info)
    {
        using var recipient = Key(pkRm, skR);
        return new HpkeContext(SharedSecret(recipient, enc, enc, pkRm), info);
    }

    // Single-shot, empty AAD (contract 3.1).
    public static (byte[] Enc, byte[] Ciphertext) Seal(byte[] pkRm, byte[] info, byte[] plaintext)
    {
        var (enc, context) = SetupBaseS(pkRm, info);
        return (enc, context.Seal([], plaintext));
    }

    public static byte[] Open(byte[] skR, byte[] pkRm, byte[] enc, byte[] info, byte[] ciphertext) =>
        SetupBaseR(enc, skR, pkRm, info).Open([], ciphertext);
}
