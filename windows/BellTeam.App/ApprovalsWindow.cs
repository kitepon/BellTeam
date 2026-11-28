using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using BellTeam.Core;
using static BellTeam.App.LatticeLook;

namespace BellTeam.App;

/// <summary>
/// The 決裁箱 window (docs/architecture/modules/approval-box-extension/screen-spec.md; same shape as the 工程表 window): its own window, one at a time, three columns
/// 一覧 | 詳細 | 工程とのつながり. Reads only while shown and not minimized; saves nothing (closing drops the drawing; the 出どころ choice lives while the app is open).
/// </summary>
internal sealed class ApprovalsWindow : Window
{
    internal static ApprovalsWindow? Current { get; private set; }
    internal static ApprovalsWindow Open(ApprovalsHub hub) => Current ??= new ApprovalsWindow(hub);

    internal ApprovalsPage Page { get; }
    /// <summary>Render seam: reads without the window being shown.</summary>
    internal bool Rendering { get; set; }
    private bool Wanted => (Rendering || IsVisible) && WindowState != WindowState.Minimized;

    internal ApprovalsWindow(ApprovalsHub hub)
    {
        Title = AppStrings.ApprovalsHub_Paint_1; Width = 1360; Height = 860; MinWidth = 1000; MinHeight = 600; UseLayoutRounding = true;
        SetResourceReference(StyleProperty, typeof(Window)); SetResourceReference(BackgroundProperty, "ConversationBackground");
        Page = new ApprovalsPage(hub, this); Content = Page;
        Resources.Add(typeof(System.Windows.Controls.Primitives.ScrollBar), (Style)System.Windows.Markup.XamlReader.Parse("""
            <Style xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" TargetType="ScrollBar">
              <Setter Property="Width" Value="10"/><Setter Property="MinWidth" Value="10"/><Setter Property="Background" Value="Transparent"/>
              <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="ScrollBar"><Grid Background="Transparent"><Track x:Name="PART_Track" IsDirectionReversed="True"><Track.Thumb><Thumb><Thumb.Template><ControlTemplate TargetType="Thumb"><Border CornerRadius="3" Background="#40212938" Margin="2"/></ControlTemplate></Thumb.Template></Thumb></Track.Thumb></Track></Grid></ControlTemplate></Setter.Value></Setter>
            </Style>
            """));
        IsVisibleChanged += (_, _) => Sync(); StateChanged += (_, _) => Sync();
        PreviewKeyDown += (_, e) => { if (e.Key == Key.Escape && Page.Escape()) e.Handled = true; else if (e.Key == Key.F5) { Page.Reload(); e.Handled = true; } };
        Closed += (_, _) => { Page.Stop(); if (ReferenceEquals(Current, this)) Current = null; };
    }

    internal void Sync() { if (Wanted) Page.Start(); else Page.Stop(); }
}

/// <summary>One 決裁箱 screen: the pending, held and finished decisions are this device's book only (since the /v1 close, 2026-12-12), answered and held through the device's session; BellTeam adds the chart link of each (by-decision) and the one 工程表との連携 connection. Core owns the words and rules.</summary>
internal sealed class ApprovalsPage : Grid
{
    internal enum Tab { Pending, Held, Done }
    private sealed record Answer(string Id, long Version, string Key, string? OptionId, string? Label, string? Text) { public string Step { get; set; } = "confirm"; public string? Note { get; set; } }
    private sealed record Connect(string Phase, string? Server = null, string Note = "");

    private readonly ApprovalsHub hub;
    private readonly ApprovalsWindow window;
    private readonly Grid body = new();
    private readonly Border pill;
    private readonly TextBlock pillText = new() { FontSize = 13, Foreground = Brush(Ink), VerticalAlignment = VerticalAlignment.Center };
    private CancellationTokenSource? run;
    private int connectToken;
    private readonly Dictionary<string, string> holdNotes = [];
    private readonly Dictionary<string, Task<BitmapSource?>> thumbs = [];
    private Connect connect = new("idle");
    private (string Step, string? Note)? drop;
    private (string? Id, string Text) draft = (null, "");
    private string? copied, bannerId, bannerText;
    private string? linkState;   // the 工程表との連携 connection (GET /api/approvals/connection): connected / not_connected, null = not read yet or not readable
    private bool linkOpen;       // the 工程表との連携 panel replaces the columns
    private IApprovalSource? Device => hub.Device;
    private IChildJoin? Join => hub.Join;
    private bool NotJoined => Join is { Phase: not ChildJoinPhase.Joined };   // child-join.md: the window shows the join screen until the child is joined
    private string? leaveStep;                                                 // 「つなぎを外す」: null, "confirm" (外す / やめる), "busy"
    private IReadOnlyList<ViewDecision> DeviceViews => hub.DeviceViews;
    private bool DeviceLive => Device?.State.Status == RuntimeStatus.Live;
    private bool DeviceUsable => Device is { } d && (d.State.Status == RuntimeStatus.Live || d.Decisions.Count > 0);
    private List<ViewDecision> pending => [.. DeviceViews.Where(item => item.Status is "pending" or "held")];
    private List<ViewDecision> done => [.. DeviceViews.Where(item => item.Status is not ("pending" or "held")).OrderByDescending(item => Approvals.DoneAt(item))];
    internal Func<DateTimeOffset> Now { get; set; } = () => DateTimeOffset.UtcNow;
    internal Tab Current { get; private set; } = Tab.Pending;
    internal string Origin { get; private set; } = "all";
    internal string? SelectedId { get; private set; }
    internal IReadOnlyList<ViewDecision> Pending => pending;
    internal IReadOnlyList<ViewDecision> Done => done;
    internal Task Reading { get; private set; } = Task.CompletedTask;
    internal string? AnswerStep => answer?.Step;
    /// <summary>The window is drawn from what the device holds, so it is settled once the device has left its first connect (or there is none).</summary>
    internal bool Settled => Device is null || Device.State.Status != RuntimeStatus.Connecting;
    /// <summary>Picks an option of the selected decision (the confirm opens in place).</summary>
    internal void Choose(string optionId)
    {
        if (SelectedId is { } id && Known(id) is { } decision && decision.Options?.FirstOrDefault(option => option.Id == optionId) is { } option) Ask(decision, option.Id, option.Label, null);
    }
    internal void Write(string text) { if (SelectedId is { } id && Known(id) is { } decision) Ask(decision, null, null, text); }
    internal string? ConnectPhase => connect.Phase;
    private Answer? answer;
    private bool Running => run is not null;
    private Workspace Workspace => hub.Workspace;
    private BellApi Api => Workspace.Management.Api;

    public ApprovalsPage(ApprovalsHub hub, ApprovalsWindow window)
    {
        this.hub = hub; this.window = window;
        pill = Glass(Row(Spinner(14), Spaced(pillText, 8)), 99, new Thickness(14, 7, 16, 7), 0xF2);
        pill.HorizontalAlignment = HorizontalAlignment.Center; pill.VerticalAlignment = VerticalAlignment.Bottom; pill.Margin = new Thickness(0, 0, 0, 18); pill.Visibility = Visibility.Collapsed; pill.IsHitTestVisible = false;
        System.Windows.Automation.AutomationProperties.SetAutomationId(pillText, "approvals-status");
        Children.Add(body); Children.Add(pill);
        Paint();
    }

    // MARK: lifecycle

    internal Func<string, string, Task<BitmapSource>> Avatar
        => (id, version) => Workspace.AvatarAsync($"{Workspace.Server}api/bots/{Uri.EscapeDataString(id)}/avatar?v={Uri.EscapeDataString(version)}");
    private LatticePerson PersonOf(ApprovalRequester requester)
        => Workspace.Bots.FirstOrDefault(bot => bot.Id == requester.BotId) is { } bot ? new(bot.Id, bot.DisplayName, bot.Color, bot.AvatarVersion, true) : new(requester.BotId ?? "", LatticeChart.UnknownMember, null, "", false);
    private string NameOf(ApprovalOriginView origin) => origin.Member is { } member && Workspace.Bots.All(bot => bot.Id != member.BotId) ? LatticeChart.UnknownMember : origin.Name;

    /// <summary>On open: the device's book is the list; ask for the chart links and (when the panel is opened) the connection. The hub repaints on every change.</summary>
    internal void Start()
    {
        if (Running || !Workspace.Connected) return;
        run = CancellationTokenSource.CreateLinkedTokenSource(Workspace.ConnectionToken);
        hub.Changed += OnHub; hub.DeviceChanged += OnDevice;
        connect = new("idle"); drop = null; linkOpen = false; hub.ReadLinks(); Paint();
    }
    internal void Stop()
    {
        if (run is null) return;
        hub.Changed -= OnHub; hub.DeviceChanged -= OnDevice;
        connectToken++; run.Cancel(); run.Dispose(); run = null;
    }
    internal void Reload() { Device?.Refresh(); hub.ReadLinks(); Paint(); }
    /// <summary>Esc: closes the answer confirm if open, else the 工程表との連携 panel, else the 詳細.</summary>
    internal bool Escape()
    {
        if (answer is { Step: "confirm" }) { CancelAnswer(true); return true; }
        if (linkOpen) { linkOpen = false; Paint(); return true; }
        if (SelectedId is not null) { SelectedId = null; answer = null; Paint(); return true; }
        return false;
    }

