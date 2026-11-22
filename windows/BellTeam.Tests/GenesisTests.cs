using BellTeam.PeerChannel;

namespace BellTeam.Tests;

public class GenesisTests
{
    [Fact]
    public void AGenesisNamesOnlyThisWindowsDeviceAndTheHolderTrustsItByItsOwnHash()
    {
        var me = DeviceIdentity.Generate(); var snapshot = Genesis.Create(me, "acct-1", "windows", "os_store", 1_700_000_000_000);
        Assert.True(snapshot.Verify(me.SigPub));
        var body = SnapshotBody.Parse(snapshot.Body)!;
        Assert.Equal(("acct-1", 1L, 0, 0), (body.Account, body.Version, body.Connectors.Count, body.Removed.Count));
        var device = Assert.Single(body.Devices);
        Assert.Equal(("windows", "os_store", Bytes.B64Url(me.KeyId), Bytes.B64Url(me.KeyId)), (device.Platform, device.Protection, device.KeyId, device.AddedBy));
        var holder = BellTeam.PeerChannel.Registry.Adopt(snapshot, snapshot.Hash(), "acct-1");
        Assert.NotNull(holder); Assert.Contains(Bytes.B64Url(me.KeyId), holder!.Active.Keys);
        Assert.Null(BellTeam.PeerChannel.Registry.Adopt(snapshot, snapshot.Hash(), "other-account"));
    }
}
