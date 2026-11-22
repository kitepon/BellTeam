using System.IO;
using System.Text.Json;
using BellTeam.PeerChannel;

namespace BellTeam.Tests;

// The 5.3 starter (DeviceAdmission) against a TS approver device: windows/BellTeam.Tests/e2e/harness-admit.mjs writes the file PC_E2E_ADMIT_FILE names (start it first; its header has the steps).
// Without the variable this test does nothing.
public class DeviceAdmissionE2eTests
{
    [Fact]
    public async Task ATsDeviceAdmitsThisWindowsDeviceByTheTypedCodeAndItsOwnRegistryNamesIt()
    {
        var path = Environment.GetEnvironmentVariable("PC_E2E_ADMIT_FILE");
        if (path is null) return;
        var v = JsonDocument.Parse(File.ReadAllText(path)).RootElement; var account = v.GetProperty("account").GetString()!;
        var access = new ServerAccess(new Uri(v.GetProperty("url").GetString()!), new Dictionary<string, string> { ["authorization"] = v.GetProperty("authorization").GetString()! });
        var me = DeviceIdentity.Generate();
        var admission = new DeviceAdmission(me, "windows", "os_store", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        Assert.Equal(19, admission.TypedCode.Length); Assert.StartsWith("PC1VERIFY:", admission.QrText); Assert.Equal(6, admission.SafetyNumber.Length);
        var run = admission.CompleteAsync(access, account);
        await Task.Delay(500);                                                       // the verify ids are open before the approver joins
        File.WriteAllText(path + ".in", JsonSerializer.Serialize(new { typed = admission.TypedCode }));
        var (snapshot, holder) = await run.WaitAsync(TimeSpan.FromSeconds(40));
        Assert.Equal(2, holder.Version);
        Assert.Equal("windows", holder.Active[Bytes.B64Url(me.KeyId)].Platform);
        Assert.Equal(2, holder.Active.Values.Count(e => e.IsDevice));
        Assert.True(snapshot.Verify(Bytes.FromB64Url(holder.Active.Values.First(e => Bytes.B64Url(snapshot.Signer) == e.KeyId).SigPub)));
    }
}