    private void OnHub() { if (Running) Paint(); }
    // The device's book or connection changed: a sent answer stays "sending" until the book shows the decision closed (the result frame), then the confirm leaves.
    private void OnDevice()
    {
        if (!Running) return;
        if (answer is { Step: "sending" } mine && Known(mine.Id) is { } known && known.Status is not ("pending" or "held")) { answer = null; draft = (null, ""); bannerId = null; }
        Paint();
    }
    private ViewDecision? Known(string id) => DeviceViews.FirstOrDefault(item => item.Id == id);

    // MARK: choosing

    internal void SetTab(Tab tab)
    {
        Current = tab; SelectedId = null; answer = null; linkOpen = false;
        Paint();
    }
    internal void SetOrigin(string value) { Origin = value; Paint(); }
    internal void Select(string id)
    {
        if (SelectedId != id) { answer = null; if (draft.Id != id) draft = (id, ""); }
        SelectedId = id; linkOpen = false;
        Paint();
    }
    /// <summary>Opens the screen on one decision (the 工程表 詳細's 決裁を開く): the tab that holds it, then its 詳細.</summary>
    internal void Show(string id)
    {
        Current = Known(id) is { Status: "answered" or "cancelled" } ? Tab.Done : Current; Select(id);
    }

    // MARK: answering (select -> confirm in place -> 答える)

    private void Ask(ViewDecision decision, string? optionId, string? label, string? text)
    {
        answer = new Answer(decision.Id!, decision.Version, Guid.NewGuid().ToString(), optionId, label, text); Paint("confirm");
    }
    internal void CancelAnswer(bool refocus)
    {
        var was = answer; answer = null; Paint(refocus && was is not null ? (was.OptionId is { } option ? $"o:{option}" : "send-text") : null);
    }
    internal Task SendAsync() => answer is { Step: "confirm" } mine && Known(mine.Id) is { } decision ? SendAsync(decision, mine) : Task.CompletedTask;
    // An answer goes through this device's session only (the connector signs nothing for the person); the sent answer stays "sending" until the book shows the decision closed (OnDevice).
    private async Task SendAsync(ViewDecision decision, Answer mine)
    {
        if (Device is not { } device) return;
        mine.Step = "sending"; mine.Note = null; Paint();
        SendOutcome outcome;
        try { outcome = await device.AnswerAsync(decision.Id!, mine.OptionId, mine.OptionId is null ? mine.Text : null, mine.Version); }
        catch (Exception error) when (error is InvalidOperationException or KeyNotFoundException or ArgumentException) { outcome = new("gone"); }
        if (!Running || !ReferenceEquals(answer, mine)) return;
        switch (outcome.Ack)
        {
            case "ok": break; // stays "sending" until the result frame closes the decision in the book (OnDevice)
            case "refused:stale_version": answer = null; bannerId = decision.Id; bannerText = Approvals.AmendedPlain; break;   // client-v0.5 section 7: one plain line, the typed text stays
            case "refused:already_decided" or "gone": answer = null; break;
            case "unknown": mine.Step = "confirm"; mine.Note = Approvals.DeviceUnknown; break;
            default: mine.Step = "confirm"; mine.Note = Approvals.Retry; break;
        }
        Paint();
    }
    private async Task HoldAsync(ViewDecision decision)
    {
        if (Device is not { } device) return;
        SendOutcome outcome;
        try { outcome = await device.HoldAsync(decision.Id!, decision.Status != "held"); } catch (Exception error) when (error is InvalidOperationException or KeyNotFoundException) { outcome = new("no_session"); }
        if (outcome.Ack == "ok") holdNotes.Remove(decision.Id!); else holdNotes[decision.Id!] = Approvals.HoldFailed;
        if (Running) Paint();
    }
    private void CopyResume(ViewDecision decision)
    {
        try { Clipboard.SetText(decision.ResumePhrase ?? ""); } catch (Exception) { return; }
        copied = decision.Id; Paint();
        _ = Task.Delay(2000).ContinueWith(_ => Dispatcher.BeginInvoke(() => { if (copied == decision.Id) { copied = null; Paint(); } }), TaskScheduler.Default);
    }

    // MARK: 工程表との連携 (Delta 2026-11-23): the one BellTeam-to-Approval Box connection the server-side link engine needs (entitlement through /v1/me). A small panel, not a gate on the list.
    // The module gives the hosted consent page; the browser does the sign-in; the module polls.

    private static readonly string Lapsed = AppStrings.ApprovalsWindow_Lapsed_1, ConnectFailed = Approvals.ConnectFailed, Blocked_ = AppStrings.ApprovalsWindow_Blocked__1,
        DropAsk = AppStrings.ApprovalsWindow_DropAsk_1, DropFailed = AppStrings.ApprovalsWindow_DropFailed_1;
    internal async Task OpenLinkAsync() { linkOpen = true; connect = new("idle"); Paint(); await ReadConnectionAsync(); }

