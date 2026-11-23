using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using BellTeam.Core;
using static BellTeam.App.LatticeLook;

namespace BellTeam.App;

/// <summary>What the Waiting screen shows (peer-channel-signin.md section 3): the typed code (16 characters, grouped), the QR text and when they stop being valid.</summary>
internal sealed record ApprovalOffer(string Code, string Qr, DateTimeOffset ExpiresAt);

/// <summary>
/// The one reader of 決裁箱 for this app (screen-spec "入口"): this device's peer-channel session (the list is the device's book only since the /v1 close, 2026-12-12) plus the id-level link
/// lookup (<see cref="ApprovalLinks"/>) for the badge and the 工程とのつながり panel; tells the entry row and the window on the UI thread. Saves nothing.
/// </summary>
internal sealed class ApprovalsHub : IDisposable
{
    /// <summary>The hub of the main window, so the 工程表 window's 決裁を開く can reach the screen (README L10).</summary>
    internal static ApprovalsHub? Current { get; set; }

    private readonly Workspace workspace;
    private readonly bool autostart;
    private readonly CancellationTokenSource life = new();
    private string origin = "";
    /// <summary>This device's peer-channel session while the device part is on (null: it is off: the screen says so).</summary>
    internal IDeviceDecisions? Device { get; }
    internal ApprovalLinks Links { get; } = new();
    /// <summary>Starts the Approval Box web sign-in of the second library instance (set when that instance exists; the 「Approval Boxにサインイン」 button shows only then).</summary>
    internal Action? SignInApprovalBox { get; set; }
    /// <summary>The Approval Box web sign-in is open in the browser (SigningIn); 「やめる」 calls CancelSignIn. The note is why the last try ended, if it did not end by the person's own choice.</summary>
    internal bool SigningIn { get; private set; }
    internal string? SignInNote { get; private set; }
    internal Action? CancelSignIn { get; set; }
    /// <summary>NeedsApproval -> Waiting: the code and QR this device shows while a verified device admits it (5.3). Null offer = none open; the note says why the last one ended.</summary>
    internal ApprovalOffer? Offer { get; private set; }
    internal string? OfferNote { get; private set; }
    internal Action? RequestApproval { get; set; }
    internal Action? CancelApproval { get; set; }
    internal void SetOffer(ApprovalOffer? offer, string? note = null) { Offer = offer; OfferNote = note; Post(() => Changed?.Invoke()); }
    internal void SetSignIn(bool signingIn, string? note = null) { SigningIn = signingIn; SignInNote = note; Post(() => Changed?.Invoke()); }
    /// <summary>The device's decisions as the screen draws them, each joined with its chart link when that is known.</summary>
    internal IReadOnlyList<ViewDecision> DeviceViews => Device is null ? [] : [.. Device.Book.All.Select(DeviceDecisionView.Of).Select(Links.Join)];
    /// <summary>The counts of the entry row and the toolbar: what the device holds (null without a device).</summary>
    internal ApprovalSummary? Summary => Device is null ? null : Approvals.SummaryOf(DeviceViews, DateTimeOffset.UtcNow);
    /// <summary>The device's book, connection or links changed: the open window repaints.</summary>
    internal event Action? DeviceChanged;
    internal Workspace Workspace => workspace;
    /// <summary>Opens the 決裁箱 window (null = the list, an id = that decision's 詳細). Set by the main window.</summary>
    internal Action<string?>? Show { get; set; }
    /// <summary>Opens a chart at a card's 詳細 (工程表で見る, 工程表の工程を開く, a neighbour card): project id, card id.</summary>
    internal Action<string, string>? OpenChart { get; set; }
    /// <summary>The summary or the device's state changed (the entry row repaints).</summary>
    internal event Action? Changed;

    internal ApprovalsHub(Workspace workspace, bool autostart = true, IDeviceDecisions? device = null)
    {
        this.workspace = workspace; this.autostart = autostart; Device = device;
        if (device is not null) device.Changed += () => Post(() => { Changed?.Invoke(); DeviceChanged?.Invoke(); ReadLinks(); });
        workspace.PropertyChanged += WorkspaceChanged;
        if (workspace.Connected) ReadLinks();
    }

