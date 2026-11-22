using System.Security.Cryptography;

namespace BellTeam.PeerChannel;

// Key ids, fingerprints and P-256 ECDSA with IEEE P1363 signatures (contract 3.1).
public static class Keys
{
    public static byte[] Sha256(byte[] bytes) => SHA256.HashData(bytes);

    // First 16 bytes of SHA-256 over the 65-byte uncompressed signing point.
    public static byte[] KeyId(byte[] sigPub) => Sha256(sigPub)[..16];

    // SHA-256 over LP(signing point) || LP(sealing point).
    public static byte[] Fingerprint(byte[] sigPub, byte[] sealPub) => Sha256(Bytes.Join(sigPub, sealPub));

    private static ECParameters Parameters(byte[] point, byte[]? scalar)
    {
        if (point.Length != 65 || point[0] != 4) throw new ArgumentException("not an uncompressed P-256 point");
        return new ECParameters { Curve = ECCurve.NamedCurves.nistP256, D = scalar, Q = new ECPoint { X = point[1..33], Y = point[33..65] } };
    }

    // ECDSA P-256 / SHA-256 over LP(field) || ..., P1363 (64 bytes).
    public static byte[] Sign(ECDsa key, string label, params byte[][] fields) =>
        key.SignData(Bytes.Join(label, fields), HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);

    public static bool Verify(byte[] sigPub, byte[] signature, string label, params byte[][] fields)
    {
        if (signature.Length != 64) return false;
        try
        {
            using var key = ECDsa.Create(Parameters(sigPub, null));
            return key.VerifyData(Bytes.Join(label, fields), signature, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        }
        catch (Exception error) when (error is CryptographicException or ArgumentException) { return false; }
    }

    // For fixed test keys and for a key the app's OS store gives back.
    public static ECDsa FromScalar(byte[] scalar, byte[] point) => ECDsa.Create(Parameters(point, scalar));
}
