namespace BellTeam.Linux;

public sealed class SingleInstanceTests
{
    [Fact]
    public void SocketPathUsesTheRuntimeDirectoryOtherwiseTmpWithTheUid()
    {
        Assert.Equal("/run/user/1000/bellteam.sock", SingleInstance.SocketPath("/run/user/1000", 1000));
        Assert.Equal("/tmp/bellteam-1000.sock", SingleInstance.SocketPath(null, 1000));
        Assert.Equal("/tmp/bellteam-42.sock", SingleInstance.SocketPath("", 42));
    }

    // Unix socket paths are short (108 bytes), so the tests use a short directory of their own.
    private static string NewPath() => Path.Combine(Directory.CreateTempSubdirectory("bt").FullName, "s.sock");

    [Fact]
    public async Task ASecondLaunchRaisesTheFirstAndIsNotPrimary()
    {
        var path = NewPath(); var raised = new TaskCompletionSource();
        using var first = new SingleInstance(path, () => raised.TrySetResult());
        Assert.True(first.IsPrimary);
        using var second = new SingleInstance(path, () => throw new InvalidOperationException("a second instance must not listen"));
        Assert.False(second.IsPrimary);
        await raised.Task.WaitAsync(TimeSpan.FromSeconds(5));
    }

    [Fact]
    public void AStaleSocketFileOfACrashedInstanceIsReplaced()
    {
        var path = NewPath();
        // What a killed instance leaves behind: a file at the path that nothing listens on.
        File.WriteAllBytes(path, []);
        Assert.True(File.Exists(path));
        using var instance = new SingleInstance(path, () => { });
        Assert.True(instance.IsPrimary);
    }
}
