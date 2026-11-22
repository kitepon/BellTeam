using System.IO;
using System.Text;
using System.Text.Json;
using BellTeam.PeerChannel;

namespace BellTeam.Tests;

// vectors/pc1-frames.json (contract 8.1, 0.4.5): the frame signature, the exact frame text, the request hash, chunking and the drop cases.
public class PeerChannelFrameTests
{
    private static byte[] H(string hex) => Convert.FromHexString(hex);
    private static JsonElement Fixture(string name) => JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "peer-channel", name))).RootElement;
    private static string S(JsonElement e, string name) => e.GetProperty(name).GetString()!;

    [Fact]
    public void FrameOfTheVectorVerifiesSerializesToTheSameTextAndHashesTheBody()
    {
        var f = Fixture("pc1-frames.json").GetProperty("frame"); var signer = Fixture("pc1.json").GetProperty("keys")[0]; var sigPub = H(S(signer, "sig_pub"));
        var frame = new Frame(S(f, "t"), Encoding.UTF8.GetBytes(S(f, "body_utf8")), H(S(f, "sig")));
        Assert.True(frame.Verify(H(S(f, "sid")), sigPub));
        Assert.False(frame.Verify(H("bb".PadRight(32, 'b')), sigPub));
        Assert.Equal(S(f, "text_utf8"), Encoding.UTF8.GetString(frame.Serialize()));
        Assert.Equal(S(f, "request_hash"), Convert.ToHexStringLower(Frame.RequestHash(frame.B)));
        var parsed = Chunk.ParseFrame(Encoding.UTF8.GetBytes(S(f, "text_utf8")))!;
        Assert.Equal(frame.T, parsed.T); Assert.Equal(frame.B, parsed.B); Assert.Equal(frame.S, parsed.S);
        using var own = Keys.FromScalar(H(S(signer, "sig_priv")), sigPub);
        Assert.True(Frame.Sign(own, "answer", H(S(f, "sid")), [1, 2, 3]).Verify(H(S(f, "sid")), sigPub));
        Assert.Null(Chunk.ParseFrame(Encoding.UTF8.GetBytes("{\"t\":1,\"b\":\"\",\"s\":\"\"}")));
        Assert.Null(Chunk.ParseFrame(Encoding.UTF8.GetBytes("not json")));
    }

    [Fact]
    public void ChunksMatchReassembleAndTheDropCasesDrop()
    {
        var c = Fixture("pc1-frames.json").GetProperty("chunking"); var text = Encoding.UTF8.GetBytes(S(Fixture("pc1-frames.json").GetProperty("frame"), "text_utf8"));
        var messages = c.GetProperty("messages").EnumerateArray().Select(m => m.GetString()!).ToArray();
        Assert.Equal(messages, Chunk.ToMessages(text, H(S(c, "mid"))).Select(Encoding.UTF8.GetString).ToArray());
        Assert.Single(Chunk.ToMessages(new byte[16384], new byte[16]));

        Chunk Read(string json) { var j = JsonDocument.Parse(json).RootElement; return new Chunk(S(j, "mid"), j.GetProperty("seq").GetInt64(), j.GetProperty("last").GetBoolean(), S(j, "d")); }
        var now = DateTimeOffset.UnixEpoch; var reassembler = new Reassembler(); byte[]? whole = null; var outcome = Reassembler.Outcome.Incomplete;
        foreach (var m in messages) outcome = reassembler.Accept(Read(m), now, out whole);
        Assert.Equal(Reassembler.Outcome.Complete, outcome); Assert.Equal(text, whole);

        foreach (var drop in c.GetProperty("drop_cases").EnumerateArray())
        {
            var r = new Reassembler(); var seen = new List<Reassembler.Outcome>();
            foreach (var index in drop.GetProperty("order").EnumerateArray()) seen.Add(r.Accept(Read(messages[index.GetInt32()]), now, out _));
            Assert.Contains(Reassembler.Outcome.Dropped, seen);
            Assert.DoesNotContain(Reassembler.Outcome.Complete, seen);
        }
        var late = new Reassembler(); late.Accept(Read(messages[0]), now, out _);
        Assert.Equal(Reassembler.Outcome.Dropped, late.Accept(Read(messages[1]), now + TimeSpan.FromSeconds(31), out _));
    }
}
