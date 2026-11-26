using System.IO;
using BellTeam.App;

namespace BellTeam.Tests;

// The adapter over the real Kitepon.ApprovalBox.Client 0.5.4 join (child-join.md; no server, no browser: the opener is ours).
public class ClientChildJoinTests
{
    [Fact]
    public async Task ARealJoinStartsSignsInWithTheChosenProviderAndCancelsBackToNotJoined()
    {
        var dir = Path.Combine(Path.GetTempPath(), "bt-child-" + Guid.NewGuid().ToString("N"));
        var opened = new TaskCompletionSource<Uri>();
        await using var box = new ApprovalBoxDevice(dir, "http://127.0.0.1:1", null, uri => { opened.TrySetResult(uri); return Task.Delay(Timeout.Infinite); });
        Assert.Equal(ChildJoinPhase.NotJoined, box.Join.Phase); Assert.False(box.Join.SigningIn);
        await Assert.ThrowsAsync<InvalidOperationException>(() => box.Join.JoinAsync(null));   // nothing to repeat yet
        await box.Join.JoinAsync("apple");
        Assert.Equal("appleid.apple.com", (await opened.Task.WaitAsync(TimeSpan.FromSeconds(10))).Host);
        Assert.True(box.Join.SigningIn); Assert.Equal(ChildJoinPhase.NotJoined, box.Join.Phase);
        box.Join.CancelJoin();
        Assert.False(box.Join.SigningIn); Assert.Equal(ChildJoinPhase.NotJoined, box.Join.Phase);
    }
}
