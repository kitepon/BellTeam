using System.Text;
using System.Text.Json;

namespace BellTeam.PeerChannel;

// The first registry of an account (contract 5.1): version 1, this device only, signed by it. The caller uploads it only after the mirror answered "no registry" (a device that finds slots it cannot verify never makes a genesis alone).
public static class Genesis
{
    public static SignedSnapshot Create(DeviceIdentity me, string account, string platform, string protection, long now)
    {
        var id = Bytes.B64Url(me.KeyId);
        var body = JsonSerializer.Serialize(new
        {
            v = "pc1-registry", account, version = 1, prev = Array.Empty<string>(), created_at = now,
            devices = new[] { new { key_id = id, sig_pub = Bytes.B64Url(me.SigPub), seal_pub = Bytes.B64Url(me.SealPublic), platform, protection, added_at = now, added_by = id } },
            connectors = Array.Empty<object>(), removed = Array.Empty<object>(),
        });
        return SignedSnapshot.Sign(Encoding.UTF8.GetBytes(body), me.SignKey, me.KeyId);
    }
}
