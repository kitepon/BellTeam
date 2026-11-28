using System.Net;
using System.Net.Http;
using System.Net.WebSockets;
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

    // The server refuses the join the moment the socket opens, before the runtime has finished its own join send: the refusal must stay the state, and Refresh must reconnect at once.
    [Fact]
    public async Task ARefusalThatArrivesWithTheJoinStaysNotEntitledAndRefreshReconnects()
    {
        for (var round = 0; round < 10; round++)
        {
            var port = new Random().Next(20000, 40000); using var listener = new HttpListener(); listener.Prefixes.Add($"http://localhost:{port}/"); listener.Start();
            var accepts = 0;
            _ = Task.Run(async () =>
            {
                while (true)
                {
                    var ws = (await (await listener.GetContextAsync()).AcceptWebSocketAsync(null)).WebSocket; Interlocked.Increment(ref accepts);
                    await ws.SendAsync("{\"type\":\"error\",\"of\":\"join\",\"code\":\"not_entitled\"}"u8.ToArray(), WebSocketMessageType.Text, true, CancellationToken.None);
                    _ = Task.Run(async () => { try { await ws.ReceiveAsync(new byte[256], CancellationToken.None); } catch (Exception) { } });
                }
            });
            var holder = new Holder("acct", 1, [], new Dictionary<string, Entry>(), new HashSet<string>());
            var access = new ServerAccess(new Uri($"http://localhost:{port}"), new Dictionary<string, string>());
            await using var runtime = Make(_ => Task.FromResult(access), (_, _) => Task.FromResult<Holder?>(holder));
            runtime.Start();
            await Until(() => runtime.State.Status == RuntimeStatus.NotEntitled);
            await Task.Delay(150);
            Assert.Equal(RuntimeStatus.NotEntitled, runtime.State.Status); Assert.Equal(1, Volatile.Read(ref accepts));
            runtime.Refresh();
            await Until(() => Volatile.Read(ref accepts) == 2);
            await Until(() => runtime.State.Status == RuntimeStatus.NotEntitled);
        }
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
