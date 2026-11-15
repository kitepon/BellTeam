using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using BellTeam.Core;
using static BellTeam.App.LatticeLook;

namespace BellTeam.App;

/// <summary>
/// The one reader of 決裁箱 for this app (screen-spec "入口", README F-feed): owns the <see cref="ApprovalsFeed"/> of the connected server and tells the entry row and
/// the window on the UI thread. Starts when the workspace is connected, restarts on another server, saves nothing.
/// </summary>
internal sealed class ApprovalsHub : IDisposable
{
    /// <summary>The hub of the main window, so the 工程表 window's 決裁を開く can reach the screen (README L10).</summary>
    internal static ApprovalsHub? Current { get; set; }

    private readonly Workspace workspace;
    private readonly bool autostart;
    internal ApprovalsFeed? Feed { get; private set; }
    internal Workspace Workspace => workspace;
    /// <summary>Opens the 決裁箱 window (null = the list, an id = that decision's 詳細). Set by the main window.</summary>
    internal Action<string?>? Show { get; set; }
    /// <summary>Opens a chart at a card's 詳細 (工程表で見る, 工程表の工程を開く, a neighbour card): project id, card id.</summary>
    internal Action<string, string>? OpenChart { get; set; }
    /// <summary>Summary or status changed (the entry row repaints).</summary>
    internal event Action? Changed;
    /// <summary>A decision changed on the server (id, version), or the stream came back (id null): the open window reads again.</summary>
    internal event Action<string?>? DecisionChanged;

    internal ApprovalsHub(Workspace workspace, bool autostart = true)
    {
        this.workspace = workspace; this.autostart = autostart;
        workspace.PropertyChanged += WorkspaceChanged;
        if (workspace.Connected) Reset();
    }

    private void WorkspaceChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs args)
    {
        if (args.PropertyName != nameof(Workspace.Connected)) return;
        var dispatcher = Application.Current?.Dispatcher;
        if (dispatcher is null || dispatcher.CheckAccess()) Reset(); else dispatcher.BeginInvoke(Reset);
    }

    private void Reset()
    {
        Feed?.Stop(); Feed = null;
        if (workspace.Connected && autostart)
        {
            var feed = new ApprovalsFeed(workspace.Management.Api);
            feed.SummaryChanged += Notify; feed.StatusChanged += Notify;
            feed.DecisionChanged += item => Post(() => DecisionChanged?.Invoke(item.Id));
            feed.Resynced += () => Post(() => DecisionChanged?.Invoke(null));
            Feed = feed; feed.Start();
        }
        Changed?.Invoke();
    }
    private void Notify() => Post(() => Changed?.Invoke());
    private static void Post(Action action) { var dispatcher = Application.Current?.Dispatcher; if (dispatcher is null || dispatcher.CheckAccess()) action(); else dispatcher.BeginInvoke(action); }

    public void Dispose() { workspace.PropertyChanged -= WorkspaceChanged; Feed?.Stop(); Feed = null; if (ReferenceEquals(Current, this)) Current = null; }
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

    internal ApprovalEntryView View => Approvals.EntryView(hub?.Feed?.Summary, hub?.Feed?.Failure);

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
