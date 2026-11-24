using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;

// abx-v1-replay-desktop: a launch without Last-Event-ID replays the account's whole history, one source Changed per event; the screen is told at most every 500 ms (the first change at once, the rest as one later notification).
public sealed class ApprovalsHubNotifyTests
{
    [Fact]
    public void ABurstOfSourceChangesIsOneImmediateNotificationAndFewLaterOnes_TheLastStateIsAlwaysTold()
    {
        var workspace = new Workspace(origin => new BellApi(origin, new ApprovalsFixture("connected"))); var demo = new ApprovalsFixture.Demo().Fill();
        var told = 0; var hub = new ApprovalsHub(workspace, autostart: false, device: demo); hub.DeviceChanged += () => Interlocked.Increment(ref told);
        var clock = System.Diagnostics.Stopwatch.StartNew(); var raised = 0;
        while (clock.ElapsedMilliseconds < 1000) { demo.Raise(); raised++; Thread.Sleep(2); }        // one second of events
        Assert.InRange(told, 1, 4); Assert.True(raised > 20);                   // not one per event
        var seen = told; demo.Raise(); Thread.Sleep(900);                         // one more change after the burst still reaches the screen
        Assert.True(told > seen, "the last change is told");
        hub.Dispose(); workspace.Dispose();
    }
}