    private void WorkspaceChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs args)
    {
        if (args.PropertyName != nameof(Workspace.Connected)) return;
        var dispatcher = Application.Current?.Dispatcher;
        if (dispatcher is null || dispatcher.CheckAccess()) ReadLinks(); else dispatcher.BeginInvoke(ReadLinks);
    }

    /// <summary>Asks BellTeam which of the device's decisions are linked to a chart task (a changed server forgets the answers).</summary>
    internal void ReadLinks()
    {
        if (!autostart || !workspace.Connected || Device is null) return;
        if (origin != workspace.Server) { origin = workspace.Server; Links.Forget(); }
        _ = Links.ReadAsync(workspace.Management.Api, DeviceViews, () => Post(() => { Changed?.Invoke(); DeviceChanged?.Invoke(); }), life.Token);
    }
    private static void Post(Action action) { var dispatcher = Application.Current?.Dispatcher; if (dispatcher is null || dispatcher.CheckAccess()) action(); else dispatcher.BeginInvoke(action); }

    public void Dispose() { workspace.PropertyChanged -= WorkspaceChanged; life.Cancel(); if (ReferenceEquals(Current, this)) Current = null; }
}

/// <summary>The pinned row at the top of the left menu (screen-spec "入口", option A): inbox tile, 決裁箱, one line, the count, an amber bolt when something is 急ぎ.</summary>
internal sealed class ApprovalsEntryRow : Button
{
    private ApprovalsHub? hub;
    public ApprovalsEntryRow()
    {
        base.Template = PlainTemplate; Cursor = System.Windows.Input.Cursors.Hand; Background = Brushes.Transparent; BorderThickness = new Thickness(0); Padding = new Thickness(0); HorizontalContentAlignment = HorizontalAlignment.Stretch;
        System.Windows.Automation.AutomationProperties.SetAutomationId(this, "approvals-entry");
        Click += (_, _) => hub?.Show?.Invoke(null);
        Paint();
    }
    private static readonly ControlTemplate PlainTemplate = BuildTemplate();
    private static ControlTemplate BuildTemplate()
    {
        var template = new ControlTemplate(typeof(Button)); template.VisualTree = new FrameworkElementFactory(typeof(ContentPresenter)); template.Seal(); return template;
    }

    internal void Attach(ApprovalsHub hub)
    {
        if (this.hub is { } old) old.Changed -= Paint;
        this.hub = hub; hub.Changed += Paint; Paint();
    }

    internal ApprovalEntryView View => Approvals.EntryView(hub?.Summary, null);

    private void Paint()
    {
        var view = View; var pending = view.Pending > 0;
        var tile = new Border { Width = 40, Height = 40, CornerRadius = new CornerRadius(12), Background = pending ? Brush(Violet) : Brush(Muted, 0x2E), Child = ApprovalsLook.Glyph("inbox", 20, pending ? Colors.White : Muted) };
        var text = new StackPanel { VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(12, 0, 8, 0) };
        text.Children.Add(Text("決裁箱", 15, Ink, FontWeights.SemiBold)); text.Children.Add(Text(view.Sub, 12, Muted));
        var dock = new DockPanel();
        if (pending)
        {
            var badge = Pill(Text(view.Pending.ToString(), 13, Colors.White, FontWeights.Bold), Violet, 0xFF, new Thickness(9, 2, 9, 2)); DockPanel.SetDock(badge, Dock.Right); dock.Children.Add(badge);
            if (view.Urgent) { var bolt = ApprovalsLook.Glyph("bolt", 16, Amber); bolt.Margin = new Thickness(0, 0, 8, 0); DockPanel.SetDock(bolt, Dock.Right); dock.Children.Add(bolt); }
        }
        DockPanel.SetDock(tile, Dock.Left); dock.Children.Add(tile); dock.Children.Add(text);
        // With something waiting the row carries the accent outline and glow (the Lattice `ready` look); at 0 it is calm.
        var frame = new Border { Child = dock, CornerRadius = new CornerRadius(14), Padding = new Thickness(10, 8, 12, 8), Background = Brush(Colors.White, pending ? (byte)0xF2 : (byte)0xB0),
            BorderBrush = pending ? Brush(Violet, 0x99) : Brush(Colors.White, 0xF0), BorderThickness = new Thickness(pending ? 1.5 : 1) };
        if (pending) frame.Effect = new System.Windows.Media.Effects.DropShadowEffect { Color = Violet, Opacity = .22, BlurRadius = 14, ShadowDepth = 0 };
        Content = frame;
        System.Windows.Automation.AutomationProperties.SetName(this, view.Label);
        ToolTip = view.Label;
    }
}
