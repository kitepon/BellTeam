using System.IO;
using System.Text;
using System.Text.Json;
using BellTeam.PeerChannel;

namespace BellTeam.Tests;

// vectors/pc1-admission.json (contract 5.3, 5.4, 0.5.1): typed code, forgiving input, verify id, safety number, binding tags, QR texts.
public class PeerChannelAdmissionTests
{
    private static byte[] H(string hex) => Convert.FromHexString(hex);
    private static string X(byte[] bytes) => Convert.ToHexStringLower(bytes);
    private static readonly JsonElement F = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "peer-channel", "pc1-admission.json"))).RootElement;
    private static string S(JsonElement e, string name) => e.GetProperty(name).GetString()!;

    [Fact]
    public void TypedCodesRoundTripAndForgivingInputReadsTheSameSecret()
    {
        foreach (var c in F.GetProperty("typed_code").EnumerateArray())
        {
            Assert.Equal(S(c, "code"), Admission.TypedCode(H(S(c, "secret"))));
            Assert.Equal(S(c, "secret"), X(Admission.ParseTypedCode(S(c, "code"))!));
        }
        foreach (var c in F.GetProperty("typed_code_forgiving").EnumerateArray()) Assert.Equal(S(c, "secret"), X(Admission.ParseTypedCode(S(c, "input"))!));
        Assert.Null(Admission.ParseTypedCode("0000-0000-0000-000"));
        Assert.Null(Admission.ParseTypedCode("0000-0000-0000-000U"));
    }

    [Fact]
    public void VerifyIdsAndSafetyNumbersMatch()
    {
        foreach (var c in F.GetProperty("verify_id").EnumerateArray()) Assert.Equal(S(c, "verify_id"), Admission.VerifyId(H(S(c, "secret"))));
        foreach (var c in F.GetProperty("safety_number").EnumerateArray()) Assert.Equal(S(c, "digits"), Admission.SafetyNumber(H(S(c, "fingerprint"))));
    }

    [Fact]
    public void BindingTagsMatchBothDirections()
    {
        foreach (var c in F.GetProperty("tags").EnumerateArray())
        {
            var payload = Encoding.UTF8.GetBytes(S(c, "payload_utf8"));
            // The approver's tag covers LP(join) || LP(admit).
            if (c.TryGetProperty("join_utf8", out var join)) payload = Bytes.Join(Encoding.UTF8.GetBytes(join.GetString()!), payload);
            Assert.Equal(S(c, "tag"), X(Binding.Tag(H(S(c, "secret")), S(c, "dir"), H(S(c, "nonce")), payload)));
        }
    }

    [Fact]
    public void QrTextsBuildParseAndRefuseWhatIsNotOurs()
    {
        foreach (var c in F.GetProperty("qr").EnumerateArray())
        {
            var fingerprint = H(S(c, "fingerprint")); var secret = H(S(c, "secret"));
            AdmissionQr qr = S(c, "kind") == "verify" ? new AdmissionQr.Verify(S(c, "verify_id"), fingerprint, secret) : new AdmissionQr.Pair(S(c, "pairing_code"), fingerprint, secret);
            Assert.Equal(S(c, "text"), Admission.QrText(qr));
            var back = Admission.ParseQrText(S(c, "text"))!;
            Assert.Equal(qr.GetType(), back.GetType());
            Assert.Equal(secret, back.Secret);
        }
        Assert.Null(Admission.ParseQrText("https://example.com/PC1VERIFY:a:b:c"));
        Assert.Null(Admission.ParseQrText("PC1VERIFY::" + new string('A', 43) + ":" + new string('A', 22)));
        Assert.IsType<AdmissionQr.Pair>(Admission.ParseQrText("PC1PAIR::" + new string('A', 43) + ":" + new string('A', 22)));
    }
}
