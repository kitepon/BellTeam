using Avalonia.Controls;
using Avalonia.VisualTree;
using BellTeam.Core;

namespace BellTeam.Linux;

// 「AIの許可待ちを決裁箱へ送る」 (seat-approval-card.md): drawn only from the body's three routes, in the 工程表との連携 panel; a body without the routes (404) draws no section.
public sealed class ApprovalsSeatLinkTests
{
    private static async Task<ApprovalsWindow> OpenAsync(string scene, string seat)
    {
        var workspace = new LinuxWorkspace(origin => new BellApi(origin, new ApprovalsFixture(scene, seat)));
        await workspace.ConnectAsync("http://localhost", listen: false);
        var window = new ApprovalsWindow(new ApprovalsHub(workspace, (IApprovalSource?)null), workspace, (_, _) => { }, _ => { });
        window.Show(); await window.OpenLinkForRenderAsync(); await Task.Delay(100); Avalonia.Threading.Dispatcher.UIThread.RunJobs();
        return window;
    }
    private static bool Has(Control root, string text) { root.UpdateLayout(); return root.GetVisualDescendants().OfType<TextBlock>().Any(t => (t.Text ?? "").Contains(text, StringComparison.Ordinal)); }
    private static Button? Find(Control root, string label) => root.GetVisualDescendants().OfType<Button>().FirstOrDefault(b => Avalonia.Automation.AutomationProperties.GetName(b) == label);

    [Fact]
    public Task AbsentRouteDrawsNoSection() => Ui.Run(async () =>
    {
        var window = await OpenAsync("gone", "none");
        try { Assert.False(Has(window, SeatLinkText.Title)); } finally { window.Close(); }
    });

    [Fact]
    public Task LinkedShowsTheBadgeAndTheSentenceAndNoButton() => Ui.Run(async () =>
    {
        var window = await OpenAsync("connected", "linked");
        try { Assert.True(Has(window, SeatLinkText.Title)); Assert.True(Has(window, SeatLinkText.BadgeLinked)); Assert.True(Has(window, SeatLinkText.Linked)); Assert.Null(Find(window, SeatLinkText.Connect)); }
        finally { window.Close(); }
    });

    [Fact]
    public Task RejectedIsAFailureWithItsBadgeAndTheTryAgainButton() => Ui.Run(async () =>
    {
        var window = await OpenAsync("connected", "failed-rejected");
        try { Assert.True(Has(window, SeatLinkText.Rejected)); Assert.True(Has(window, SeatLinkText.BadgeFailed)); Assert.True(Has(window, SeatLinkText.Again)); }
        finally { window.Close(); }
    });

    [Fact]
    public Task StartShowsTheQrAndTheTypedCodeAndStopLeaves() => Ui.Run(async () =>
    {
        var window = await OpenAsync("connected", "none");
        try
        {
            Assert.True(Has(window, SeatLinkText.None));
            Find(window, SeatLinkText.Connect)!.RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Button.ClickEvent)); await Task.Delay(200); Avalonia.Threading.Dispatcher.UIThread.RunJobs();
            Assert.True(Has(window, SeatLinkText.Scan)); Assert.True(Has(window, "4CH9-MGVR-13NC-MC6C")); Assert.NotEmpty(window.GetVisualDescendants().OfType<QrView>());
            Find(window, SeatLinkText.Cancel)!.RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Button.ClickEvent)); await Task.Delay(200); Avalonia.Threading.Dispatcher.UIThread.RunJobs();
            Assert.True(Has(window, SeatLinkText.None));
        }
        finally { window.Close(); }
    });
}
