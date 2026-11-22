using System.Security.Cryptography;

namespace BellTeam.PeerChannel;

// Registry snapshot signed form (contract 4.1). No canonical JSON: the signature and hash cover the body bytes as received.
public sealed record SignedSnapshot(byte[] Body, byte[] Signer, byte[] Sig)
{
    public byte[] Hash() => Keys.Sha256(Body);
    public bool Verify(byte[] sigPub) => Keys.Verify(sigPub, Sig, "pc1-registry", Body);
    public static SignedSnapshot Sign(byte[] body, ECDsa key, byte[] keyId) => new(body, keyId, Keys.Sign(key, "pc1-registry", body));
}

// Binding tag of contract 5.3: HMAC-SHA-256(secret, LP("pc1-verify") || LP(direction) || LP(nonce) || LP(payload)).
public static class Binding
{
    public static byte[] Tag(byte[] secret, string direction, byte[] nonce, byte[] payload) =>
        HMACSHA256.HashData(secret, Bytes.Join("pc1-verify", Bytes.Utf8(direction), nonce, payload));

    public static bool Check(byte[] secret, string direction, byte[] nonce, byte[] payload, byte[] tag) =>
        CryptographicOperations.FixedTimeEquals(tag, Tag(secret, direction, nonce, payload));
}
