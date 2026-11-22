using System.IO;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using BellTeam.PeerChannel;

namespace BellTeam.Tests;

// Contract 3.1 / N7 and Nayuta's conditions for the in-house HPKE: RFC 9180 known answers, then every pc1-hpke.json and pc1-envelope.json case (91-byte info, empty AAD).
public class PeerChannelHpkeTests
{
    private static byte[] H(string hex) => Convert.FromHexString(hex);
    private static string X(byte[] bytes) => Convert.ToHexStringLower(bytes);
    private static JsonElement Fixture(string name) => JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "peer-channel", name))).RootElement;

    // RFC 9180 7.1.3 DeriveKeyPair for P-256 (test side only: the product never derives from a seed).
    internal static byte[] DeriveScalar(byte[] ikm)
    {
        var order = BigInteger.Parse("0FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551", System.Globalization.NumberStyles.HexNumber);
        var prk = Hpke.KemExtract("dkp_prk", ikm);
        for (byte counter = 0; ; counter++)
        {
            var candidate = Hpke.KemExpand(prk, "candidate", [counter], 32);
            var scalar = new BigInteger(candidate, isUnsigned: true, isBigEndian: true);
            if (scalar > 0 && scalar < order) return candidate;
        }
    }

    private const string RfcInfo = "4f6465206f6e2061204772656369616e2055726e", RfcIkmE = "a90d3417c3da9cb6c6ae19b4b5dd6cc9529a4cc24efb7ae0ace1f31887a8cd6c", RfcIkmR = "a0ce15d49e28bd47a18a97e147582d814b08cbe00109fed5ec27d1b4e9f6f5e3", RfcPkRm = "04abc7e49a4c6b3566d77d0304addc6ed0e98512ffccf505e6a8e3eb25c685136f853148544876de76c0f2ef99cdc3a05ccf5ded7860c7c021238f9e2073d2356c", RfcEnc = "04c06b4f6bebc7bb495cb797ab753f911aff80aefb86fd8b6fcc35525f3ab5f03e0b21bd31a86c6048af3cb2d98e0d3bf01da5cc4c39ff5370d331a4f1f7d5a4e0";
    private static readonly (string Aad, string Ct, string Pt)[] RfcEncryptions =
    [
        ("436f756e742d30", "58c61a45059d0c5704560e9d88b564a8b63f1364b8d1fcb3c4c6ddc1d291742465e902cd216f8908da49f8f96f", "4265617574792069732074727574682c20747275746820626561757479"),
        ("436f756e742d31", "b4e7c90d1dd62cb563694956eb517ab55d5e7d1f6366a0066c04ababaa444dbaf60a30d7bb7d3e91b969762dee", "4265617574792069732074727574682c20747275746820626561757479"),
        ("436f756e742d32", "65463cc0e5fd16e1650a55fb37d5b6fe6e5ac5b6f6e8c2640cfb0fcd528dc37bc0963b5c53d6238c42d447ddf4", "4265617574792069732074727574682c20747275746820626561757479")
    ];
    private static readonly (string Context, int L, string Value)[] RfcExports =
    [
        ("", 32, "7a4c2b89e1909fb0e3ca42d5040f4c2d8346dc0643d787b8474e804f8f72798e"),
        ("00", 32, "3ca0e7e10b601a32edd2f91c49bac766892c52bde2df01a6126320c6e6eb8af1"),
        ("54657374436f6e74657874", 32, "76c6b4f404990ae362be3efe0d60d9669d87017f9dfe33b8c2ed9fd31d295182")
    ];

    [Fact]
    public void Rfc9180SenderGivesEncEveryCiphertextAndExports()
    {
        var (enc, sender) = Hpke.SetupBaseS(H(RfcPkRm), H(RfcInfo), DeriveScalar(H(RfcIkmE)), H(RfcEnc));
        Assert.Equal(RfcEnc, X(enc));
        foreach (var e in RfcEncryptions) Assert.Equal(e.Ct, X(sender.Seal(H(e.Aad), H(e.Pt))));
        foreach (var x in RfcExports) Assert.Equal(x.Value, X(sender.Export(H(x.Context), x.L)));
    }

    [Fact]
    public void Rfc9180RecipientOpensEveryCiphertextAndRefusesAChangedOne()
    {
        var skR = DeriveScalar(H(RfcIkmR));
        var recipient = Hpke.SetupBaseR(H(RfcEnc), skR, H(RfcPkRm), H(RfcInfo));
        foreach (var e in RfcEncryptions) Assert.Equal(e.Pt, X(recipient.Open(H(e.Aad), H(e.Ct))));
        foreach (var x in RfcExports) Assert.Equal(x.Value, X(recipient.Export(H(x.Context), x.L)));
        var other = Hpke.SetupBaseR(H(RfcEnc), skR, H(RfcPkRm), H(RfcInfo));
        var bad = H(RfcEncryptions[0].Ct); bad[0] ^= 1;
        Assert.ThrowsAny<CryptographicException>(() => other.Open(H(RfcEncryptions[0].Aad), bad));
    }

    [Fact]
    public void Pc1HpkeCasesOpenAndMustFailCasesAreRefused()
    {
        var file = Fixture("pc1-hpke.json");
        foreach (var c in file.GetProperty("cases").EnumerateArray())
        {
            var plain = Hpke.Open(H(c.GetProperty("recipient_priv").GetString()!), H(c.GetProperty("recipient_pub").GetString()!), H(c.GetProperty("enc").GetString()!), H(c.GetProperty("info").GetString()!), H(c.GetProperty("ct").GetString()!));
            Assert.Equal(c.GetProperty("plaintext").GetString(), Encoding.UTF8.GetString(plain));
        }
        foreach (var c in file.GetProperty("must_fail").EnumerateArray())
        {
            Assert.Equal("open_failed", c.GetProperty("error").GetString());
            Assert.ThrowsAny<CryptographicException>(() => Hpke.Open(H(c.GetProperty("recipient_priv").GetString()!), H(c.GetProperty("recipient_pub").GetString()!), H(c.GetProperty("enc").GetString()!), H(c.GetProperty("info").GetString()!), H(c.GetProperty("ct").GetString()!)));
        }
    }

    // 6.4: info = LP("pc1-signal-info") || LP(from) || LP(to) || LP(sid) || LP(u64 seq); the receiver is keys[1] of pc1.json.
    private static byte[] Lp(byte[] bytes) => [.. BitConverter.GetBytes(bytes.Length).Reverse(), .. bytes];
    private static byte[] EnvelopeInfo(JsonElement c) => [.. Lp(Encoding.ASCII.GetBytes("pc1-signal-info")), .. Lp(H(c.GetProperty("from").GetString()!)), .. Lp(H(c.GetProperty("to").GetString()!)), .. Lp(H(c.GetProperty("sid").GetString()!)), .. Lp(BitConverter.GetBytes(c.GetProperty("seq").GetUInt64()).Reverse().ToArray())];

    [Fact]
    public void Pc1EnvelopeCasesFromEverySealerOpen()
    {
        var receiver = Fixture("pc1.json").GetProperty("keys")[1];
        var cases = Fixture("pc1-envelope.json").GetProperty("cases");
        Assert.True(cases.GetArrayLength() >= 3);
        foreach (var c in cases.EnumerateArray())
        {
            var plain = Encoding.UTF8.GetString(Hpke.Open(H(receiver.GetProperty("seal_priv").GetString()!), H(receiver.GetProperty("seal_pub").GetString()!), H(c.GetProperty("enc").GetString()!), EnvelopeInfo(c), H(c.GetProperty("ct").GetString()!)));
            Assert.Equal(c.GetProperty("plaintext_utf8").GetString(), plain.TrimEnd(' '));
        }
    }

    [Fact]
    public void OurSealIsOpenedByOurOpenWithTheSameInfoOnly()
    {
        var receiver = Fixture("pc1.json").GetProperty("keys")[1];
        var skR = H(receiver.GetProperty("seal_priv").GetString()!); var pkR = H(receiver.GetProperty("seal_pub").GetString()!);
        var (enc, ct) = Hpke.Seal(pkR, [1, 2, 3], Encoding.UTF8.GetBytes("hello"));
        Assert.Equal("hello", Encoding.UTF8.GetString(Hpke.Open(skR, pkR, enc, [1, 2, 3], ct)));
        Assert.ThrowsAny<CryptographicException>(() => Hpke.Open(skR, pkR, enc, [1, 2, 4], ct));
    }
}
