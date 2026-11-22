using System.IO;
using System.Security.Cryptography;
using System.Text;
using BellTeam.PeerChannel;

namespace BellTeam.App;

// The device's peer-channel keys sealed with DPAPI (current user, own entropy): registry protection "os_store" (contract 3.1). A file that does not unseal is no key: new keys are made and the device is added to the registry again.
internal static class DeviceKeyStore
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("BellTeam-peer-channel-device");

    public static DeviceIdentity LoadOrCreate(string path)
    {
        try { if (File.Exists(path)) return DeviceIdentity.Import(ProtectedData.Unprotect(File.ReadAllBytes(path), Entropy, DataProtectionScope.CurrentUser)); }
        catch (Exception error) when (error is CryptographicException or ArgumentException) { }
        var made = DeviceIdentity.Generate();
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temp = path + ".tmp";
        File.WriteAllBytes(temp, ProtectedData.Protect(made.Export(), Entropy, DataProtectionScope.CurrentUser));
        File.Move(temp, path, overwrite: true);
        return made;
    }
}
