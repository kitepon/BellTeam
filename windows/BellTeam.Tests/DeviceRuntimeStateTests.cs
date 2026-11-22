using System.Net.Http;
using BellTeam.PeerChannel;

namespace BellTeam.Tests;

public class DeviceRuntimeStateTests
{
    private static DeviceRuntime Make(Func<CancellationToken, Task<ServerAccess>> access, Func<ServerAccess, CancellationToken, Task<Holder?>>? registry = null)
        => new(new(DeviceIdentity.Generate(), "test", access, registry ?? ((_, _) => Task.FromResult<Holder?>(null)), new DecisionBook(), (_, ct) => Task.Delay(Timeout.Infinite, ct)));

    private static async Task Until(Func<bool> done) { for (var i = 0; i < 300 && !done(); i++) await Task.Delay(10); Assert.True(done()); }

    [Fact]
    public async Task NotSignedInIsSignedOutAndAPassThatEndedKeepsItsReason()
    {
        await using var runtime = Make(_ => throw new SignedOutException());
        runtime.Start();
        await Until(() => runtime.State.Status == RuntimeStatus.SignedOut);
        Assert.Equal("signed_out", runtime.State.Reason);
        await using var ended = Make(_ => throw new SignedOutException("pass_ended"));
        ended.Start();
        await Until(() => ended.State is { Status: RuntimeStatus.SignedOut, Reason: "pass_ended" });
    }

    [Fact]
    public async Task ADeviceTheRegistryNoLongerListsNeedsApprovalWithItsReasonAndAnUnverifiableRegistryToo()
    {
        var access = new ServerAccess(new Uri("http://127.0.0.1:1"), new Dictionary<string, string>());
        await using var removed = Make(_ => Task.FromResult(access), (_, _) => throw new NeedsApprovalException("removed"));
        removed.Start();
        await Until(() => removed.State is { Status: RuntimeStatus.NeedsAdmission, Reason: "removed" });
        await using var unverified = Make(_ => Task.FromResult(access));
        unverified.Start();
        await Until(() => unverified.State is { Status: RuntimeStatus.NeedsAdmission, Reason: "not_verified" });
    }

    [Fact]
    public async Task AnyOtherFailureIsReconnectingWithItsReasonAndNeverStops()
    {
        await using var runtime = Make(_ => throw new HttpRequestException("down"));
        runtime.Start();
        await Until(() => runtime.State.Status == RuntimeStatus.Retrying);
        Assert.Contains("down", runtime.State.Reason);
    }
}
