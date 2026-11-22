using System.IO;
using System.Text;
using System.Text.Json;
using BellTeam.PeerChannel;

namespace BellTeam.Tests;

// vectors/pc1.json (byte encodings, key ids, fingerprints) and vectors/pc1-signed.json (snapshot, frame input, binding tag), contract 3.1, 4.1, 5.3, 8.1.
public class PeerChannelVectorTests
{
    private static byte[] H(string hex) => Convert.FromHexString(hex);
    private static string X(byte[] bytes) => Convert.ToHexStringLower(bytes);
    private static JsonElement Fixture(string name) => JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "peer-channel", name))).RootElement;

    [Fact]
    public void EncodingsMatchEveryCase()
    {
        var f = Fixture("pc1.json");
        foreach (var c in f.GetProperty("lp").EnumerateArray()) Assert.Equal(c.GetProperty("out").GetString(), X(Bytes.Lp(H(c.GetProperty("in").GetString()!))));
        foreach (var c in f.GetProperty("u64").EnumerateArray()) Assert.Equal(c.GetProperty("out").GetString(), X(Bytes.U64(ulong.Parse(c.GetProperty("in").GetString()!))));
        foreach (var c in f.GetProperty("b64url").EnumerateArray())
        {
            var bytes = H(c.GetProperty("in").GetString()!); var text = c.GetProperty("out").GetString()!;
            Assert.Equal(text, Bytes.B64Url(bytes));
            Assert.Equal(bytes, Bytes.FromB64Url(text));
        }
        foreach (var c in f.GetProperty("join").EnumerateArray()) Assert.Equal(c.GetProperty("out").GetString(), X(Bytes.Join(c.GetProperty("in").EnumerateArray().Select(x => H(x.GetString()!)).ToArray())));
        Assert.Throws<FormatException>(() => Bytes.FromB64Url("a+b/"));
        Assert.Throws<FormatException>(() => Bytes.FromB64Url("abcde"));
    }

    [Fact]
    public void KeyIdsFingerprintsAndPrivateKeysMatch()
    {
        foreach (var k in Fixture("pc1.json").GetProperty("keys").EnumerateArray())
        {
            var sigPub = H(k.GetProperty("sig_pub").GetString()!); var sealPub = H(k.GetProperty("seal_pub").GetString()!);
            Assert.Equal(k.GetProperty("key_id").GetString(), X(Keys.KeyId(sigPub)));
            Assert.Equal(k.GetProperty("fingerprint").GetString(), X(Keys.Fingerprint(sigPub, sealPub)));
            using var key = Keys.FromScalar(H(k.GetProperty("sig_priv").GetString()!), sigPub);
            Assert.True(Keys.Verify(sigPub, Keys.Sign(key, "pc1-test", [1, 2]), "pc1-test", [1, 2]));
        }
    }

    [Fact]
    public void SnapshotFrameInputAndBindingTagOfTheVectorsVerify()
    {
        var signed = Fixture("pc1-signed.json"); var signer = Fixture("pc1.json").GetProperty("keys")[0]; var sigPub = H(signer.GetProperty("sig_pub").GetString()!);
        var s = signed.GetProperty("snapshot");
        var snapshot = new SignedSnapshot(Encoding.UTF8.GetBytes(s.GetProperty("body_utf8").GetString()!), Bytes.FromB64Url(s.GetProperty("signer_b64url").GetString()!), H(s.GetProperty("sig").GetString()!));
        Assert.Equal(s.GetProperty("hash").GetString(), X(snapshot.Hash()));
        Assert.Equal(signed.GetProperty("signer_key_id").GetString(), X(snapshot.Signer));
        Assert.True(snapshot.Verify(sigPub));
        Assert.False((snapshot with { Body = [.. snapshot.Body, 0x20] }).Verify(sigPub));
        using var own = Keys.FromScalar(H(signer.GetProperty("sig_priv").GetString()!), sigPub);
        Assert.True(SignedSnapshot.Sign(snapshot.Body, own, snapshot.Signer).Verify(sigPub));

        var f = signed.GetProperty("frame");
        Assert.True(Keys.Verify(sigPub, H(f.GetProperty("sig").GetString()!), "pc1-frame", Bytes.Utf8(f.GetProperty("t").GetString()!), H(f.GetProperty("sid").GetString()!), Encoding.UTF8.GetBytes(f.GetProperty("body_utf8").GetString()!)));

        var b = signed.GetProperty("binding"); var secret = H(b.GetProperty("secret").GetString()!); var nonce = H(b.GetProperty("nonce").GetString()!); var payload = Encoding.UTF8.GetBytes(b.GetProperty("payload_utf8").GetString()!);
        Assert.Equal(b.GetProperty("tag").GetString(), X(Binding.Tag(secret, b.GetProperty("direction").GetString()!, nonce, payload)));
        Assert.True(Binding.Check(secret, "starter", nonce, payload, H(b.GetProperty("tag").GetString()!)));
        Assert.False(Binding.Check(secret, "approver", nonce, payload, H(b.GetProperty("tag").GetString()!)));
    }
}