    internal async Task ReadConnectionAsync()
    {
        if (run is not { } source) return; var mine = ++connectToken;
        var reply = await Api.ApprovalConnectionAsync(source.Token);
        if (!Running || mine != connectToken) return;
        var state = reply.Ok ? reply.Connection?.State : null;
        linkState = state is null ? null : state == "connected" ? "connected" : "not_connected";   // unreadable (also a removed route) is "not read", never a failure screen
        if (state == "waiting") { connect = new("waiting", state); _ = WatchAsync(mine, 2000); }
        Paint();
    }
    private void Settle(Connect next) { connectToken++; connect = next; Paint(); }
    private async Task WatchAsync(int mine, int ms)
    {
        var poll = 0;
        while (Running && mine == connectToken)
        {
            try { await Task.Delay(ms, run!.Token); } catch (OperationCanceledException) { return; }
            var reply = await Api.ApprovalConnectionAsync(run!.Token);
            if (!Running || mine != connectToken) return;
            var state = reply.Ok ? reply.Connection?.State : null;
            if (state == "connected") { linkState = "connected"; Settle(new("idle")); hub.ReadLinks(); return; }
            if (state == "denied") { Settle(new("denied", state)); return; }
            if (state is "not_connected" or "expired") { linkState = "not_connected"; Settle(new("idle", state, Lapsed)); return; }
            ms = state == "waiting" ? 2000 : Approvals.BackoffMs(poll++);   // an unreadable answer is watched on, never given up
        }
    }
    internal async Task StartConnectAsync()
    {
        if (run is not { } source || connect.Phase == "opening") return; var mine = ++connectToken;
        connect = new("opening", connect.Server); Paint();
        var reply = await Api.ApprovalConnectAsync(source.Token);
        if (!Running || mine != connectToken) return;
        var url = reply.Start?.AuthorizationUrl;
        if (reply.Ok && url is not null && url.StartsWith("https://", StringComparison.Ordinal))
        {
            var opened = OpenUrl(url);
            connect = new("waiting", "waiting", opened ? "" : Blocked_); Paint(); _ = WatchAsync(mine, 2000);
        }
        else Settle(new("idle", null, ConnectFailed));
    }
    internal Func<string, bool> OpenUrl { get; set; } = url => { try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); return true; } catch (Exception) { return false; } };
    private async Task StopConnectAsync()
    {
        Settle(new("idle")); if (run is { } source) await Api.ApprovalStopConnectAsync(source.Token);
        if (Running) await ReadConnectionAsync();
    }
    private async Task DisconnectAsync()
    {
        if (run is not { } source) return;
        drop = ("busy", null); Paint();
        var reply = await Api.ApprovalDisconnectAsync(source.Token);
        if (!Running) return;
        if (reply.Ok) { drop = null; linkState = "not_connected"; connect = new("idle"); }
        else drop = ("confirm", DropFailed);
        Paint();
    }

    // MARK: drawing

    private void Paint(string? focus = null)
    {
        var keep = focus ?? KeyOf(Keyboard.FocusedElement as DependencyObject);
        var state = Device?.State.Status;
        pill.Visibility = Running && state == RuntimeStatus.Retrying ? Visibility.Visible : Visibility.Collapsed; pillText.Text = Approvals.Reconnect;
        var root = new Grid(); root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto }); root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto }); root.RowDefinitions.Add(new RowDefinition());
        root.Children.Add(Toolbar(Device is not null && !NotJoined));
        var notes = new StackPanel();
        if (bannerText is not null && bannerId == SelectedId && SelectedId is not null) notes.Children.Add(Banner(bannerText));
        if (!NotJoined && DeviceStrip() is { } strip) notes.Children.Add(strip);
        if (notes.Children.Count > 0) { SetRow(notes, 1); root.Children.Add(notes); }
        // The list is the device's book; the device's own states (sign-in, approval, reconnect) are the note above it (DeviceStrip). No device on this PC: the plain state, no failure and no retry.
        FrameworkElement main = NotJoined ? Scroll(new ChildJoinView(Join!), new Thickness(0)) : linkOpen ? LinkPanel() : Device is null ? NotUsable() : Columns(state == RuntimeStatus.Retrying && !DeviceLive);
        SetRow(main, 2); root.Children.Add(main);
        body.Children.Clear(); body.Children.Add(root);
        if (keep is not null) Dispatcher.BeginInvoke(() => Focus(root, keep), System.Windows.Threading.DispatcherPriority.Input);
    }
    private static string? KeyOf(DependencyObject? at)
    {
        for (; at is not null; at = at is Visual ? VisualTreeHelper.GetParent(at) : LogicalTreeHelper.GetParent(at))
            if (System.Windows.Automation.AutomationProperties.GetAutomationId(at) is { Length: > 0 } id && id.StartsWith("ab:", StringComparison.Ordinal)) return id[3..];
        return null;
    }
    private static void Focus(DependencyObject root, string key)
    {
        foreach (var element in Walk(root)) if (element is Control control && System.Windows.Automation.AutomationProperties.GetAutomationId(control) == "ab:" + key) { control.Focus(); return; }
    }
    private static IEnumerable<DependencyObject> Walk(DependencyObject at)
    {
        yield return at;
        foreach (var child in LogicalTreeHelper.GetChildren(at).OfType<DependencyObject>()) foreach (var item in Walk(child)) yield return item;
        if (at is ContentControl { Content: DependencyObject }) yield break;
    }
    private static T Key<T>(T element, string key) where T : DependencyObject { System.Windows.Automation.AutomationProperties.SetAutomationId(element, "ab:" + key); return element; }

    private FrameworkElement NotUsable()
    {
        var notice = (StackPanel)LatticeWindow.Notice(Approvals.NotAvailable, null, null, false);
        var acts = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 18, 0, 0) };
        var close = Action(AppStrings.ApprovalsWindow_NotUsable_1, "", true); close.Click += (_, _) => window.Close(); acts.Children.Add(Key(close, "close-screen"));
        notice.Children.Add(acts); return notice;
    }

    private WrapPanel Toolbar(bool full)
    {
        var bar = new WrapPanel { Margin = new Thickness(18, 14, 18, 10) };
        var counts = Approvals.CountsOf(Device is null ? null : Approvals.SummaryOf(DeviceViews, Now()));
        var title = Row(ApprovalsLook.Glyph("inbox", 18, Violet), Spaced(Text(AppStrings.ApprovalsHub_Paint_1, 20, Ink, FontWeights.Bold), 9));
        if (counts.Pending > 0) title.Children.Add(Spaced(Pill(Text(counts.Pending.ToString(), 13, Colors.White, FontWeights.Bold), Violet, 0xFF, new Thickness(9, 1, 9, 1)), 10));
        bar.Children.Add(Glass(title, 14, new Thickness(14, 8, 16, 8), 0xB3));
        if (!full) return bar;
        var live = DeviceLive;
        var dot = new System.Windows.Shapes.Ellipse { Width = 8, Height = 8, Fill = Brush(live ? Color.FromRgb(0x2E, 0xB3, 0x9E) : Muted) };
        var livePill = Pill(Row(dot, Spaced(Text(live ? AppStrings.ApprovalsWindow_Toolbar_2 : AppStrings.ApprovalsWindow_Toolbar_3, 12, live ? ApprovalsLook.Tone("ok") : Muted, FontWeights.SemiBold), 6)), live ? Color.FromRgb(0x2E, 0xB3, 0x9E) : Muted, 0x1F);
        livePill.Margin = new Thickness(14, 0, 0, 0); bar.Children.Add(livePill);
        Button Segment(string label, Tab tab, string? count)
        {
            var on = Current == tab; var row = Row(Text(label, 12.5, on ? Ink : Muted, on ? FontWeights.SemiBold : FontWeights.Normal));
            if (count is not null) row.Children.Add(Spaced(Text(count, 11.5, Muted), 6));
            var face = new Border { Child = row, CornerRadius = new CornerRadius(8), Padding = new Thickness(14, 5, 14, 5), Background = on ? Brush(Colors.White) : Brushes.Transparent };
            var button = Plain(face, $"{label}{(count is not null ? " " + count : "")}{(on ? AppStrings.ApprovalsWindow_Toolbar_4 : AppStrings.ApprovalsWindow_Toolbar_5)}"); button.Click += (_, _) => SetTab(tab);
            return Key(button, "tab:" + tab);
        }
        var held = pending.Count(item => item.Status == "held"); var waiting = pending.Count(item => item.Status == "pending");
        var seg = new Border { Child = Row(Segment(AppStrings.ApprovalsWindow_Toolbar_8, Tab.Pending, waiting.ToString()), Segment(AppStrings.ApprovalsWindow_Toolbar_9, Tab.Held, held.ToString()), Segment(AppStrings.ApprovalsWindow_Toolbar_10, Tab.Done, done.Count.ToString())),
            CornerRadius = new CornerRadius(10), Padding = new Thickness(3), Background = Brush(Muted, 0x1F), Margin = new Thickness(14, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
        bar.Children.Add(seg);
        var ring = Row(new LatticeRing(counts.Answered, Math.Max(counts.Filed, counts.Answered), 40, false), Spaced(new StackPanel { Children = { Text(AppStrings.ApprovalsWindow_Toolbar_11, 11, Muted), Text($"{counts.Answered} / {counts.Filed}", 14, Ink, FontWeights.SemiBold) }, VerticalAlignment = VerticalAlignment.Center }, 8),
            Counter(AppStrings.ApprovalsWindow_Toolbar_8, counts.Pending, Violet, 22), Counter(AppStrings.ApprovalsWindow_Toolbar_13, counts.Urgent, Amber, 8), Counter(AppStrings.ApprovalsWindow_Toolbar_9, counts.Held, Muted, 8));
        ring.Margin = new Thickness(26, 2, 0, 2); bar.Children.Add(ring);
        var reload = Action(AppStrings.ApprovalsWindow_Toolbar_15, ""); reload.Margin = new Thickness(18, 0, 0, 0); reload.Click += (_, _) => Reload(); Key(reload, "reload"); bar.Children.Add(reload);
        var link = Action(AppStrings.ApprovalsWindow_Toolbar_16, ""); link.Margin = new Thickness(8, 0, 0, 0); link.Click += (_, _) => _ = OpenLinkAsync(); Key(link, "link"); bar.Children.Add(link);
        return bar;
    }
    private static Border Counter(string label, int count, Color color, double left)
    {
        var pill = Pill(Row(Text(label, 12.5, Ink), Spaced(Text(count.ToString(), 14, color, FontWeights.Bold), 6)), Colors.White, 0xB3, new Thickness(12, 6, 13, 6));
        pill.BorderBrush = Brush(Colors.White); pill.BorderThickness = new Thickness(1); pill.Margin = new Thickness(left, 0, 0, 0);
        System.Windows.Automation.AutomationProperties.SetName(pill, $"{label} {count}"); return pill;
    }
    // What the device says when it is not fine; the list stays as long as a decision is held.
    private FrameworkElement? DeviceStrip()
    {
        var panel = new StackPanel(); var n = 0;
        void Line(string text, string? label = null, Action? act = null, string? label2 = null, Action? act2 = null)
        {
            var row = Row(ApprovalsLook.Glyph("info", 16, Muted), Spaced(Text(text, 13, Ink, FontWeights.SemiBold, TextWrapping.Wrap), 10));
            if (label is not null && act is not null) { var button = Action(label, ""); button.Margin = new Thickness(12, 0, 0, 0); button.Click += (_, _) => act(); row.Children.Add(Key(button, "legacy:" + label)); }
            if (label2 is not null && act2 is not null) { var button = Action(label2, ""); button.Margin = new Thickness(8, 0, 0, 0); button.Click += (_, _) => act2(); row.Children.Add(Key(button, "legacy:" + label2)); }
            var border = new Border { Child = row, CornerRadius = new CornerRadius(14), Padding = new Thickness(16, 8, 16, 8), Margin = new Thickness(18, 0, 18, 8), Background = Brush(Muted, 0x14), BorderBrush = Brush(Muted, 0x44), BorderThickness = new Thickness(1) };
            System.Windows.Automation.AutomationProperties.SetAutomationId(border, "approvals-device-note-" + n++); panel.Children.Add(border);
        }
        void Waiting(ApprovalOffer offer)
        {
            var code = Text(offer.Code, 22, Ink, FontWeights.Bold); code.FontFamily = new FontFamily("Consolas");
            var info = new StackPanel { VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(18, 0, 0, 0), MaxWidth = 380 };
            info.Children.Add(code);
            info.Children.Add(Text(Approvals.DeviceApprovalHow, 13, Ink, FontWeights.SemiBold, TextWrapping.Wrap));
            info.Children.Add(Text(Approvals.DeviceApprovalLeft(offer.ExpiresAt - Now()), 12, Muted));
            var stop = Action(AppStrings.ApprovalsWindow_DeviceStrip_1, ""); stop.HorizontalAlignment = HorizontalAlignment.Left; stop.Margin = new Thickness(0, 10, 0, 0); stop.Click += (_, _) => hub.CancelApproval?.Invoke(); info.Children.Add(Key(stop, AppStrings.ApprovalsWindow_DeviceStrip_2));
            var border = new Border { Child = Row(new QrView(offer.Qr, 150), info), CornerRadius = new CornerRadius(14), Padding = new Thickness(16), Margin = new Thickness(18, 0, 18, 8), Background = Brush(Muted, 0x14), BorderBrush = Brush(Muted, 0x44), BorderThickness = new Thickness(1) };
            System.Windows.Automation.AutomationProperties.SetAutomationId(border, "approvals-device-waiting"); panel.Children.Add(border);
        }
        // The component's own states (child-join.md): a credential that is gone moves the join itself to NotJoined (the join screen), so no sign-in line is drawn here. NeedsAdmission is the peer channel's own admission (a verified device admits this one).
        if (Join is { UpdateRequired: true }) Line(ChildJoinText.UpdateRequired, ChildJoinText.Retry, () => Device?.Refresh());
        else if (Device is { } device)
            switch (device.State.Status)
            {
                case RuntimeStatus.Connecting: Line(ChildJoinText.Joining); break;
                case RuntimeStatus.Retrying: Line(ChildJoinText.Reconnecting, ChildJoinText.Retry, device.Refresh); break;
                case RuntimeStatus.NeedsAdmission when hub.Offer is { } offer: Waiting(offer); break;
                case RuntimeStatus.NeedsAdmission:
                    if (hub.OfferNote is { } ended) Line(ended);
                    Line(device.State.Reason == "removed" ? Approvals.DeviceRemoved : Approvals.DeviceNeedsApproval, hub.RequestApproval is null ? null : hub.OfferNote is null ? Approvals.DeviceAskApproval : AppStrings.ApprovalsWindow_DeviceStrip_3, () => hub.RequestApproval?.Invoke());
                    break;
                case RuntimeStatus.NotEntitled: Line(ChildJoinText.NotEntitled, ChildJoinText.Recheck, device.Refresh); break;
                case RuntimeStatus.UpdateRequired: Line(ChildJoinText.UpdateRequired, ChildJoinText.Retry, device.Refresh); break;
            }
        return panel.Children.Count > 0 ? panel : null;
    }
    private Border Banner(string text)
    {
        var line = Row(ApprovalsLook.Glyph("info", 16, Violet), Spaced(Text(text, 14, Ink, FontWeights.SemiBold, TextWrapping.Wrap), 10));
        var border = new Border { Child = line, CornerRadius = new CornerRadius(14), Padding = new Thickness(16, 10, 16, 10), Margin = new Thickness(18, 0, 18, 10), Background = Brush(Violet, 0x1A), BorderBrush = Brush(Violet, 0x55), BorderThickness = new Thickness(1) };
        System.Windows.Automation.AutomationProperties.SetAutomationId(border, "approvals-banner"); SetRow(border, 1); return border;
    }

    // 工程表との連携: one connect and one disconnect; the state is read from GET /api/approvals/connection. The browser shows Approval Box's own consent page, never BellTeam's.
    private FrameworkElement LinkPanel()
    {
        var phase = connect.Phase;
        var text = phase is "opening" or "waiting" ? Approvals.Waiting : phase == "denied" ? Approvals.Denied : drop is { Step: "confirm" } ask ? ask.Note ?? DropAsk
            : linkState switch { "connected" => AppStrings.ApprovalsWindow_LinkPanel_1, "not_connected" => AppStrings.ApprovalsWindow_LinkPanel_2, _ => AppStrings.ApprovalsWindow_LinkPanel_3 };
        var stack = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, MaxWidth = 480, Margin = new Thickness(24, 60, 24, 24) };
        stack.Children.Add(new LatticeBud { Margin = new Thickness(0, 0, 0, 18), HorizontalAlignment = HorizontalAlignment.Center });
        var head = Text(AppStrings.ApprovalsWindow_Toolbar_16, 16, Ink, FontWeights.Bold); head.TextAlignment = TextAlignment.Center; stack.Children.Add(head);
        var main = Text(text, 18, Ink, FontWeights.SemiBold, TextWrapping.Wrap); main.TextAlignment = TextAlignment.Center; main.Margin = new Thickness(0, 8, 0, 0); System.Windows.Automation.AutomationProperties.SetAutomationId(main, "approvals-connect-text"); stack.Children.Add(main);
        if (phase is "opening" or "waiting" || drop is { Step: "busy" }) { var spin = Spinner(18); spin.Margin = new Thickness(0, 16, 0, 0); spin.HorizontalAlignment = HorizontalAlignment.Center; stack.Children.Add(spin); }
        var acts = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 18, 0, 0) };
        Button Act(string label, Action run, bool primary = false, string? key = null) { var button = Action(label, "", primary); button.Click += (_, _) => run(); return Key(button, key ?? label); }
        if (phase == "waiting") { acts.Children.Add(Act(AppStrings.ApprovalsWindow_LinkPanel_5, () => _ = StartConnectAsync(), true, "connect:again")); acts.Children.Add(Act(AppStrings.ApprovalsWindow_DeviceStrip_1, () => _ = StopConnectAsync(), key: "connect:cancel")); }
        else if (phase == "denied") acts.Children.Add(Act(AppStrings.ApprovalsWindow_LinkPanel_7, () => _ = StartConnectAsync(), true, "connect:retry"));
        else if (drop is { Step: "confirm" }) { acts.Children.Add(Act(AppStrings.ApprovalsWindow_LinkPanel_8, () => _ = DisconnectAsync(), true, "unlink-yes")); acts.Children.Add(Act(AppStrings.ApprovalsWindow_DeviceStrip_1, () => { drop = null; Paint(); }, key: "unlink-no")); }
        else if (phase == "idle" && drop is null)
        {
            if (linkState == "connected") acts.Children.Add(Act(AppStrings.ApprovalsWindow_LinkPanel_10, () => { drop = ("confirm", null); Paint("unlink-no"); }, key: "unlink"));
            else if (linkState == "not_connected") acts.Children.Add(Act(AppStrings.ApprovalsWindow_LinkPanel_11, () => _ = StartConnectAsync(), true, "connect:go"));
            else acts.Children.Add(Act(AppStrings.ApprovalsWindow_Toolbar_15, () => _ = ReadConnectionAsync(), true, "connect:reload"));
        }
        if (phase != "opening" && drop is not { Step: "busy" }) acts.Children.Add(Act(AppStrings.ApprovalsWindow_LinkPanel_13, () => { linkOpen = false; drop = null; connect = new("idle"); Paint(); }, key: "connect:back"));
        stack.Children.Add(acts);
        if (Join is { Phase: ChildJoinPhase.Joined } joined) stack.Children.Add(JoinBlock(joined));
        if (connect.Note.Length > 0) { var note = Text(connect.Note, 13, Red, FontWeights.SemiBold, TextWrapping.Wrap); note.Margin = new Thickness(0, 12, 0, 0); note.TextAlignment = TextAlignment.Center; System.Windows.Automation.AutomationProperties.SetAutomationId(note, "approvals-connect-note"); stack.Children.Add(note); }
        return Scroll(stack, new Thickness(0));
    }

    // This device's join state (child-join.md): 「決裁箱につながっています」 and the two-step 「つなぎを外す」 (外す / やめる). Leaving removes this device from the account and never touches BellTeam's own sign-in.
    private FrameworkElement JoinBlock(IChildJoin join)
    {
        var block = new StackPanel { Margin = new Thickness(0, 30, 0, 0), HorizontalAlignment = HorizontalAlignment.Center, MaxWidth = 480 };
        block.Children.Add(new Border { Height = 1, Background = Brush(Muted, 0x33), Margin = new Thickness(0, 0, 0, 20) });
        var line = Text(ChildJoinText.Joined, 16, Ink, FontWeights.Bold); line.TextAlignment = TextAlignment.Center; System.Windows.Automation.AutomationProperties.SetAutomationId(line, "child-join-joined"); block.Children.Add(line);
        var acts = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 14, 0, 0) };
        if (leaveStep == "busy") { var spin = Spinner(16); spin.HorizontalAlignment = HorizontalAlignment.Center; acts.Children.Add(spin); }
        else if (leaveStep == "confirm")
        {
            var yes = Action(ChildJoinText.LeaveYes, "", true); yes.Click += (_, _) => _ = LeaveAsync(join); acts.Children.Add(Key(yes, "child-leave-yes"));
            var no = Action(ChildJoinText.LeaveNo, ""); no.Margin = new Thickness(8, 0, 0, 0); no.Click += (_, _) => { leaveStep = null; Paint(); }; acts.Children.Add(Key(no, "child-leave-no"));
        }
        else { var leave = Action(ChildJoinText.Leave, ""); System.Windows.Automation.AutomationProperties.SetName(leave, AppStrings.ApprovalsWindow_JoinBlock_1(ChildJoinText.Leave)); leave.Click += (_, _) => { leaveStep = "confirm"; Paint("child-leave-no"); }; acts.Children.Add(Key(leave, "child-leave")); }
        block.Children.Add(acts); return block;
    }
    private async Task LeaveAsync(IChildJoin join)
    {
        leaveStep = "busy"; Paint();
        try { await join.LeaveAsync(); } finally { leaveStep = null; if (Running) Paint(); }
    }

    private Grid Columns(bool dim)
    {
        var grid = new Grid { Opacity = dim ? .5 : 1 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(500) }); grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(520) }); grid.ColumnDefinitions.Add(new ColumnDefinition { MinWidth = 340 });
        var list = ListColumn(); var detail = DetailColumn(); var links = LinksColumn();
        SetColumn(detail, 1); SetColumn(links, 2); grid.Children.Add(list); grid.Children.Add(detail); grid.Children.Add(links);
        return grid;
    }
    private static ScrollViewer Scroll(UIElement content, Thickness margin) => new() { Content = content, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, PanningMode = PanningMode.VerticalOnly, Margin = margin };

    // ---- 一覧
    private FrameworkElement ListColumn()
    {
        var stack = new StackPanel { Margin = new Thickness(0, 0, 8, 16) };
        var heading = Current switch { Tab.Pending => AppStrings.ApprovalsWindow_ListColumn_1, Tab.Held => AppStrings.ApprovalsWindow_ListColumn_2, _ => AppStrings.ApprovalsWindow_ListColumn_3 };
        var head = Row(Text(heading, 15, Ink, FontWeights.Bold)); if (Current == Tab.Pending) head.Children.Add(Spaced(Text(AppStrings.ApprovalsWindow_ListColumn_4, 11.5, Muted), 10)); head.Margin = new Thickness(6, 0, 0, 10); stack.Children.Add(head);
        var baseItems = Current == Tab.Done ? done : pending.Where(item => item.Status == (Current == Tab.Pending ? "pending" : "held")).ToList();
        var chips = Approvals.OriginCounts(baseItems); var shown = Approvals.OriginFilter(baseItems, Origin); var hidden = chips.All - shown.Count;
        Button Chip(string value, string label, int count)
        {
            var on = Origin == value; var face = new Border { Child = Row(Text(label, 12, on ? Colors.White : Ink, FontWeights.SemiBold), Spaced(Text(count.ToString(), 11.5, on ? Colors.White : Muted), 6)), CornerRadius = new CornerRadius(99), Padding = new Thickness(11, 4, 11, 4), Background = on ? Brush(Violet) : Brush(Muted, 0x1F), Margin = new Thickness(0, 0, 6, 0) };
            var button = Plain(face, AppStrings.ApprovalsWindow_ListColumn_6(label, count, (on ? AppStrings.ApprovalsWindow_ListColumn_5 : ""))); button.Click += (_, _) => SetOrigin(value); return Key(button, "origin:" + value);
        }
        var filter = new WrapPanel { Margin = new Thickness(4, 0, 0, 10) };
        filter.Children.Add(Spaced(Text(AppStrings.ApprovalsWindow_ListColumn_7, 11.5, Muted), 0)); ((TextBlock)filter.Children[0]).Margin = new Thickness(2, 0, 8, 0);
        filter.Children.Add(Chip("all", AppStrings.ApprovalsWindow_ListColumn_8, chips.All)); filter.Children.Add(Chip("bellteam", "BellTeam", chips.Bellteam)); filter.Children.Add(Chip("external", AppStrings.ApprovalsWindow_ListColumn_9, chips.External)); stack.Children.Add(filter);
        if (hidden > 0)
        {
            var line = Row(ApprovalsLook.Glyph("info", 14, Amber), Spaced(Text(AppStrings.ApprovalsWindow_ListColumn_11((Origin == "bellteam" ? AppStrings.ApprovalsWindow_ListColumn_9 : "BellTeam"), hidden), 12.5, Amber, FontWeights.SemiBold), 8));
            var all = Action(AppStrings.ApprovalsWindow_ListColumn_12, ""); all.Margin = new Thickness(10, 0, 0, 0); all.Click += (_, _) => SetOrigin("all"); line.Children.Add(Key(all, "show-all")); line.Margin = new Thickness(6, 0, 0, 10); stack.Children.Add(line);
        }
        if (Current == Tab.Done) DoneRows(stack, shown);
        else if (shown.Count == 0)
        {
            var none = Text(baseItems.Count > 0 ? AppStrings.ApprovalsWindow_ListColumn_13 : Current == Tab.Held ? Approvals.EmptyHeld : Approvals.EmptyPending, 14, Muted, null, TextWrapping.Wrap); none.Margin = new Thickness(8, 6, 8, 10); System.Windows.Automation.AutomationProperties.SetAutomationId(none, "approvals-none"); stack.Children.Add(none);
            if (Current == Tab.Pending && baseItems.Count == 0) { var see = Action(AppStrings.ApprovalsWindow_ListColumn_14, ""); see.HorizontalAlignment = HorizontalAlignment.Left; see.Margin = new Thickness(6, 0, 0, 0); see.Click += (_, _) => SetTab(Tab.Done); stack.Children.Add(Key(see, "see-done")); }
        }
        else
        {
            foreach (var item in shown) stack.Children.Add(Card(item));
            if (Current == Tab.Pending && Approvals.OriginFilter(pending.Where(item => item.Status == "held").ToList(), Origin) is { Count: > 0 } held)
            {
                var divider = Row(ApprovalsLook.Glyph("pause", 13, Muted), Spaced(Text(AppStrings.ApprovalsWindow_ListColumn_15(held.Count), 12.5, Muted, FontWeights.SemiBold), 6)); divider.Margin = new Thickness(6, 14, 0, 8); stack.Children.Add(divider);
                foreach (var item in held) stack.Children.Add(Card(item));
            }
        }
        return Scroll(stack, new Thickness(18, 4, 4, 0));
    }
    private FrameworkElement Card(ViewDecision decision)
    {
        var row = Approvals.CardRow(decision, Now()); var held = decision.Status == "held"; var selected = SelectedId == decision.Id;
        var top = new WrapPanel(); foreach (var badge in row.Badges) top.Children.Add(ApprovalsLook.Badge(badge));
        top.Children.Add(Text(row.Age, 11.5, Muted));
        var who = Row(ApprovalsLook.Origin(row.Origin, 22, PersonOf, Avatar), Spaced(Text(NameOf(row.Origin), 12.5, Ink), 8)); who.Margin = new Thickness(0, 8, 0, 0);
        var title = Text(row.Title, 15.5, Ink, FontWeights.Bold, TextWrapping.Wrap); title.Margin = new Thickness(0, 8, 0, 0); title.MaxHeight = 15.5 * 1.34 * 2; title.TextTrimming = TextTrimming.CharacterEllipsis;
        var noteColor = row.Note.Tone == "link" ? Violet : Muted;
        var note = Row(ApprovalsLook.Glyph("link", 13, noteColor), Spaced(Text(row.Note.Text, 12.5, noteColor, null, TextWrapping.Wrap), 6)); note.Margin = new Thickness(0, 8, 0, 0);
        var stack = new StackPanel { Children = { top, who, title, note } };
        if (row.Chips.Count > 0) { var chips = new WrapPanel { Margin = new Thickness(0, 8, 0, 0) }; foreach (var chip in row.Chips) chips.Children.Add(Pill(Text(chip, 11.5, Slate), Slate, 0x14, new Thickness(8, 2, 8, 2))); chips.Children.OfType<Border>().ToList().ForEach(c => c.Margin = new Thickness(0, 0, 6, 0)); stack.Children.Add(chips); }
        var frame = new Border { Child = stack, CornerRadius = new CornerRadius(18), Padding = new Thickness(16, 12, 14, 12), Margin = new Thickness(0, 0, 0, 10),
            Background = Brush(held ? Muted : Colors.White, held ? (byte)0x14 : (byte)0xE6), BorderBrush = held ? Brush(Muted, 0x66) : selected || decision.Status == "pending" ? Brush(Violet, selected ? (byte)0xFF : (byte)0x80) : Brush(Colors.White), BorderThickness = new Thickness(selected ? 2 : 1.4) };
        if (row.Urgent) frame.BorderThickness = new Thickness(selected ? 2 : 1.4);
        if (decision.Status == "pending") frame.Effect = new System.Windows.Media.Effects.DropShadowEffect { Color = Violet, Opacity = selected ? .28 : .14, BlurRadius = 18, ShadowDepth = 0 };
        if (row.Urgent) { var ribbon = new Border { Width = 5, Background = Brush(Amber), CornerRadius = new CornerRadius(18, 0, 0, 18), HorizontalAlignment = HorizontalAlignment.Left }; var layered = new Grid(); layered.Children.Add(frame); layered.Children.Add(ribbon); ribbon.Margin = new Thickness(0, 10, 0, 20); ribbon.CornerRadius = new CornerRadius(3); ribbon.Margin = new Thickness(1, 14, 0, 24); return Open(layered, row.Label, decision.Id!); }
        return Open(frame, row.Label, decision.Id!);
    }
    private Button Open(UIElement content, string label, string id) { var button = Plain(content, label); button.HorizontalContentAlignment = HorizontalAlignment.Stretch; button.Click += (_, _) => Select(id); return Key(button, "c:" + id); }
    private void DoneRows(StackPanel stack, IReadOnlyList<ViewDecision> shown)
    {
        var groups = Approvals.GroupDone(shown, Now());
        if (groups.Count == 0) { var none = Text(Approvals.EmptyDone, 14, Muted); none.Margin = new Thickness(8, 6, 8, 10); System.Windows.Automation.AutomationProperties.SetAutomationId(none, "approvals-none"); stack.Children.Add(none); }
        foreach (var group in groups)
        {
            var heading = Text(group.Heading, 12.5, Muted, FontWeights.SemiBold); heading.Margin = new Thickness(6, 10, 0, 8); stack.Children.Add(heading);
            foreach (var row in group.Rows)
            {
                var selected = SelectedId == row.Id; var dock = new DockPanel();
                var time = Text(row.Time, 12, Muted); time.Margin = new Thickness(10, 0, 0, 0); DockPanel.SetDock(time, Dock.Right); dock.Children.Add(time);
                if (row.Delivery is { } delivery) { var badge = ApprovalsLook.Badge(delivery); DockPanel.SetDock(badge, Dock.Right); dock.Children.Add(badge); }
                var glyph = ApprovalsLook.Glyph(row.Cancelled ? "xmark" : "seal", 16, row.Cancelled ? Muted : ApprovalsLook.Tone("ok")); glyph.Margin = new Thickness(0, 0, 10, 0); DockPanel.SetDock(glyph, Dock.Left); dock.Children.Add(glyph);
                var title = Text(row.Title, 13.5, row.Cancelled ? Muted : Ink, FontWeights.SemiBold); if (row.Cancelled) title.TextDecorations = TextDecorations.Strikethrough;
                var line = string.Join(AppStrings.ApprovalsWindow_DoneRows_1, new[] { row.Line, row.Origin.External ? AppStrings.ApprovalsWindow_DoneRows_2 : null }.OfType<string>().Where(part => part.Length > 0));
                dock.Children.Add(new StackPanel { Children = { title, Text(line, 11.5, Muted) }, VerticalAlignment = VerticalAlignment.Center });
                var frame = new Border { Child = dock, CornerRadius = new CornerRadius(12), Padding = new Thickness(12, 8, 12, 8), Margin = new Thickness(0, 0, 0, 6), Background = Brush(Colors.White, 0xD9), BorderBrush = selected ? Brush(Violet) : Brush(Line), BorderThickness = new Thickness(selected ? 2 : 1) };
                stack.Children.Add(Open(frame, AppStrings.ApprovalsWindow_DoneRows_3(row.Title, line), row.Id));
            }
        }
    }

    // ---- 詳細
    private FrameworkElement DetailColumn()
    {
        var decision = SelectedId is { } id ? Known(id) : null;
        var stack = new StackPanel { Margin = new Thickness(20, 16, 18, 18) };
        if (decision is null)
        {
            var empty = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 120, 0, 0) };
            empty.Children.Add(ApprovalsLook.Glyph("inbox", 40, Muted)); var text = Text(SelectedId is not null ? Approvals.Loading : AppStrings.ApprovalsWindow_DetailColumn_1, 14, Muted); text.Margin = new Thickness(0, 12, 0, 0); empty.Children.Add(text);
            System.Windows.Automation.AutomationProperties.SetAutomationId(text, "approvals-detail-empty");
            return Wrap(empty);
        }
        if (answer is { } a && a.Id == decision.Id && a.Version != decision.Version) { bannerId = decision.Id; bannerText = Approvals.Amended(Approvals.OriginOf(decision).Who); answer = null; }
        var origin = Approvals.OriginOf(decision); var open = decision.Status is "pending" or "held";
        var head = new DockPanel();
        var close = Action("", ""); close.Content = ApprovalsLook.Glyph("xmark", 14, Ink); close.Padding = new Thickness(8); close.Margin = new Thickness(8, 0, 0, 0); DockPanel.SetDock(close, Dock.Right); close.Click += (_, _) => { SelectedId = null; answer = null; Paint(); };
        System.Windows.Automation.AutomationProperties.SetName(close, AppStrings.ApprovalsWindow_DetailColumn_2); head.Children.Add(Key(close, "close"));
        var badges = new WrapPanel(); foreach (var badge in Approvals.BadgesOf(decision)) badges.Children.Add(ApprovalsLook.Badge(badge)); head.Children.Add(badges); stack.Children.Add(head);
        var title = Text(decision.Title ?? "", 21, Ink, FontWeights.Bold, TextWrapping.Wrap); title.Margin = new Thickness(0, 10, 0, 8); stack.Children.Add(title);
        var sub = new WrapPanel { Margin = new Thickness(0, 0, 0, 6) };
        sub.Children.Add(Row(ApprovalsLook.Origin(origin, 20, PersonOf, Avatar), Spaced(Text(NameOf(origin), 13.5, Ink, FontWeights.SemiBold), 8)));
        var facts = AppStrings.ApprovalsWindow_DetailColumn_5((origin.Member is not null && origin.Session.Length > 0 ? AppStrings.ApprovalsWindow_DetailColumn_3(origin.Session) : ""), Approvals.Clock(decision.CreatedAt), (open && decision.Deadline is not null ? AppStrings.ApprovalsWindow_DetailColumn_4(LatticeStops.StopTime(decision.Deadline, Now())) : ""));
        sub.Children.Add(Spaced(Text(facts, 12.5, Muted), 10)); stack.Children.Add(sub);
        if (origin.External)
        {
            var info = Row(ApprovalsLook.Origin(origin, 40, PersonOf, Avatar), Spaced(new StackPanel { Children = { Text(AppStrings.ApprovalsWindow_DetailColumn_6, 13.5, Ink, FontWeights.Bold),
                Text(string.Join(" · ", new[] { origin.Tool, origin.Via, origin.Session.Length > 0 ? AppStrings.ApprovalsWindow_DetailColumn_7(origin.Session) : "" }.Where(part => part.Length > 0)), 12, Muted) }, VerticalAlignment = VerticalAlignment.Center }, 12));
            var card = new Border { Child = info, CornerRadius = new CornerRadius(14), Padding = new Thickness(12), Margin = new Thickness(0, 6, 0, 6), Background = Brush(Muted, 0x12), BorderBrush = Brush(Line), BorderThickness = new Thickness(1) };
            System.Windows.Automation.AutomationProperties.SetAutomationId(card, "approvals-outside"); stack.Children.Add(card);
        }
        if (decision.Context is { Length: > 0 } context) { Section(stack, "doc", AppStrings.ApprovalsWindow_DetailColumn_8); stack.Children.Add(Linkified(context)); }
        Attachments(stack, decision);
        if (open && decision.Options?.FirstOrDefault(option => option.Recommended) is { } rec)
        { var line = Row(ApprovalsLook.Glyph("check", 14, Violet), Spaced(Text(AppStrings.ApprovalsWindow_DetailColumn_9(origin.Who, rec.Label), 13, Violet, FontWeights.SemiBold), 8)); line.Margin = new Thickness(0, 14, 0, 0); stack.Children.Add(line); }
        if (open) AnswerArea(stack, decision, origin); else Answered(stack, decision, origin);
        if (open)
        {
            var acts = new WrapPanel { Margin = new Thickness(0, 16, 0, 0) };
            { var hold = Action(decision.Status == "held" ? AppStrings.ApprovalsWindow_DetailColumn_10 : AppStrings.ApprovalsWindow_DetailColumn_11, ""); hold.Click += (_, _) => _ = HoldAsync(decision); acts.Children.Add(Key(hold, "hold")); }
            if (Approvals.LinkPanel(decision).Ids is { } ids) { var chart = Action(AppStrings.ApprovalsWindow_DetailColumn_12, ""); chart.Click += (_, _) => hub.OpenChart?.Invoke(ids.ProjectId, ids.CardId); acts.Children.Add(Key(chart, "chart")); }
            stack.Children.Add(acts);
            if (holdNotes.GetValueOrDefault(decision.Id!) is { } holdNote) stack.Children.Add(FailLine(holdNote, "approvals-hold-note"));
        }
        var rows = Approvals.HistoryRows(decision, Now());
        if (rows.Count > 0)
        {
            Section(stack, "hour", AppStrings.ApprovalsWindow_DetailColumn_13);
            foreach (var item in rows)
            {
                var line = Row(Text(item.Time, 12, Muted), Spaced(Text(item.Text, 13, Ink), 10)); if (item.Amended) line.Children.Add(Spaced(ApprovalsLook.Badge(new ApprovalBadge(AppStrings.ApprovalsWindow_DetailColumn_14, "ind", "pencil")), 8)); line.Margin = new Thickness(0, 0, 0, 5); stack.Children.Add(line);
            }
        }
        return Wrap(stack);
        static FrameworkElement Wrap(UIElement content) { var panel = Glass(Scroll(content, new Thickness(0)), 22, new Thickness(0), 0xFA); panel.Margin = new Thickness(4, 4, 6, 16); System.Windows.Automation.AutomationProperties.SetAutomationId(panel, "approvals-detail"); return panel; }
    }
    private static void Section(StackPanel stack, string glyph, string label)
    {
        var heading = Row(ApprovalsLook.Glyph(glyph, 14, Muted), Spaced(Text(label, 12, Muted, FontWeights.SemiBold), 6)); heading.Margin = new Thickness(0, 18, 0, 6); stack.Children.Add(heading);
    }
    private static TextBlock FailLine(string text, string id)
    {
        var line = Text(text, 13, Red, FontWeights.SemiBold, TextWrapping.Wrap); line.Margin = new Thickness(0, 10, 0, 0); System.Windows.Automation.AutomationProperties.SetAutomationId(line, id); return line;
    }
    private static TextBlock Linkified(string text)
    {
        var block = new TextBlock { FontSize = 14, Foreground = Brush(Ink), TextWrapping = TextWrapping.Wrap };
        var at = 0;
        foreach (Match match in Regex.Matches(text, @"https://[^\s<>""]+"))
        {
            if (match.Index > at) block.Inlines.Add(new System.Windows.Documents.Run(text[at..match.Index]));
            var url = match.Value; var link = new System.Windows.Documents.Hyperlink(new System.Windows.Documents.Run(url)) { Foreground = Brush(Violet) };
            link.Click += (_, _) => { try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch (Exception) { } };
            block.Inlines.Add(link); at = match.Index + match.Length;
        }
        if (at < text.Length) block.Inlines.Add(new System.Windows.Documents.Run(text[at..]));
        return block;
    }

    private void Attachments(StackPanel stack, ViewDecision decision)
    {
        if (decision.RequestAttachments is not { Length: > 0 } list) return;
        Section(stack, "image", AppStrings.ApprovalsWindow_Attachments_1(list.Length));
        var wrap = new WrapPanel();
        foreach (var item in list)
        {
            var tile = new Border { Width = 96, Height = 72, CornerRadius = new CornerRadius(10), Background = Brush(Muted, 0x1A), Margin = new Thickness(0, 0, 8, 8), Child = ApprovalsLook.Glyph("image", 22, Muted) };
            var button = Plain(tile, AppStrings.ApprovalsWindow_Attachments_2(item.Name)); var key = $"{decision.Id}/{item.Id}"; var id = decision.Id!; var attachment = item;
            if (!thumbs.TryGetValue(key, out var task)) thumbs[key] = task = ThumbAsync(id, attachment);
            _ = task.ContinueWith(done => { if (done.Result is { } image) Dispatcher.BeginInvoke(() => { tile.Child = new Image { Source = image, Stretch = Stretch.UniformToFill }; button.Click += (_, _) => ShowImage(image, attachment.Name ?? ""); }); }, TaskScheduler.Default);
            wrap.Children.Add(Key(button, "a:" + item.Id));
        }
        stack.Children.Add(wrap);
    }
    // The sender may not be ours: only png/jpeg/gif/webp are drawn, and size and sha256 must match the body (contract: attachments).
    private async Task<BitmapSource?> ThumbAsync(string decisionId, ApprovalAttachment item)
    {
        try
        {
            var bytes = Device is { } device ? await device.AttachmentAsync(decisionId, item.Id ?? "") ?? throw new InvalidOperationException("no image held") : throw new InvalidOperationException("no device");
            if (bytes.Length != item.Size || !string.Equals(Convert.ToHexString(SHA256.HashData(bytes)), item.Sha256, StringComparison.OrdinalIgnoreCase)) return null;
            var image = new BitmapImage(); image.BeginInit(); image.CacheOption = BitmapCacheOption.OnLoad; image.StreamSource = new MemoryStream(bytes); image.EndInit(); image.Freeze(); return image;
        }
        catch (Exception) { return null; }
    }
    private void ShowImage(BitmapSource image, string name)
    {
        var viewer = new Window { Title = name, Width = 960, Height = 720, Owner = window, WindowStartupLocation = WindowStartupLocation.CenterOwner, Content = new Image { Source = image, Stretch = Stretch.Uniform, Margin = new Thickness(12) } };
        viewer.PreviewKeyDown += (_, e) => { if (e.Key == System.Windows.Input.Key.Escape) viewer.Close(); }; viewer.Show();
    }

    private void Answered(StackPanel stack, ViewDecision decision, ApprovalOriginView origin)
    {
        Section(stack, decision.Status == "cancelled" ? "xmark" : "seal", decision.Status == "cancelled" ? AppStrings.ApprovalsWindow_Answered_1 : AppStrings.ApprovalsWindow_Answered_2);
        if (decision.Status == "cancelled") { stack.Children.Add(Text(decision.CancelReason is { Length: > 0 } reason ? AppStrings.ApprovalsWindow_Answered_3(origin.Who, reason) : AppStrings.ApprovalsWindow_Answered_4(origin.Who), 14, Ink, null, TextWrapping.Wrap)); return; }
        stack.Children.Add(Text(Approvals.AnswerText(decision), 14.5, Ink, FontWeights.SemiBold, TextWrapping.Wrap));
        if (decision.Answer?.Attachments is { Length: > 0 } files) { var names = Text(AppStrings.ApprovalsWindow_Answered_6(string.Join(AppStrings.ApprovalsWindow_Answered_5, files.Select(file => file.Name))), 12.5, Muted, null, TextWrapping.Wrap); names.Margin = new Thickness(0, 4, 0, 0); stack.Children.Add(names); }
        var at = Row(); at.Margin = new Thickness(0, 8, 0, 0);
        if (Approvals.DeliveryBadge(decision) is { } badge) at.Children.Add(ApprovalsLook.Badge(badge));
        if (decision.Answer?.AnsweredAt is { } answered) at.Children.Add(Text(LatticeStops.StopTime(answered, Now()), 12, Muted));
        stack.Children.Add(at);
        var note = Approvals.DeliveryNote(decision);
        var color = ApprovalsLook.Tone(note.Tone); var text = Text(note.Text, 13, color, FontWeights.SemiBold, TextWrapping.Wrap); text.Margin = new Thickness(0, 10, 0, 0); System.Windows.Automation.AutomationProperties.SetAutomationId(text, "approvals-delivery"); stack.Children.Add(text);
        if (note.Copy)
        {
            var copy = Action(copied == decision.Id ? AppStrings.ApprovalsWindow_Answered_7 : AppStrings.ApprovalsWindow_Answered_8, ""); copy.Margin = new Thickness(0, 8, 0, 0); copy.HorizontalAlignment = HorizontalAlignment.Left; copy.Click += (_, _) => CopyResume(decision); stack.Children.Add(Key(copy, "copy"));
        }
    }

    // select an option -> the same place becomes the confirm -> 答える (never pre-selected, never sent by Return alone)
    private void AnswerArea(StackPanel stack, ViewDecision decision, ApprovalOriginView origin)
    {
        var mine = answer is { } a && a.Id == decision.Id ? a : null;
        if (mine is { Step: "sending" })
        {
            var sending = Row(Spinner(16), Spaced(Text(AppStrings.ApprovalsWindow_AnswerArea_1, 14, Ink, FontWeights.SemiBold), 10)); sending.Margin = new Thickness(0, 18, 0, 0); System.Windows.Automation.AutomationProperties.SetAutomationId(sending, "approvals-sending"); stack.Children.Add(sending); return;
        }
        if (mine is { Step: "confirm" })
        {
            var box = new StackPanel(); var ask = Text(Approvals.ConfirmText(decision, mine.Label ?? "", mine.Text ?? ""), 14, Ink, FontWeights.SemiBold, TextWrapping.Wrap); System.Windows.Automation.AutomationProperties.SetAutomationId(ask, "approvals-confirm-text"); box.Children.Add(ask);
            if (mine.Text is { Length: > 0 } text) { var quote = Text(text, 13, Muted, null, TextWrapping.Wrap); quote.Margin = new Thickness(10, 8, 0, 0); box.Children.Add(quote); }
            if (mine.Note is { } note) box.Children.Add(FailLine(note, "approvals-answer-note"));
            var buttons = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 12, 0, 0) };
            var no = Action(AppStrings.ApprovalsWindow_DeviceStrip_1, ""); no.Click += (_, _) => CancelAnswer(true); buttons.Children.Add(Key(no, "cancel"));
            var yes = Action(AppStrings.ApprovalsWindow_AnswerArea_3, "", true); yes.Click += (_, _) => _ = SendAsync(decision, mine); buttons.Children.Add(Key(yes, "confirm")); box.Children.Add(buttons);
            var frame = new Border { Child = box, CornerRadius = new CornerRadius(14), Padding = new Thickness(14), Margin = new Thickness(0, 16, 0, 0), Background = Brush(Violet, 0x14), BorderBrush = Brush(Violet, 0x66), BorderThickness = new Thickness(1.4) };
            System.Windows.Automation.AutomationProperties.SetAutomationId(frame, "approvals-confirm"); stack.Children.Add(frame); return;
        }
        Section(stack, "target", AppStrings.ApprovalsWindow_AnswerArea_4);
        foreach (var option in decision.Options ?? [])
        {
            var row = Row(ApprovalsLook.Glyph(option.Recommended ? "check" : "arrow", 14, option.Recommended ? Colors.White : Violet), Spaced(Text(option.Label ?? "", 14, option.Recommended ? Colors.White : Ink, FontWeights.SemiBold, TextWrapping.Wrap), 10));
            if (option.Recommended) row.Children.Add(Spaced(Pill(Text(AppStrings.ApprovalsWindow_AnswerArea_5, 11.5, Violet, FontWeights.Bold), Colors.White, 0xE6, new Thickness(8, 1, 8, 1)), 10));
            var frame = new Border { Child = row, CornerRadius = new CornerRadius(12), Padding = new Thickness(14, 10, 14, 10), Margin = new Thickness(0, 0, 0, 8), Background = option.Recommended ? Brush(Violet) : Brush(Colors.White, 0xE0), BorderBrush = option.Recommended ? Brush(Violet) : Brush(Line), BorderThickness = new Thickness(1) };
            var button = Plain(frame, $"{option.Label}{(option.Recommended ? AppStrings.ApprovalsWindow_AnswerArea_6 : "")}"); button.HorizontalContentAlignment = HorizontalAlignment.Stretch; var id = option.Id; var label = option.Label; button.Click += (_, _) => Ask(decision, id, label, null);
            stack.Children.Add(Key(button, "o:" + option.Id));
        }
        Section(stack, "pencil", AppStrings.ApprovalsWindow_AnswerArea_8);
        var box2 = new TextBox { Text = draft.Id == decision.Id ? draft.Text : "", AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 64, MaxHeight = 140, FontSize = 14, Padding = new Thickness(8) };
        System.Windows.Automation.AutomationProperties.SetName(box2, AppStrings.ApprovalsWindow_AnswerArea_8); box2.TextChanged += (_, _) => draft = (decision.Id, box2.Text); Key(box2, "text"); stack.Children.Add(box2);
        var send = Action(AppStrings.ApprovalsWindow_AnswerArea_10, ""); send.Margin = new Thickness(0, 8, 0, 0); send.HorizontalAlignment = HorizontalAlignment.Left;
        send.Click += (_, _) => { var text = box2.Text.Trim(); if (text.Length > 0) Ask(decision, null, null, text); }; stack.Children.Add(Key(send, "send-text"));
    }

    // ---- 工程とのつながり
    private FrameworkElement LinksColumn()
    {
        var decision = SelectedId is { } id ? Known(id) : null; var panel = decision is null ? null : Approvals.LinkPanel(decision);
        var stack = new StackPanel { Margin = new Thickness(16, 16, 16, 18) };
        stack.Children.Add(Row(ApprovalsLook.Glyph("link", 16, Violet), Spaced(Text(AppStrings.ApprovalsWindow_LinksColumn_1, 16, Ink, FontWeights.Bold), 8)));
        var lead = Text(panel?.Kind == "linked" ? (decision!.Status == "answered" ? AppStrings.ApprovalsWindow_LinksColumn_2 : AppStrings.ApprovalsWindow_LinksColumn_3) : AppStrings.ApprovalsWindow_LinksColumn_4, 12.5, Muted, null, TextWrapping.Wrap);
        lead.Margin = new Thickness(0, 6, 0, 12); stack.Children.Add(lead);
        if (panel is null) { }
        else if (panel.Kind == "connecting") stack.Children.Add(Neutral(panel.Title, []));
        else if (panel.Kind == "unlinked") stack.Children.Add(Neutral(panel.Title, panel.Lines));
        else
        {
            foreach (var item in panel.Previous) stack.Children.Add(Mini(item, AppStrings.ApprovalsWindow_LinksColumn_5, panel));
            var self = new Border { Child = Row(ApprovalsLook.Glyph("inbox", 16, Violet), Spaced(new StackPanel { Children = { Text(panel.Task?.Title ?? "", 13.5, Ink, FontWeights.Bold, TextWrapping.Wrap), Text(decision!.Status == "answered" ? AppStrings.ApprovalsWindow_Toolbar_10 : AppStrings.ApprovalsWindow_LinksColumn_7, 11.5, Violet) } }, 10)),
                CornerRadius = new CornerRadius(12), Padding = new Thickness(12, 9, 12, 9), Margin = new Thickness(0, 0, 0, 8), Background = Brush(Violet, 0x14), BorderBrush = Brush(Violet), BorderThickness = new Thickness(1.6) };
            System.Windows.Automation.AutomationProperties.SetAutomationId(self, "approvals-self"); stack.Children.Add(self);
            foreach (var item in panel.Next) stack.Children.Add(Mini(item, AppStrings.ApprovalsWindow_LinksColumn_8, panel));
            var sentence = Text(panel.Sentence, 13, Ink, null, TextWrapping.Wrap); sentence.Margin = new Thickness(0, 6, 0, 10); System.Windows.Automation.AutomationProperties.SetAutomationId(sentence, "approvals-sentence"); stack.Children.Add(sentence);
            if (panel.Ids is { } ids) { var open = Action(AppStrings.ApprovalsWindow_LinksColumn_9, "", true); open.HorizontalAlignment = HorizontalAlignment.Left; open.Click += (_, _) => hub.OpenChart?.Invoke(ids.ProjectId, ids.CardId); stack.Children.Add(Key(open, "chart2")); }
            if (panel.Chart.Length > 0) { var chart = Text(AppStrings.ApprovalsWindow_LinksColumn_10(panel.Chart), 12, Muted); chart.Margin = new Thickness(0, 8, 0, 0); stack.Children.Add(chart); }
        }
        var glass = Glass(Scroll(stack, new Thickness(0)), 22, new Thickness(0), 0xC7); glass.Margin = new Thickness(6, 4, 16, 16); System.Windows.Automation.AutomationProperties.SetAutomationId(glass, "approvals-links"); return glass;
    }
    private static FrameworkElement Neutral(string title, IReadOnlyList<string> lines)
    {
        var inner = new StackPanel { Children = { Row(ApprovalsLook.Glyph("link", 15, Muted), Spaced(Text(title, 13.5, Muted, FontWeights.Bold), 8)) } };
        for (var i = 0; i < lines.Count; i++) { var line = Text(lines[i], 12.5, i == 0 ? Ink : Muted, null, TextWrapping.Wrap); line.Margin = new Thickness(0, 8, 0, 0); inner.Children.Add(line); }
        var dashed = new Grid(); dashed.Children.Add(new System.Windows.Shapes.Rectangle { RadiusX = 14, RadiusY = 14, Stroke = Brush(Muted, 0x80), StrokeThickness = 1.3, StrokeDashArray = [5, 4], Fill = Brush(Colors.White, 0x40) });
        dashed.Children.Add(new Border { Child = inner, Padding = new Thickness(14, 12, 14, 12) }); System.Windows.Automation.AutomationProperties.SetAutomationId(dashed, "approvals-unlinked"); return dashed;
    }
    private FrameworkElement Mini(ApprovalTask item, string label, ApprovalLinkPanel panel)
    {
        var info = LatticeChart.StateInfo(item.State); var glyph = StateGlyph(item.State ?? "pending", 15, Violet); glyph.Margin = new Thickness(0, 0, 10, 0);
        var row = new DockPanel(); DockPanel.SetDock(glyph, Dock.Left); row.Children.Add(glyph);
        row.Children.Add(new StackPanel { Children = { Text(item.Title ?? "", 13.5, Ink, FontWeights.SemiBold, TextWrapping.Wrap), Text($"{label} · {info.Badge}", 11.5, Muted) } });
        var frame = new Border { Child = row, CornerRadius = new CornerRadius(12), Padding = new Thickness(10, 8, 10, 8), Margin = new Thickness(0, 0, 0, 8), Background = Brush(Colors.White, 0xB0), BorderBrush = Brush(Line), BorderThickness = new Thickness(1) };
        if (panel.Ids is not { } ids || item.CardId is not { Length: > 0 } card) return frame;
        var button = Plain(frame, AppStrings.ApprovalsWindow_Mini_1(item.Title)); button.HorizontalContentAlignment = HorizontalAlignment.Stretch; button.Click += (_, _) => hub.OpenChart?.Invoke(ids.ProjectId, card); return Key(button, "n:" + card);
    }
}
