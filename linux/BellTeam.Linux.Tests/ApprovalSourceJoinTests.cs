using Kitepon.ApprovalBox.Client;

namespace BellTeam.Linux;

// The adapter of the child join: ClientApprovalSource draws the component's joinState as the port's ChildJoinState and forwards requestJoin / cancelJoin / leave. The component runs for real; only its login-billing form is a stand-in
// (a real browser sign-in and a real parent phone are not covered here; child-join.md, client-component.md 9).
public sealed class ApprovalSourceJoinTests
{
    private sealed class Form : IChildJoinForm
    {
        public readonly TaskCompletionSource SignedIn = new(), ParentAdds = new();
        public readonly List<string> Calls = [];
        public bool HasKey { get; private set; }
        public string? Header(string method, Uri url, byte[] body) => HasKey ? "k" : null;
        public void UseServerTime(long nowMs) { }
        public async Task<IChildJoinRequest> MakeRequestAsync(string provider, CancellationToken ct)
        {
            Calls.Add("make:" + provider);
            await SignedIn.Task.WaitAsync(ct); HasKey = true;
            return new Request(this);
        }
        public Task LeaveAsync(CancellationToken ct) { Calls.Add("leave"); HasKey = false; return Task.CompletedTask; }
        public void Forget() { Calls.Add("forget"); HasKey = false; }
        private sealed class Request(Form form) : IChildJoinRequest
        {
            public string Qr => "https://login-billing.kitepon.dev/join/dev.kitepon.approvalbox#lbq4:test";
            public DateTimeOffset ExpiresAt { get; } = DateTimeOffset.UtcNow.AddMinutes(5);
            public Task AcceptAsync(CancellationToken ct) => form.ParentAdds.Task.WaitAsync(ct);
            public void Dispose() { }
        }
    }

    private static (ClientApprovalSource Source, Form Form, ApprovalBoxClient Client) Make()
    {
        var form = new Form();
        var directory = Path.Combine(Path.GetTempPath(), "abx-join-" + Guid.NewGuid().ToString("N"));
        var client = new ApprovalBoxClient(new ApprovalBoxClientOptions { BaseUri = new Uri("https://approval-box.example"), Join = new ChildJoinOptions { StateDirectory = directory, Form = form } });
        return (new ClientApprovalSource(client, () => []), form, client);
    }
    private static async Task WaitAsync(Func<bool> done) { for (var wait = 0; wait < 200 && !done(); wait++) await Task.Delay(20); }

    [Fact]
    public async Task ASignInThenAParentsAddWalksNotJoinedSigningInWaitingJoinedAndLeaveGoesBack()
    {
        var (source, form, client) = Make();
        await using var _ = client;
        Assert.Equal(JoinPhase.NotJoined, source.Join!.Phase); Assert.False(source.Join.Removed);
        source.RequestJoin("google");
        Assert.Equal(JoinPhase.SigningIn, source.Join!.Phase); Assert.Equal(["make:google"], form.Calls);
        form.SignedIn.SetResult(); await WaitAsync(() => source.Join!.Phase == JoinPhase.Waiting);
        var waiting = source.Join!;
        Assert.Equal(JoinPhase.Waiting, waiting.Phase); Assert.Contains("dev.kitepon.approvalbox", waiting.QrLink); Assert.NotNull(waiting.ExpiresAt);
        form.ParentAdds.SetResult(); await WaitAsync(() => source.Join!.Phase == JoinPhase.Joined);
        Assert.Equal(JoinPhase.Joined, source.Join!.Phase);
        await source.LeaveAsync();
        Assert.Equal(JoinPhase.NotJoined, source.Join!.Phase); Assert.Contains("leave", form.Calls);
    }

    [Fact]
    public async Task CancelEndsTheSignInAndTheRequestAndTheNextRequestStartsClean()
    {
        var (source, form, client) = Make();
        await using var _ = client;
        source.RequestJoin("apple"); source.CancelJoin();
        Assert.Equal(JoinPhase.NotJoined, source.Join!.Phase);
        form.SignedIn.SetResult(); await Task.Delay(100);
        Assert.Equal(JoinPhase.NotJoined, source.Join!.Phase);   // the ended sign-in leaves nothing behind
        source.RequestJoin("google");
        Assert.Equal(JoinPhase.Waiting, await Task.Run(async () => { await WaitAsync(() => source.Join!.Phase == JoinPhase.Waiting); return source.Join!.Phase; }));
        source.CancelJoin(); Assert.Equal(JoinPhase.NotJoined, source.Join!.Phase);
    }
}
