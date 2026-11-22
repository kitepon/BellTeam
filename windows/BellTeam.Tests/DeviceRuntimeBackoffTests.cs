using BellTeam.PeerChannel;

namespace BellTeam.Tests;

public class DeviceRuntimeBackoffTests
{
    [Fact]
    public void WaitsDoubleFromOneToThirtySecondsWithTwentyPercentJitterAndNeverStopGrowingTheTries()
    {
        Assert.Equal([1000, 2000, 4000, 8000, 16000, 30000, 30000], Enumerable.Range(0, 7).Select(i => (int)DeviceRuntime.Backoff(i, () => 0.5).TotalMilliseconds));
        Assert.Equal(800, DeviceRuntime.Backoff(0, () => 0).TotalMilliseconds);
        Assert.Equal(1200, DeviceRuntime.Backoff(0, () => 1).TotalMilliseconds);
        Assert.Equal(30000, DeviceRuntime.Backoff(1000, () => 1).TotalMilliseconds);
    }
}
