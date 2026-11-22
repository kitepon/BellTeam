using System.IO;
using System.Text;
using System.Text.Json;
using BellTeam.PeerChannel;

namespace BellTeam.Tests;

// vectors/registry-cases.json (Kotlin/TS-built snapshots) and registry-built-swift.json (Swift-built) share one schema: signed snapshots plus cases with expected outcomes (contract 4.1-4.4).
public class PeerChannelRegistryTests
{
    private static JsonElement Fixture(string name) => JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "peer-channel", name))).RootElement;

    [Theory]
    [InlineData("registry-cases.json")]
    [InlineData("registry-built-swift.json")]
    public void EveryCaseEndsWithTheExpectedHolder(string file)
    {
        var v = Fixture(file); var account = v.GetProperty("account").GetString()!;
        var nameOf = v.GetProperty("keys").EnumerateObject().ToDictionary(k => k.Value.GetProperty("key_id").GetString()!, k => k.Name);
        SignedSnapshot Snap(string name) { var s = v.GetProperty("snapshots").GetProperty(name); return new SignedSnapshot(Encoding.UTF8.GetBytes(s.GetProperty("body_utf8").GetString()!), Bytes.FromB64Url(s.GetProperty("signer").GetString()!), Convert.FromHexString(s.GetProperty("sig").GetString()!)); }
        byte[] Hash(string name) => Convert.FromHexString(v.GetProperty("snapshots").GetProperty(name).GetProperty("hash").GetString()!);
        var cases = v.GetProperty("cases").EnumerateArray().ToList();
        Assert.NotEmpty(cases);
        foreach (var c in cases)
        {
            var init = c.GetProperty("init").GetString()!;
            var holder = Registry.Adopt(Snap(init), Hash(init), account);
            Assert.True(holder is not null, c.GetProperty("name").GetString() + ": init adopted");
            foreach (var step in c.GetProperty("steps").EnumerateArray())
            {
                var source = step.GetProperty("source").GetString() switch { "mirror" => Source.Mirror, "session" => Source.Session, _ => Source.Admission };
                byte[]? admit = step.TryGetProperty("admit_hash_of", out var a) ? Hash(a.GetString()!) : null;
                holder = Registry.ApplyBatch(holder!, source, step.GetProperty("snapshots").EnumerateArray().Select(s => Snap(s.GetString()!)).ToList(), admit).Holder;
            }
            var expect = c.GetProperty("expect");
            Assert.Equal(expect.GetProperty("active").EnumerateArray().Select(x => x.GetString()!).Order(), holder!.Active.Keys.Select(k => nameOf[k]).Order());
            Assert.Equal(expect.GetProperty("tombstoned").EnumerateArray().Select(x => x.GetString()!).Order(), holder.Tombstoned.Select(k => nameOf[k]).Order());
            Assert.Equal(expect.GetProperty("version").GetInt64(), holder.Version);
        }
    }
}
