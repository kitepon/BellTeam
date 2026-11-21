using Avalonia.Controls;
using Avalonia.VisualTree;

namespace BellTeam.Linux;

// a492: the token store over the home record (the home token only for its own origin; Clear drops it) and the home login screen's two shapes.
public sealed class HomeLinkTests
{
    private sealed class FakeHome(string? token = "tok") : IHomeLink
    {
        public string? Kept = token; public string? Setup; public bool Ended;
        public Task ConnectAsync(string baseUrl, string kind, string? setupCode, CancellationToken cancel) { Setup = setupCode; Kept = "new"; return Task.CompletedTask; }
        public string? Token(string url) => Kept is not null && new Uri(url).Authority == "home.example:18897" ? Kept : null;
        public Task EndAsync(CancellationToken cancel) { Ended = true; Kept = null; return Task.CompletedTask; }
        public Task ReproveIfDueAsync(string? ticketFor, CancellationToken cancel) => Task.CompletedTask;
        public void Forget(string url) { if (Token(url) is not null) Kept = null; }
    }

    [Fact]
    public void TheHomeTokenIsOnlyForItsOwnOriginAndClearDropsIt()
    {
        var home = new FakeHome(); var older = new MemorySessionTokenStore();
        var store = new CompositeSessionTokenStore(() => home, older);
        var mine = new Uri("http://home.example:18897/"); var other = new Uri("http://other.example/");
        older.Save(other, "old");
        Assert.Equal("tok", store.Load(mine)); Assert.Equal("old", store.Load(other));
        store.Clear(other); Assert.Equal("tok", store.Load(mine)); Assert.Null(store.Load(other));
        store.Clear(mine); Assert.Null(store.Load(mine));
    }

    [Theory]
    [InlineData("unreachable", "届きません")]
    [InlineData("LOGIN_CODE_INVALID", "セットアップコード")]
    [InlineData("SESSION_STORE_UNAVAILABLE", "準備中")]
    public void AnUnreachableOrUnjudgedServerIsNeverSaidAsLogInAgain(string code, string part)
    {
        var text = HomeConnectView.Failure(new HomeLinkException(code, 0));
        Assert.Contains(part, text); Assert.DoesNotContain("サインインし直して", text);
    }

    [Fact]
    public Task AnUnboundServerAsksForTheSetupCodeAndSendsIt() => Ui.Run(async () =>
    {
        var home = new FakeHome(null); var done = 0;
        var view = new HomeConnectView(home, new HomeProbe { Capability = HomeGate.Capability, Bound = false }, "android", new Uri("http://home.example:18897/"), () => done++, () => { });
        var box = view.GetVisualDescendants().OfType<TextBox>().Single(); box.Text = " ABC ";
        view.Begin(); await view.Running;
        Assert.Equal("ABC", home.Setup); Assert.Equal(1, done);
    });

    [Fact]
    public Task ABoundServerLogsInAtOnceWithoutACode() => Ui.Run(async () =>
    {
        var home = new FakeHome(null); var done = 0;
        var view = new HomeConnectView(home, new HomeProbe { Capability = HomeGate.Capability, Bound = true }, "linux", new Uri("http://home.example:18897/"), () => done++, () => { });
        await view.Running;
        Assert.Null(home.Setup); Assert.Equal(1, done); Assert.Empty(view.GetVisualDescendants().OfType<TextBox>());
    });
}
