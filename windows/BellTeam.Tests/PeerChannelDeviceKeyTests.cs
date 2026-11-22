using System.IO;
using System.Security.Cryptography;
using BellTeam.App;
using BellTeam.PeerChannel;

namespace BellTeam.Tests;

public class PeerChannelDeviceKeyTests
{
    [Fact]
    public void ANewDeviceKeyIsSealedByTheOsAndComesBackTheSame()
    {
        var path = Path.Combine(Path.GetTempPath(), "bt-devkey-" + Guid.NewGuid().ToString("N") + ".bin");
        try
        {
            var first = DeviceKeyStore.LoadOrCreate(path); var again = DeviceKeyStore.LoadOrCreate(path);
            Assert.Equal(first.KeyId, again.KeyId); Assert.Equal(first.SealPrivate, again.SealPrivate);
            Assert.DoesNotContain(first.SealPrivate.AsSpan().ToArray(), new byte[][] { File.ReadAllBytes(path) });
            Assert.True(Keys.Verify(again.SigPub, Keys.Sign(first.SignKey, "t", [1]), "t", [1]));
            var (enc, ct) = Hpke.Seal(first.SealPublic, [2], [3]);
            Assert.Equal<byte>([3], Hpke.Open(again.SealPrivate, again.SealPublic, enc, [2], ct));
            File.WriteAllBytes(path, [1, 2, 3]);
            Assert.NotEqual(first.KeyId, DeviceKeyStore.LoadOrCreate(path).KeyId); // an unreadable file is no key
        }
        finally { File.Delete(path); }
    }
}
