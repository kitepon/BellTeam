using System.IO;
using System.Security.Cryptography;
using System.Text;
using Kitepon.ApprovalBox.Client;

namespace BellTeam.Tests;

// The package's Windows storage must open what BellTeam 0.5 to 0.8 sealed (DeviceKeyStore, the history file, SealedBlobFiles) and seal what they open: DPAPI, current user, one entropy per kind.
public class DpapiPeerStorageTests
{
    [Theory]
    [InlineData(SecretKind.DeviceKey, "BellTeam-peer-channel-device")]
    [InlineData(SecretKind.History, "BellTeam-peer-channel-history")]
    [InlineData(SecretKind.Blob, "BellTeam-peer-channel-blob")]
    public void AFileOfTheOldAppOpensAndANewOneOpensInTheOldApp(SecretKind kind, string oldEntropy)
    {
        var storage = new DpapiPeerStorage(Path.GetTempPath(), "windows test"); var plain = Encoding.UTF8.GetBytes("秘密 " + kind);
        var old = ProtectedData.Protect(plain, Encoding.UTF8.GetBytes(oldEntropy), DataProtectionScope.CurrentUser);       // exactly what the deleted code wrote
        Assert.Equal(plain, storage.Unseal(kind, old));
        Assert.Equal(plain, ProtectedData.Unprotect(storage.Seal(kind, plain), Encoding.UTF8.GetBytes(oldEntropy), DataProtectionScope.CurrentUser));
        Assert.Null(storage.Unseal(kind == SecretKind.Blob ? SecretKind.History : SecretKind.Blob, old));                     // another kind's entropy does not open it
        Assert.Equal(("os_store", "approvals-history.bin", "windows"), (storage.Protection, storage.HistoryFileName, storage.Platform));
    }
}
