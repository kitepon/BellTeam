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
using BellTeam.PeerChannel;
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
        Title = "決裁箱"; Width = 1360; Height = 860; MinWidth = 1000; MinHeight = 600; UseLayoutRounding = true;
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

/// <summary>One 決裁箱 screen: reads the pending, held and finished decisions from <c>/api/approvals/*</c> (never Approval Box), answers in place, connects. Core owns the words and rules.</summary>
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
    private int pendingToken, doneToken, connectToken, attempt;
    private readonly Dictionary<string, ViewDecision> extra = [];
    private readonly Dictionary<string, string> holdNotes = [];
    private readonly Dictionary<string, Task<BitmapSource?>> thumbs = [];
    private Connect connect = new("idle");
    private (string Step, string? Note)? drop;
    private (string? Id, string Text) draft = (null, "");
    private string? copied, bannerId, bannerText;
    private List<ViewDecision> srvPending = [], srvDone = []; // the server read (/api/approvals/*); pending/done below are the union with the device (DecisionUnion)
    private IDeviceDecisions? Device => hub.Device;
    private IReadOnlyList<ViewDecision> DeviceViews => hub.DeviceViews;
    private bool DeviceLive => Device?.State.Status == RuntimeStatus.Live;
    private bool DeviceUsable => Device is { } d && (d.State.Status == RuntimeStatus.Live || d.Book.All.Count > 0);
    private bool legacyOpen; // the server connect screen opened by hand while the device list is usable
    private List<ViewDecision> Union()
    {
        List<ViewDecision> server = [.. srvPending, .. srvDone.Where(old => srvPending.All(item => item.Id != old.Id))];
        return Device is null ? server : [.. DecisionUnion.Merge(server, DeviceViews)];   // no device: the list is exactly the server read, no source tags
    }
    private List<ViewDecision> pending => [.. Union().Where(item => item.Status is "pending" or "held")];
    private List<ViewDecision> done => [.. Union().Where(item => item.Status is not ("pending" or "held"))];
    private string? doneNext;
    private bool loaded, doneLoaded, stale;
    internal Func<DateTimeOffset> Now { get; set; } = () => DateTimeOffset.UtcNow;
    internal Tab Current { get; private set; } = Tab.Pending;
    internal string Origin { get; private set; } = "all";
    internal string? SelectedId { get; private set; }
    internal IReadOnlyList<ViewDecision> Pending => pending;
    internal IReadOnlyList<ViewDecision> Done => done;
    internal Task Reading { get; private set; } = Task.CompletedTask;
    internal string? AnswerStep => answer?.Step;
    /// <summary>The first read has an answer: the list is read, or a refusal / sign-in / connect view is on screen.</summary>
    internal bool Settled => loaded || DeviceUsable || Blocked is not null || Feed?.Status == ApprovalFeedStatus.LoginRequired;
    /// <summary>Picks an option of the selected decision (the confirm opens in place).</summary>
    internal void Choose(string optionId)
    {
        if (SelectedId is { } id && Known(id) is { } decision && decision.Options?.FirstOrDefault(option => option.Id == optionId) is { } option) Ask(decision, option.Id, option.Label, null);
    }
    internal void Write(string text) { if (SelectedId is { } id && Known(id) is { } decision) Ask(decision, null, null, text); }
    internal string? ConnectPhase => connect.Phase;
    private Answer? answer;
    private bool Running => run is not null;
    private ApprovalsFeed? Feed => hub.Feed;
    private Workspace Workspace => hub.Workspace;
    private BellApi Api => Workspace.Management.Api;
    private ApprovalFeedStatus? Blocked => Feed?.Status is ApprovalFeedStatus.Old or ApprovalFeedStatus.NotEntitled or ApprovalFeedStatus.Expired or ApprovalFeedStatus.NoCredential ? Feed.Status : null;

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

    /// <summary>On open: read the pending and held list (the feed reads its summary and holds the stream; a stopped one reads again at once).</summary>
    internal void Start()
    {
        if (Running || !Workspace.Connected) return;
        run = CancellationTokenSource.CreateLinkedTokenSource(Workspace.ConnectionToken);
        hub.Changed += OnFeed; hub.DecisionChanged += OnDecision; hub.DeviceChanged += OnDevice;
        loaded = false; stale = false; attempt = 0; connect = new("idle"); drop = null; Paint();
        if (Feed is { Status: ApprovalFeedStatus.Live }) Reading = LoadPendingAsync(); else { Feed?.Refresh(); if (Blocked == ApprovalFeedStatus.NoCredential) Reading = EnterConnectAsync(); }
    }
    internal void Stop()
    {
        if (run is null) return;
        hub.Changed -= OnFeed; hub.DecisionChanged -= OnDecision; hub.DeviceChanged -= OnDevice;
        pendingToken++; doneToken++; connectToken++; run.Cancel(); run.Dispose(); run = null;
    }
    internal void Reload()
    {
        stale = false; Feed?.Refresh(); Device?.Refresh();
        if (Running) { Reading = LoadPendingAsync(); if (doneLoaded) _ = LoadDoneAsync(true); }
    }
    /// <summary>Esc: closes the answer confirm if open, else the 詳細.</summary>
    internal bool Escape()
    {
        if (answer is { Step: "confirm" }) { CancelAnswer(true); return true; }
        if (SelectedId is not null) { SelectedId = null; answer = null; Paint(); return true; }
        return false;
    }

    private void OnFeed()
    {
        if (!Running) return;
        if (Feed?.Status == ApprovalFeedStatus.Live && !loaded) Reading = LoadPendingAsync();
        if (Blocked == ApprovalFeedStatus.NoCredential && connect.Phase == "idle" && connect.Server is null) Reading = EnterConnectAsync();
        Paint();
    }
    // The device's book or connection changed: a sent answer stays "sending" until the book shows the decision closed (the result frame), then the confirm leaves.
    private void OnDevice()
    {
        if (!Running) return;
        if (answer is { Step: "sending" } mine && Known(mine.Id) is { } known && known.Source == DecisionUnion.Device && known.Status is not ("pending" or "held")) { answer = null; draft = (null, ""); bannerId = null; }
        Paint();
    }
    private void OnDecision(string? id)
    {
        if (!Running) return;
        Reading = LoadPendingAsync(); if (doneLoaded) _ = LoadDoneAsync(true);
        if (id is not null && id == SelectedId) _ = LoadOneAsync(id);
    }

    // MARK: reading

    private async Task LoadPendingAsync()
    {
        if (run is not { } source) return; var mine = ++pendingToken;
        var reply = await Api.ApprovalListAsync("pending,held", null, source.Token);
        if (!Running || mine != pendingToken) return;
        if (reply.List?.Items is { } items) { srvPending = [.. items]; loaded = true; stale = false; attempt = 0; Paint(); return; }
        if (reply.LoginRequired) { Paint(); return; }
        if (reply.Failure is ApprovalFailure.Reconnect or ApprovalFailure.Wait or ApprovalFailure.Refused || reply.Ok)
        {
            stale = true; Paint();
            try { await Task.Delay(Approvals.BackoffMs(attempt++), source.Token); } catch (OperationCanceledException) { return; }
            if (Running && mine == pendingToken) Reading = LoadPendingAsync();
            return;
        }
        Feed?.Refresh();   // 404 / 402 / 403 / 409: the feed classifies it and says what to show
    }
    private async Task LoadDoneAsync(bool reset)
    {
        if (run is not { } source) return; var mine = ++doneToken;
        var reply = await Api.ApprovalListAsync("answered,cancelled", reset ? null : doneNext, source.Token);
        if (!Running || mine != doneToken) return;
        if (reply.List?.Items is { } items)
        {
            srvDone = reset ? [.. items] : [.. srvDone, .. items.Where(item => srvDone.All(old => old.Id != item.Id))];
            doneNext = reply.List.NextCursor; doneLoaded = true; stale = false;
        }
        else stale = true;
        Paint();
    }
    private async Task LoadOneAsync(string id)
    {
        if (run is not { } source) return;
        var reply = await Api.ApprovalAsync(id, source.Token);
        if (!Running) return;
        if (reply.Decision is { Id: { } got } decision && got == id) Put(decision);
        else if (reply.Failure == ApprovalFailure.Gone) { extra.Remove(id); if (SelectedId == id) SelectedId = null; }
        Paint();
    }
    private ViewDecision? Known(string id)
    {
        var listed = pending.FirstOrDefault(item => item.Id == id) ?? done.FirstOrDefault(item => item.Id == id); extra.TryGetValue(id, out var single);
        return listed is not null && single is not null ? (single.Version > listed.Version ? single : listed) : listed ?? single;
    }
    private void Put(ViewDecision decision)
    {
        ViewDecision Swap(ViewDecision item) => item.Id == decision.Id ? decision : item;
        srvPending = [.. srvPending.Select(Swap)]; srvDone = [.. srvDone.Select(Swap)]; extra[decision.Id!] = decision;
    }

    // MARK: choosing

    internal void SetTab(Tab tab)
    {
        Current = tab; SelectedId = null; answer = null;
        if (tab == Tab.Done && !doneLoaded) _ = LoadDoneAsync(true);
        Paint();
    }
    internal void SetOrigin(string value) { Origin = value; Paint(); }
    internal void Select(string id)
    {
        if (SelectedId != id) { answer = null; if (draft.Id != id) draft = (id, ""); }
        SelectedId = id;
        if (Known(id) is null) _ = LoadOneAsync(id);
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
    // An answer goes through the source that holds the copy on screen, never through both (Delta, transition rule).
    private async Task SendDeviceAsync(IDeviceDecisions device, ViewDecision decision, Answer mine)
    {
        mine.Step = "sending"; mine.Note = null; Paint();
        SendOutcome outcome;
        try { outcome = await device.AnswerAsync(decision.Id!, mine.OptionId, mine.OptionId is null ? mine.Text : null); }
        catch (NoSessionException) { outcome = new("no_session"); }
        catch (Exception error) when (error is InvalidOperationException or KeyNotFoundException or ArgumentException) { outcome = new("gone"); }
        if (!Running || !ReferenceEquals(answer, mine)) return;
        switch (outcome.Ack)
        {
            case "ok": break; // stays "sending" until the result frame closes the decision in the book (OnDevice)
            case "refused:stale_version": answer = null; bannerId = decision.Id; bannerText = Approvals.Amended(Approvals.OriginOf(decision).Who); break;
            case "refused:already_decided" or "gone": answer = null; break;
            case "unknown": mine.Step = "confirm"; mine.Note = Approvals.DeviceUnknown; break;
            default: mine.Step = "confirm"; mine.Note = Approvals.Retry; break;
        }
        Paint();
    }
    private async Task SendAsync(ViewDecision decision, Answer mine)
    {
        if (decision.Source == DecisionUnion.Device && Device is { } device) { await SendDeviceAsync(device, decision, mine); return; }
        if (run is not { } source) return;
        mine.Step = "sending"; mine.Note = null; Paint();
        var reply = await Api.ApprovalAnswerAsync(decision.Id!, mine.OptionId, mine.OptionId is null ? mine.Text : null, mine.Version, mine.Key, source.Token);
        if (!Running || !ReferenceEquals(answer, mine)) return;
        var outcome = Approvals.AnswerOutcome(reply.Status, reply.Body);
        if (outcome.Kind == "ok" && reply.Decision is { } updated)
        {
            Put(updated); answer = null; draft = (null, ""); bannerId = null; Reading = LoadPendingAsync(); if (doneLoaded) _ = LoadDoneAsync(true);
            deliveryNotes[decision.Id!] = Approvals.DeliveryNote(updated);
        }
        else if (outcome is { Kind: "conflict", Decision: { } latest }) { Put(latest); answer = null; bannerId = decision.Id; bannerText = Approvals.Amended(Approvals.OriginOf(latest).Who); }
        else if (outcome.Kind == "gone") { SelectedId = null; answer = null; Reading = LoadPendingAsync(); }
        else { mine.Step = "confirm"; mine.Note = outcome.Message; if (reply.LoginRequired) mine.Note = Approvals.Retry; }
        Paint();
    }
    private readonly Dictionary<string, ApprovalDeliveryNote> deliveryNotes = [];
    private async Task HoldAsync(ViewDecision decision)
    {
        if (decision.Source == DecisionUnion.Device && Device is { } device)
        {
            SendOutcome outcome;
            try { outcome = await device.HoldAsync(decision.Id!, decision.Status != "held"); } catch (Exception error) when (error is NoSessionException or InvalidOperationException or KeyNotFoundException) { outcome = new("no_session"); }
            if (outcome.Ack == "ok") holdNotes.Remove(decision.Id!); else holdNotes[decision.Id!] = Approvals.HoldFailed;
            if (Running) Paint();
            return;
        }
        if (run is not { } source) return;
        var reply = await Api.ApprovalHoldAsync(decision.Id!, decision.Status != "held", source.Token);
        if (!Running) return;
        if (reply.Decision is { } updated) { Put(updated); holdNotes.Remove(decision.Id!); Reading = LoadPendingAsync(); }
        else holdNotes[decision.Id!] = Approvals.HoldFailed;
        Paint();
    }
    private void CopyResume(ViewDecision decision)
    {
        try { Clipboard.SetText(decision.ResumePhrase ?? ""); } catch (Exception) { return; }
        copied = decision.Id; Paint();
        _ = Task.Delay(2000).ContinueWith(_ => Dispatcher.BeginInvoke(() => { if (copied == decision.Id) { copied = null; Paint(); } }), TaskScheduler.Default);
    }

    // MARK: connecting (screen-spec 「つなぐ」): the module gives the hosted consent page; the browser does the sign-in; the module polls

    private const string Lapsed = "許可の待ち時間が過ぎました。もう一度つないでください。", ConnectFailed = Approvals.ConnectFailed, Blocked_ = "決裁箱の画面が開かなかったようです。「もう一度開く」を押してください。",
        DropAsk = "決裁箱とのつなぎを外します。外すと、また決裁箱につなぐまで決裁は読めません。", DropFailed = "いまはつなぎを外せませんでした。少し待って、もう一度押してください。", Expired = "決裁箱とのつなぎの期限が切れました。もう一度つないでください。";
    internal async Task EnterConnectAsync()
    {
        if (run is not { } source || connect.Phase != "idle") return; var mine = ++connectToken;
        var reply = await Api.ApprovalConnectionAsync(source.Token);
        if (!Running || mine != connectToken || !reply.Ok || Blocked != ApprovalFeedStatus.NoCredential) return;
        var state = reply.Connection?.State;
        if (state == "connected") { Recover(); return; }
        connect = new(state == "waiting" ? "waiting" : state == "denied" ? "denied" : "idle", state);
        if (state == "waiting") _ = WatchAsync(mine, 2000);
        Paint();
    }
    private void Settle(Connect next) { connectToken++; connect = next; Paint(); }
    private void Recover() { connectToken++; connect = new("idle"); Feed?.Refresh(); Paint(); }
    private async Task WatchAsync(int mine, int ms)
    {
        var poll = 0;
        while (Running && mine == connectToken)
        {
            try { await Task.Delay(ms, run!.Token); } catch (OperationCanceledException) { return; }
            var reply = await Api.ApprovalConnectionAsync(run!.Token);
            if (!Running || mine != connectToken) return;
            var state = reply.Ok ? reply.Connection?.State : null;
            if (state == "connected") { Recover(); return; }
            if (state == "denied") { Settle(new("denied", state)); return; }
            if (state is "not_connected" or "expired") { Settle(new("idle", state, Lapsed)); return; }
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
        else if (reply.Status is 402 or 403 or 404 or 409) { Settle(new("idle")); Feed?.Refresh(); }
        else Settle(new("idle", null, ConnectFailed));
    }
    internal Func<string, bool> OpenUrl { get; set; } = url => { try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); return true; } catch (Exception) { return false; } };
    private async Task StopConnectAsync()
    {
        Settle(new("idle")); if (run is { } source) await Api.ApprovalStopConnectAsync(source.Token);
        if (Running && Blocked == ApprovalFeedStatus.NoCredential) await EnterConnectAsync();
    }
    private async Task DisconnectAsync()
    {
        if (run is not { } source) return;
        drop = ("busy", null); Paint();
        var reply = await Api.ApprovalDisconnectAsync(source.Token);
        if (!Running) return;
        if (reply.Ok) { drop = null; connect = new("idle", "not_connected"); Feed?.Refresh(); }
        else drop = ("confirm", DropFailed);
        Paint();
    }

    // MARK: drawing

    private void Paint(string? focus = null)
    {
        var keep = focus ?? KeyOf(Keyboard.FocusedElement as DependencyObject);
        var state = Feed?.Status ?? ApprovalFeedStatus.Connecting; var blocked = Blocked;
        pill.Visibility = Running && (state == ApprovalFeedStatus.Drop || stale && blocked is null) ? Visibility.Visible : Visibility.Collapsed; pillText.Text = Approvals.Reconnect;
        var root = new Grid(); root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto }); root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto }); root.RowDefinitions.Add(new RowDefinition());
        var usable = DeviceUsable;
        root.Children.Add(Toolbar((blocked is null && state != ApprovalFeedStatus.LoginRequired) || usable));
        var notes = new StackPanel();
        if (bannerText is not null && bannerId == SelectedId && SelectedId is not null) notes.Children.Add(Banner(bannerText));
        if (DeviceStrip() is { } strip) notes.Children.Add(strip);
        if (notes.Children.Count > 0) { SetRow(notes, 1); root.Children.Add(notes); }
        FrameworkElement main;
        if (state == ApprovalFeedStatus.LoginRequired && !usable) main = LatticeWindow.Notice(LatticeChart.LoginRequired, null, null);
        else if (blocked == ApprovalFeedStatus.NoCredential && (!usable || legacyOpen)) main = ConnectView();
        else if (blocked is { } kind && !usable) main = Refused(kind);
        else main = Columns((stale || state == ApprovalFeedStatus.Drop) && !DeviceLive);
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

    // Failure views 1, 2, 9: the words and a way out on the same screen (契約を確かめる / 読み直す re-read, 閉じる leaves); nothing runs behind them.
    private FrameworkElement Refused(ApprovalFeedStatus kind)
    {
        var text = kind switch { ApprovalFeedStatus.Old => Approvals.Old, ApprovalFeedStatus.NotEntitled => Approvals.NotEntitled, _ => Approvals.Expired };
        var notice = (StackPanel)LatticeWindow.Notice(text, null, null, kind != ApprovalFeedStatus.Old);
        var acts = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 18, 0, 0) };
        if (kind != ApprovalFeedStatus.Old) { var again = Action(kind == ApprovalFeedStatus.NotEntitled ? "契約を確かめる" : "読み直す", "", true); again.Click += (_, _) => Reload(); acts.Children.Add(Key(again, "again")); }
        var close = Action("閉じる", "", kind == ApprovalFeedStatus.Old); close.Click += (_, _) => window.Close(); acts.Children.Add(Key(close, "close-screen"));
        notice.Children.Add(acts); return notice;
    }

    private WrapPanel Toolbar(bool full)
    {
        var bar = new WrapPanel { Margin = new Thickness(18, 14, 18, 10) };
        var summary = Device is null ? Feed?.Summary : DecisionUnion.Summary(Feed?.Summary, [.. srvPending, .. srvDone], DeviceViews, Now()); var counts = Approvals.CountsOf(summary);
        var title = Row(ApprovalsLook.Glyph("inbox", 18, Violet), Spaced(Text("決裁箱", 20, Ink, FontWeights.Bold), 9));
        if (counts.Pending > 0) title.Children.Add(Spaced(Pill(Text(counts.Pending.ToString(), 13, Colors.White, FontWeights.Bold), Violet, 0xFF, new Thickness(9, 1, 9, 1)), 10));
        bar.Children.Add(Glass(title, 14, new Thickness(14, 8, 16, 8), 0xB3));
        if (!full) return bar;
        var live = (Feed?.Status == ApprovalFeedStatus.Live && !stale) || DeviceLive;
        var dot = new System.Windows.Shapes.Ellipse { Width = 8, Height = 8, Fill = Brush(live ? Color.FromRgb(0x2E, 0xB3, 0x9E) : Muted) };
        var livePill = Pill(Row(dot, Spaced(Text(live ? "ライブ" : "再接続中", 12, live ? ApprovalsLook.Tone("ok") : Muted, FontWeights.SemiBold), 6)), live ? Color.FromRgb(0x2E, 0xB3, 0x9E) : Muted, 0x1F);
        livePill.Margin = new Thickness(14, 0, 0, 0); bar.Children.Add(livePill);
        Button Segment(string label, Tab tab, string? count)
        {
            var on = Current == tab; var row = Row(Text(label, 12.5, on ? Ink : Muted, on ? FontWeights.SemiBold : FontWeights.Normal));
            if (count is not null) row.Children.Add(Spaced(Text(count, 11.5, Muted), 6));
            var face = new Border { Child = row, CornerRadius = new CornerRadius(8), Padding = new Thickness(14, 5, 14, 5), Background = on ? Brush(Colors.White) : Brushes.Transparent };
            var button = Plain(face, $"{label}{(count is not null ? " " + count : "")}{(on ? "、表示中" : "で表示")}"); button.Click += (_, _) => SetTab(tab);
            return Key(button, "tab:" + tab);
        }
        var held = pending.Count(item => item.Status == "held"); var waiting = pending.Count(item => item.Status == "pending");
        var seg = new Border { Child = Row(Segment("待ち", Tab.Pending, loaded || DeviceUsable ? waiting.ToString() : null), Segment("保留", Tab.Held, loaded || DeviceUsable ? held.ToString() : null), Segment("済み", Tab.Done, doneLoaded ? $"{done.Count}{(doneNext is not null ? "+" : "")}" : null)),
            CornerRadius = new CornerRadius(10), Padding = new Thickness(3), Background = Brush(Muted, 0x1F), Margin = new Thickness(14, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
        bar.Children.Add(seg);
        var ring = Row(new LatticeRing(counts.Answered, Math.Max(counts.Filed, counts.Answered), 40, false), Spaced(new StackPanel { Children = { Text("今日の回答", 11, Muted), Text($"{counts.Answered} / {counts.Filed}", 14, Ink, FontWeights.SemiBold) }, VerticalAlignment = VerticalAlignment.Center }, 8),
            Counter("待ち", counts.Pending, Violet, 22), Counter("急ぎ", counts.Urgent, Amber, 8), Counter("保留", counts.Held, Muted, 8));
        ring.Margin = new Thickness(26, 2, 0, 2); bar.Children.Add(ring);
        var reload = Action("読み直す", ""); reload.Margin = new Thickness(18, 0, 0, 0); reload.Click += (_, _) => Reload(); Key(reload, "reload"); bar.Children.Add(reload);
        bar.Children.Add(DropUi());
        return bar;
    }
    private static Border Counter(string label, int count, Color color, double left)
    {
        var pill = Pill(Row(Text(label, 12.5, Ink), Spaced(Text(count.ToString(), 14, color, FontWeights.Bold), 6)), Colors.White, 0xB3, new Thickness(12, 6, 13, 6));
        pill.BorderBrush = Brush(Colors.White); pill.BorderThickness = new Thickness(1); pill.Margin = new Thickness(left, 0, 0, 0);
        System.Windows.Automation.AutomationProperties.SetName(pill, $"{label} {count}"); return pill;
    }
    private FrameworkElement DropUi()
    {
        var row = Row(); row.Margin = new Thickness(8, 0, 0, 0);
        if (drop is { Step: "busy" }) { row.Children.Add(Spinner(14)); return row; }
        if (drop is { Step: "confirm" } ask)
        {
            row.Children.Add(Text(ask.Note ?? DropAsk, 12.5, Ink, FontWeights.SemiBold));
            var no = Action("やめる", ""); no.Margin = new Thickness(10, 0, 0, 0); no.Click += (_, _) => { drop = null; Paint(); }; row.Children.Add(Key(no, "unlink-no"));
            var yes = Action("外す", "", true); yes.Click += (_, _) => _ = DisconnectAsync(); row.Children.Add(Key(yes, "unlink-yes"));
            return row;
        }
        var unlink = Action("つなぎを外す", ""); unlink.Click += (_, _) => { drop = ("confirm", null); Paint("unlink-no"); }; row.Children.Add(Key(unlink, "unlink"));
        return row;
    }
    // What the device and the server read say when they are not both fine; the list stays as long as a decision is held.
    private FrameworkElement? DeviceStrip()
    {
        var panel = new StackPanel(); var n = 0;
        void Line(string text, string? label = null, Action? act = null)
        {
            var row = Row(ApprovalsLook.Glyph("info", 16, Muted), Spaced(Text(text, 13, Ink, FontWeights.SemiBold, TextWrapping.Wrap), 10));
            if (label is not null && act is not null) { var button = Action(label, ""); button.Margin = new Thickness(12, 0, 0, 0); button.Click += (_, _) => act(); row.Children.Add(Key(button, "legacy:" + label)); }
            var border = new Border { Child = row, CornerRadius = new CornerRadius(14), Padding = new Thickness(16, 8, 16, 8), Margin = new Thickness(18, 0, 18, 8), Background = Brush(Muted, 0x14), BorderBrush = Brush(Muted, 0x44), BorderThickness = new Thickness(1) };
            System.Windows.Automation.AutomationProperties.SetAutomationId(border, "approvals-device-note-" + n++); panel.Children.Add(border);
        }
        if (Device is { } device)
            switch (device.State.Status)
            {
                case RuntimeStatus.Connecting: Line(Approvals.DeviceJoining); break;
                case RuntimeStatus.Retrying: Line(Approvals.DeviceReconnecting(device.State.Reason), "今すぐ試す", device.Refresh); break;
                case RuntimeStatus.NeedsAdmission: Line(device.State.Reason == "removed" ? Approvals.DeviceRemoved : Approvals.DeviceNeedsApproval); break; // 「承認をお願いする」 comes with the 5.3 starter step
                case RuntimeStatus.SignedOut: Line(device.State.Reason switch { "pass_ended" => Approvals.DevicePassEnded, "account_deleted" => Approvals.DeviceAccountDeleted, _ => Approvals.DeviceSignedOut }, hub.SignInApprovalBox is null ? null : "Approval Boxにサインイン", () => hub.SignInApprovalBox?.Invoke()); break;
                case RuntimeStatus.NotEntitled: Line(Approvals.DeviceNotEntitled, "確かめ直す", device.Refresh); break;
            }
        if (DeviceUsable && !legacyOpen)
        {
            if (Blocked == ApprovalFeedStatus.NoCredential) Line(Approvals.ServerSideNoCredential, "つなぐ", () => { legacyOpen = true; Paint(); if (connect.Phase == "idle" && connect.Server is null) Reading = EnterConnectAsync(); });
            else if (Blocked is { } kind && Approvals.StatusText(kind switch { ApprovalFeedStatus.Old => ApprovalFailure.Old, ApprovalFeedStatus.NotEntitled => ApprovalFailure.NotEntitled, _ => ApprovalFailure.Expired }) is { } text) Line(text);
            else if (Feed?.Status == ApprovalFeedStatus.LoginRequired) Line(LatticeChart.LoginRequired);
        }
        return panel.Children.Count > 0 ? panel : null;
    }
    private Border Banner(string text)
    {
        var line = Row(ApprovalsLook.Glyph("info", 16, Violet), Spaced(Text(text, 14, Ink, FontWeights.SemiBold, TextWrapping.Wrap), 10));
        var border = new Border { Child = line, CornerRadius = new CornerRadius(14), Padding = new Thickness(16, 10, 16, 10), Margin = new Thickness(18, 0, 18, 10), Background = Brush(Violet, 0x1A), BorderBrush = Brush(Violet, 0x55), BorderThickness = new Thickness(1) };
        System.Windows.Automation.AutomationProperties.SetAutomationId(border, "approvals-banner"); SetRow(border, 1); return border;
    }

    private FrameworkElement ConnectView()
    {
        var phase = connect.Phase;
        var text = phase is "opening" or "waiting" ? Approvals.Waiting : phase == "denied" ? Approvals.Denied : connect.Server == "expired" ? Expired : Approvals.NoCredential;
        var stack = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, MaxWidth = 480, Margin = new Thickness(24, 60, 24, 24) };
        stack.Children.Add(new LatticeBud { Margin = new Thickness(0, 0, 0, 18), HorizontalAlignment = HorizontalAlignment.Center });
        var main = Text(text, 18, Ink, FontWeights.SemiBold, TextWrapping.Wrap); main.TextAlignment = TextAlignment.Center; System.Windows.Automation.AutomationProperties.SetAutomationId(main, "approvals-connect-text"); stack.Children.Add(main);
        if (phase is "opening" or "waiting") { var spin = Spinner(18); spin.Margin = new Thickness(0, 16, 0, 0); spin.HorizontalAlignment = HorizontalAlignment.Center; stack.Children.Add(spin); }
        var acts = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 18, 0, 0) };
        Button Act(string label, Action run, bool primary = false, string? key = null) { var button = Action(label, "", primary); button.Click += (_, _) => run(); return Key(button, key ?? label); }
        if (phase == "waiting") { acts.Children.Add(Act("もう一度開く", () => _ = StartConnectAsync(), true, "connect:again")); acts.Children.Add(Act("やめる", () => _ = StopConnectAsync(), key: "connect:cancel")); }
        else if (phase == "denied") acts.Children.Add(Act("もう一度つなぐ", () => _ = StartConnectAsync(), true, "connect:retry"));
        else if (phase == "idle") { acts.Children.Add(Act("決裁箱につなぐ", () => _ = StartConnectAsync(), true, "connect:go")); acts.Children.Add(Act("読み直す", Reload, key: "connect:reload")); }
        if (DeviceUsable && legacyOpen) acts.Children.Add(Act("一覧へ戻る", () => { legacyOpen = false; Paint(); }, key: "connect:back"));
        acts.Children.Add(Act("閉じる", window.Close)); stack.Children.Add(acts);
        if (connect.Note.Length > 0) { var note = Text(connect.Note, 13, Red, FontWeights.SemiBold, TextWrapping.Wrap); note.Margin = new Thickness(0, 12, 0, 0); note.TextAlignment = TextAlignment.Center; System.Windows.Automation.AutomationProperties.SetAutomationId(note, "approvals-connect-note"); stack.Children.Add(note); }
        return stack;
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
        var heading = Current switch { Tab.Pending => "回答を待っています", Tab.Held => "保留しています", _ => "済んだ決裁" };
        var head = Row(Text(heading, 15, Ink, FontWeights.Bold)); if (Current == Tab.Pending) head.Children.Add(Spaced(Text("急ぎ → 期限 → 古い順", 11.5, Muted), 10)); head.Margin = new Thickness(6, 0, 0, 10); stack.Children.Add(head);
        var baseItems = Current == Tab.Done ? done : pending.Where(item => item.Status == (Current == Tab.Pending ? "pending" : "held")).ToList();
        var chips = Approvals.OriginCounts(baseItems); var shown = Approvals.OriginFilter(baseItems, Origin); var hidden = chips.All - shown.Count;
        Button Chip(string value, string label, int count)
        {
            var on = Origin == value; var face = new Border { Child = Row(Text(label, 12, on ? Colors.White : Ink, FontWeights.SemiBold), Spaced(Text(count.ToString(), 11.5, on ? Colors.White : Muted), 6)), CornerRadius = new CornerRadius(99), Padding = new Thickness(11, 4, 11, 4), Background = on ? Brush(Violet) : Brush(Muted, 0x1F), Margin = new Thickness(0, 0, 6, 0) };
            var button = Plain(face, $"{label} {count}件{(on ? "、選択中" : "")}"); button.Click += (_, _) => SetOrigin(value); return Key(button, "origin:" + value);
        }
        var filter = new WrapPanel { Margin = new Thickness(4, 0, 0, 10) };
        filter.Children.Add(Spaced(Text("出どころ", 11.5, Muted), 0)); ((TextBlock)filter.Children[0]).Margin = new Thickness(2, 0, 8, 0);
        filter.Children.Add(Chip("all", "すべて", chips.All)); filter.Children.Add(Chip("bellteam", "BellTeam", chips.Bellteam)); filter.Children.Add(Chip("external", "外部", chips.External)); stack.Children.Add(filter);
        if (hidden > 0)
        {
            var line = Row(ApprovalsLook.Glyph("info", 14, Amber), Spaced(Text($"{(Origin == "bellteam" ? "外部" : "BellTeam")}の決裁 {hidden}件を隠しています。", 12.5, Amber, FontWeights.SemiBold), 8));
            var all = Action("すべてを見る", ""); all.Margin = new Thickness(10, 0, 0, 0); all.Click += (_, _) => SetOrigin("all"); line.Children.Add(Key(all, "show-all")); line.Margin = new Thickness(6, 0, 0, 10); stack.Children.Add(line);
        }
        if (!loaded && !DeviceUsable && Current != Tab.Done) stack.Children.Add(LatticeWindow.Notice(Approvals.Loading, null, null));
        else if (Current == Tab.Done) DoneRows(stack, shown);
        else if (shown.Count == 0)
        {
            var none = Text(baseItems.Count > 0 ? "絞り込みに合う決裁はありません。" : Current == Tab.Held ? Approvals.EmptyHeld : Approvals.EmptyPending, 14, Muted, null, TextWrapping.Wrap); none.Margin = new Thickness(8, 6, 8, 10); System.Windows.Automation.AutomationProperties.SetAutomationId(none, "approvals-none"); stack.Children.Add(none);
            if (Current == Tab.Pending && baseItems.Count == 0) { var see = Action("済みを見る", ""); see.HorizontalAlignment = HorizontalAlignment.Left; see.Margin = new Thickness(6, 0, 0, 0); see.Click += (_, _) => SetTab(Tab.Done); stack.Children.Add(Key(see, "see-done")); }
        }
        else
        {
            foreach (var item in shown) stack.Children.Add(Card(item));
            if (Current == Tab.Pending && Approvals.OriginFilter(pending.Where(item => item.Status == "held").ToList(), Origin) is { Count: > 0 } held)
            {
                var divider = Row(ApprovalsLook.Glyph("pause", 13, Muted), Spaced(Text($"保留 {held.Count}", 12.5, Muted, FontWeights.SemiBold), 6)); divider.Margin = new Thickness(6, 14, 0, 8); stack.Children.Add(divider);
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
        if (!doneLoaded && !DeviceUsable) { stack.Children.Add(LatticeWindow.Notice(Approvals.Loading, null, null)); return; }
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
                var line = string.Join("　", new[] { row.Line, row.Origin.External ? "外部から" : null }.OfType<string>().Where(part => part.Length > 0));
                dock.Children.Add(new StackPanel { Children = { title, Text(line, 11.5, Muted) }, VerticalAlignment = VerticalAlignment.Center });
                var frame = new Border { Child = dock, CornerRadius = new CornerRadius(12), Padding = new Thickness(12, 8, 12, 8), Margin = new Thickness(0, 0, 0, 6), Background = Brush(Colors.White, 0xD9), BorderBrush = selected ? Brush(Violet) : Brush(Line), BorderThickness = new Thickness(selected ? 2 : 1) };
                stack.Children.Add(Open(frame, $"{row.Title}、{line}", row.Id));
            }
        }
        if (doneNext is not null) { var more = Action("もっと見る", ""); more.HorizontalAlignment = HorizontalAlignment.Left; more.Click += (_, _) => _ = LoadDoneAsync(false); stack.Children.Add(Key(more, "more")); }
    }

    // ---- 詳細
    private FrameworkElement DetailColumn()
    {
        var decision = SelectedId is { } id ? Known(id) : null;
        var stack = new StackPanel { Margin = new Thickness(20, 16, 18, 18) };
        if (decision is null)
        {
            var empty = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 120, 0, 0) };
            empty.Children.Add(ApprovalsLook.Glyph("inbox", 40, Muted)); var text = Text(SelectedId is not null ? Approvals.Loading : "決裁を選ぶと、ここに内容が出ます。", 14, Muted); text.Margin = new Thickness(0, 12, 0, 0); empty.Children.Add(text);
            System.Windows.Automation.AutomationProperties.SetAutomationId(text, "approvals-detail-empty");
            return Wrap(empty);
        }
        if (answer is { } a && a.Id == decision.Id && a.Version != decision.Version) { bannerId = decision.Id; bannerText = Approvals.Amended(Approvals.OriginOf(decision).Who); answer = null; }
        var origin = Approvals.OriginOf(decision); var open = decision.Status is "pending" or "held";
        var head = new DockPanel();
        var close = Action("", ""); close.Content = ApprovalsLook.Glyph("xmark", 14, Ink); close.Padding = new Thickness(8); close.Margin = new Thickness(8, 0, 0, 0); DockPanel.SetDock(close, Dock.Right); close.Click += (_, _) => { SelectedId = null; answer = null; Paint(); };
        System.Windows.Automation.AutomationProperties.SetName(close, "詳細を閉じる"); head.Children.Add(Key(close, "close"));
        var badges = new WrapPanel(); foreach (var badge in Approvals.BadgesOf(decision)) badges.Children.Add(ApprovalsLook.Badge(badge)); head.Children.Add(badges); stack.Children.Add(head);
        var title = Text(decision.Title ?? "", 21, Ink, FontWeights.Bold, TextWrapping.Wrap); title.Margin = new Thickness(0, 10, 0, 8); stack.Children.Add(title);
        var sub = new WrapPanel { Margin = new Thickness(0, 0, 0, 6) };
        sub.Children.Add(Row(ApprovalsLook.Origin(origin, 20, PersonOf, Avatar), Spaced(Text(NameOf(origin), 13.5, Ink, FontWeights.SemiBold), 8)));
        var facts = $"{(origin.Member is not null && origin.Session.Length > 0 ? $"· {origin.Session}　" : "")}· {Approvals.Clock(decision.CreatedAt)} に受付{(open && decision.Deadline is not null ? $"　· 期限 {LatticeStops.StopTime(decision.Deadline, Now())}" : "")}";
        sub.Children.Add(Spaced(Text(facts, 12.5, Muted), 10)); stack.Children.Add(sub);
        if (origin.External)
        {
            var info = Row(ApprovalsLook.Origin(origin, 40, PersonOf, Avatar), Spaced(new StackPanel { Children = { Text("BellTeamの外から届いた決裁です", 13.5, Ink, FontWeights.Bold),
                Text(string.Join(" · ", new[] { origin.Tool, origin.Via, origin.Session.Length > 0 ? $"セッション「{origin.Session}」" : "" }.Where(part => part.Length > 0)), 12, Muted) }, VerticalAlignment = VerticalAlignment.Center }, 12));
            var card = new Border { Child = info, CornerRadius = new CornerRadius(14), Padding = new Thickness(12), Margin = new Thickness(0, 6, 0, 6), Background = Brush(Muted, 0x12), BorderBrush = Brush(Line), BorderThickness = new Thickness(1) };
            System.Windows.Automation.AutomationProperties.SetAutomationId(card, "approvals-outside"); stack.Children.Add(card);
        }
        if (decision.Context is { Length: > 0 } context) { Section(stack, "doc", "背景"); stack.Children.Add(Linkified(context)); }
        Attachments(stack, decision);
        if (open && decision.Options?.FirstOrDefault(option => option.Recommended) is { } rec)
        { var line = Row(ApprovalsLook.Glyph("check", 14, Violet), Spaced(Text($"{origin.Who}の推奨：{rec.Label}", 13, Violet, FontWeights.SemiBold), 8)); line.Margin = new Thickness(0, 14, 0, 0); stack.Children.Add(line); }
        if (open) AnswerArea(stack, decision, origin); else Answered(stack, decision, origin);
        if (open)
        {
            var acts = new WrapPanel { Margin = new Thickness(0, 16, 0, 0) };
            var hold = Action(decision.Status == "held" ? "保留を戻す" : "保留にする", ""); hold.Click += (_, _) => _ = HoldAsync(decision); acts.Children.Add(Key(hold, "hold"));
            if (Approvals.LinkPanel(decision).Ids is { } ids) { var chart = Action("工程表で見る", ""); chart.Click += (_, _) => hub.OpenChart?.Invoke(ids.ProjectId, ids.CardId); acts.Children.Add(Key(chart, "chart")); }
            stack.Children.Add(acts);
            if (holdNotes.GetValueOrDefault(decision.Id!) is { } holdNote) stack.Children.Add(FailLine(holdNote, "approvals-hold-note"));
        }
        var rows = Approvals.HistoryRows(decision, Now());
        if (rows.Count > 0)
        {
            Section(stack, "hour", "経過");
            foreach (var item in rows)
            {
                var line = Row(Text(item.Time, 12, Muted), Spaced(Text(item.Text, 13, Ink), 10)); if (item.Amended) line.Children.Add(Spaced(ApprovalsLook.Badge(new ApprovalBadge("修正あり", "ind", "pencil")), 8)); line.Margin = new Thickness(0, 0, 0, 5); stack.Children.Add(line);
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
        Section(stack, "image", $"添付 {list.Length}");
        var wrap = new WrapPanel();
        foreach (var item in list)
        {
            var tile = new Border { Width = 96, Height = 72, CornerRadius = new CornerRadius(10), Background = Brush(Muted, 0x1A), Margin = new Thickness(0, 0, 8, 8), Child = ApprovalsLook.Glyph("image", 22, Muted) };
            var button = Plain(tile, $"{item.Name}を大きく開く"); var key = $"{decision.Id}/{item.Id}"; var id = decision.Id!; var attachment = item;
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
            var bytes = await Api.ApprovalAttachmentAsync(decisionId, item.Id ?? "");
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
        Section(stack, decision.Status == "cancelled" ? "xmark" : "seal", decision.Status == "cancelled" ? "取り下げ" : "答え");
        if (decision.Status == "cancelled") { stack.Children.Add(Text(decision.CancelReason is { Length: > 0 } reason ? $"{origin.Who}が取り下げました：{reason}" : $"{origin.Who}が取り下げました。", 14, Ink, null, TextWrapping.Wrap)); return; }
        stack.Children.Add(Text(Approvals.AnswerText(decision), 14.5, Ink, FontWeights.SemiBold, TextWrapping.Wrap));
        if (decision.Answer?.Attachments is { Length: > 0 } files) { var names = Text($"添付：{string.Join("、", files.Select(file => file.Name))}", 12.5, Muted, null, TextWrapping.Wrap); names.Margin = new Thickness(0, 4, 0, 0); stack.Children.Add(names); }
        var at = Row(); at.Margin = new Thickness(0, 8, 0, 0);
        if (Approvals.DeliveryBadge(decision) is { } badge) at.Children.Add(ApprovalsLook.Badge(badge));
        if (decision.Answer?.AnsweredAt is { } answered) at.Children.Add(Text(LatticeStops.StopTime(answered, Now()), 12, Muted));
        stack.Children.Add(at);
        var note = deliveryNotes.GetValueOrDefault(decision.Id!) ?? (decision.Delivery == "unknown" ? Approvals.DeliveryNote(decision) : null);
        if (note is null) return;
        var color = ApprovalsLook.Tone(note.Tone); var text = Text(note.Text, 13, color, FontWeights.SemiBold, TextWrapping.Wrap); text.Margin = new Thickness(0, 10, 0, 0); System.Windows.Automation.AutomationProperties.SetAutomationId(text, "approvals-delivery"); stack.Children.Add(text);
        if (note.Copy)
        {
            var copy = Action(copied == decision.Id ? "コピーしました" : "再開の文をコピー", ""); copy.Margin = new Thickness(0, 8, 0, 0); copy.HorizontalAlignment = HorizontalAlignment.Left; copy.Click += (_, _) => CopyResume(decision); stack.Children.Add(Key(copy, "copy"));
        }
    }

    // select an option -> the same place becomes the confirm -> 答える (never pre-selected, never sent by Return alone)
    private void AnswerArea(StackPanel stack, ViewDecision decision, ApprovalOriginView origin)
    {
        var mine = answer is { } a && a.Id == decision.Id ? a : null;
        if (mine is { Step: "sending" })
        {
            var sending = Row(Spinner(16), Spaced(Text("答えを送っています…", 14, Ink, FontWeights.SemiBold), 10)); sending.Margin = new Thickness(0, 18, 0, 0); System.Windows.Automation.AutomationProperties.SetAutomationId(sending, "approvals-sending"); stack.Children.Add(sending); return;
        }
        if (mine is { Step: "confirm" })
        {
            var box = new StackPanel(); var ask = Text(Approvals.ConfirmText(decision, mine.Label ?? "", mine.Text ?? ""), 14, Ink, FontWeights.SemiBold, TextWrapping.Wrap); System.Windows.Automation.AutomationProperties.SetAutomationId(ask, "approvals-confirm-text"); box.Children.Add(ask);
            if (mine.Text is { Length: > 0 } text) { var quote = Text(text, 13, Muted, null, TextWrapping.Wrap); quote.Margin = new Thickness(10, 8, 0, 0); box.Children.Add(quote); }
            if (mine.Note is { } note) box.Children.Add(FailLine(note, "approvals-answer-note"));
            var buttons = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 12, 0, 0) };
            var no = Action("やめる", ""); no.Click += (_, _) => CancelAnswer(true); buttons.Children.Add(Key(no, "cancel"));
            var yes = Action("答える", "", true); yes.Click += (_, _) => _ = SendAsync(decision, mine); buttons.Children.Add(Key(yes, "confirm")); box.Children.Add(buttons);
            var frame = new Border { Child = box, CornerRadius = new CornerRadius(14), Padding = new Thickness(14), Margin = new Thickness(0, 16, 0, 0), Background = Brush(Violet, 0x14), BorderBrush = Brush(Violet, 0x66), BorderThickness = new Thickness(1.4) };
            System.Windows.Automation.AutomationProperties.SetAutomationId(frame, "approvals-confirm"); stack.Children.Add(frame); return;
        }
        Section(stack, "target", "答えを選ぶ");
        foreach (var option in decision.Options ?? [])
        {
            var row = Row(ApprovalsLook.Glyph(option.Recommended ? "check" : "arrow", 14, option.Recommended ? Colors.White : Violet), Spaced(Text(option.Label ?? "", 14, option.Recommended ? Colors.White : Ink, FontWeights.SemiBold, TextWrapping.Wrap), 10));
            if (option.Recommended) row.Children.Add(Spaced(Pill(Text("推奨", 11.5, Violet, FontWeights.Bold), Colors.White, 0xE6, new Thickness(8, 1, 8, 1)), 10));
            var frame = new Border { Child = row, CornerRadius = new CornerRadius(12), Padding = new Thickness(14, 10, 14, 10), Margin = new Thickness(0, 0, 0, 8), Background = option.Recommended ? Brush(Violet) : Brush(Colors.White, 0xE0), BorderBrush = option.Recommended ? Brush(Violet) : Brush(Line), BorderThickness = new Thickness(1) };
            var button = Plain(frame, $"{option.Label}{(option.Recommended ? "、推奨" : "")}"); button.HorizontalContentAlignment = HorizontalAlignment.Stretch; var id = option.Id; var label = option.Label; button.Click += (_, _) => Ask(decision, id, label, null);
            stack.Children.Add(Key(button, "o:" + option.Id));
        }
        Section(stack, "pencil", "選ばずに、指示を書いて返す");
        var box2 = new TextBox { Text = draft.Id == decision.Id ? draft.Text : "", AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 64, MaxHeight = 140, FontSize = 14, Padding = new Thickness(8) };
        System.Windows.Automation.AutomationProperties.SetName(box2, "選ばずに、指示を書いて返す"); box2.TextChanged += (_, _) => draft = (decision.Id, box2.Text); Key(box2, "text"); stack.Children.Add(box2);
        var send = Action("指示を送る", ""); send.Margin = new Thickness(0, 8, 0, 0); send.HorizontalAlignment = HorizontalAlignment.Left;
        send.Click += (_, _) => { var text = box2.Text.Trim(); if (text.Length > 0) Ask(decision, null, null, text); }; stack.Children.Add(Key(send, "send-text"));
    }

    // ---- 工程とのつながり
    private FrameworkElement LinksColumn()
    {
        var decision = SelectedId is { } id ? Known(id) : null; var panel = decision is null ? null : Approvals.LinkPanel(decision);
        var stack = new StackPanel { Margin = new Thickness(16, 16, 16, 18) };
        stack.Children.Add(Row(ApprovalsLook.Glyph("link", 16, Violet), Spaced(Text("工程とのつながり", 16, Ink, FontWeights.Bold), 8)));
        var lead = Text(panel?.Kind == "linked" ? (decision!.Status == "answered" ? "この決裁は、工程表の1つの工程でした。" : "この決裁は、工程表の1つの工程になっています。答えると、その工程が済みになります。") : "BellTeamの工程表とつながる決裁は、ここに前後の工程が出ます。", 12.5, Muted, null, TextWrapping.Wrap);
        lead.Margin = new Thickness(0, 6, 0, 12); stack.Children.Add(lead);
        if (panel is null) { }
        else if (panel.Kind == "connecting") stack.Children.Add(Neutral(panel.Title, []));
        else if (panel.Kind == "unlinked") stack.Children.Add(Neutral(panel.Title, panel.Lines));
        else
        {
            foreach (var item in panel.Previous) stack.Children.Add(Mini(item, "前の工程", panel));
            var self = new Border { Child = Row(ApprovalsLook.Glyph("inbox", 16, Violet), Spaced(new StackPanel { Children = { Text(panel.Task?.Title ?? "", 13.5, Ink, FontWeights.Bold, TextWrapping.Wrap), Text(decision!.Status == "answered" ? "済み" : "この決裁の工程", 11.5, Violet) } }, 10)),
                CornerRadius = new CornerRadius(12), Padding = new Thickness(12, 9, 12, 9), Margin = new Thickness(0, 0, 0, 8), Background = Brush(Violet, 0x14), BorderBrush = Brush(Violet), BorderThickness = new Thickness(1.6) };
            System.Windows.Automation.AutomationProperties.SetAutomationId(self, "approvals-self"); stack.Children.Add(self);
            foreach (var item in panel.Next) stack.Children.Add(Mini(item, "次の工程", panel));
            var sentence = Text(panel.Sentence, 13, Ink, null, TextWrapping.Wrap); sentence.Margin = new Thickness(0, 6, 0, 10); System.Windows.Automation.AutomationProperties.SetAutomationId(sentence, "approvals-sentence"); stack.Children.Add(sentence);
            if (panel.Ids is { } ids) { var open = Action("工程表の工程を開く", "", true); open.HorizontalAlignment = HorizontalAlignment.Left; open.Click += (_, _) => hub.OpenChart?.Invoke(ids.ProjectId, ids.CardId); stack.Children.Add(Key(open, "chart2")); }
            if (panel.Chart.Length > 0) { var chart = Text($"工程表は「{panel.Chart}」です。", 12, Muted); chart.Margin = new Thickness(0, 8, 0, 0); stack.Children.Add(chart); }
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
        var button = Plain(frame, $"{item.Title}、工程表で開く"); button.HorizontalContentAlignment = HorizontalAlignment.Stretch; button.Click += (_, _) => hub.OpenChart?.Invoke(ids.ProjectId, card); return Key(button, "n:" + card);
    }
}
