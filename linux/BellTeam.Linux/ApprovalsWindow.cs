using System.Diagnostics;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Input.Platform;
using Avalonia.Layout;
using Avalonia.Media;
using BellTeam.Core;
using static BellTeam.Linux.LatticeLook;

namespace BellTeam.Linux;

/// <summary>
/// The 決裁箱 window (docs/architecture/modules/approval-box-extension/screen-spec.md): its own window, one at a time, list | 詳細 | 工程とのつながり. Since the /v1 close (2026-12-12) the list is this device's
/// peer-channel book only (<see cref="ApprovalsHub.DeviceViews"/>); it answers, holds and reads images through that session and saves nothing. BellTeam's server is asked only for the id-level chart link
/// (by-decision) and for the one 工程表との連携 connection. State here: the tab, the 出どころ filter, the selected decision, the step of one answer and the connect request.
/// </summary>
internal sealed partial class ApprovalsWindow : Window, IPageBack
{
    public static ApprovalsWindow? Current { get; private set; }
    public static ApprovalsWindow Open(ApprovalsHub hub, LinuxWorkspace workspace, Action<string, string> openCard, Action<string> openChat)
        => Current ??= new ApprovalsWindow(hub, workspace, openCard, openChat);

    private enum Step { None, Choose, Writing, Confirm, Sending }
    private enum Connect { Idle, Opening, Waiting, Denied }

    private readonly ApprovalsHub hub;
    private readonly LinuxWorkspace workspace;
    private readonly Action<string, string> openCard;
    private readonly Grid root = new();
    private readonly ContentControl toolbarHost = new(), body = new();
    private readonly CancellationTokenSource life = new();
    internal Func<DateTimeOffset> Now { get; set; } = () => DateTimeOffset.UtcNow;

    private string tab = "pending", filter = "all";
    internal string? SelectedId { get; private set; }
    private Step step = Step.None; private string? chosenId, chosenLabel, stepMessage, writeText = "";
    private string? banner; private ApprovalDeliveryNote? note; private string? noteFor;
    private Connect connect = Connect.Idle; private string? connectNote, connectUrl; private CancellationTokenSource? connectLoop;
    private bool linkOpen; private string? linkState;   // the 工程表との連携 panel (connected / not_connected, null = not read yet or not readable)
    private bool copied;

    internal ApprovalsWindow(ApprovalsHub hub, LinuxWorkspace workspace, Action<string, string> openCard, Action<string> openChat)
    {
        this.hub = hub; this.workspace = workspace; this.openCard = openCard; this.openChat = openChat;
        Title = "決裁箱"; Width = 1360; Height = 860; MinWidth = 1100; MinHeight = 640; UseLayoutRounding = true; Background = BellTheme.ConversationBackground;
        root.RowDefinitions = new RowDefinitions("Auto,*"); root.Children.Add(toolbarHost); Grid.SetRow(body, 1); root.Children.Add(body); Content = root;
        hub.Changed += OnHub; hub.DeviceChanged += OnDevice;
        Activated += (_, _) => hub.ReadLinks();
        AddHandler(KeyDownEvent, (_, e) => { if (e.Key == Key.Escape && Back()) e.Handled = true; }, Avalonia.Interactivity.RoutingStrategies.Tunnel);
        Closed += (_, _) => { hub.Changed -= OnHub; hub.DeviceChanged -= OnDevice; life.Cancel(); connectLoop?.Cancel(); if (ReferenceEquals(Current, this)) Current = null; };
        hub.ReadLinks();
        Render();
    }
    private readonly Action<string> openChat;

    private ApprovalSummary? Summary => hub.Summary;
    private IDeviceDecisions? Device => hub.Device;
    private bool DeviceLive => Device?.State.Status == BellTeam.PeerChannel.RuntimeStatus.Live;
    /// <summary>The device's list can be shown: it is live, or it already holds decisions (a held list stays while the connection is down).</summary>
    internal bool DeviceUsable => Device is { } d && (d.State.Status == BellTeam.PeerChannel.RuntimeStatus.Live || d.Book.All.Count > 0);
    private IReadOnlyList<ViewDecision> All => hub.DeviceViews;
    private List<ViewDecision> OpenView => Sorted(All.Where(item => item.Status is "pending" or "held"));
    private List<ViewDecision> DoneView => [.. All.Where(item => item.Status is not ("pending" or "held")).OrderByDescending(item => Approvals.DoneAt(item))];
    /// <summary>The render seam: the window is drawn from what the device holds, so it is settled once the device has left its first connect.</summary>
    internal bool Settled => Device is null || Device.State.Status != BellTeam.PeerChannel.RuntimeStatus.Connecting;
    internal async Task PreviewAsync(string tabName, string? id, int? option, bool writing = false)
    {
        SetTab(tabName);
        if (id is not null) Pick(id);
        if (Selected is { } decision && option is { } index && decision.Options is { } options && index < options.Length) ChooseOption(decision, options[index]);
        if (writing) StartWriting();
        await Task.CompletedTask;
    }
    internal ViewDecision? Selected => SelectedId is null ? null : All.FirstOrDefault(item => item.Id == SelectedId);

    /// <summary>決裁を開く from a 工程表 詳細, or a deep link: the list with that decision selected when the device holds it (nothing to open otherwise).</summary>
    internal void Select(string? id)
    {
        ResetStep(); note = null; banner = null; linkOpen = false;
        var found = id is null ? null : All.FirstOrDefault(item => item.Id == id);
        SelectedId = found?.Id;   // a decision this device does not hold has nothing to open
        if (found is not null) tab = found.Status switch { "held" => "held", "pending" => "pending", _ => "done" };
        Render();
    }

    // ---- reading: the device only
    // A device answer stays "sending" until the connector's result frame closes the decision in the book; then the step ends here.
    private void OnDevice()
    {
        if (step == Step.Sending && SelectedId is { } id && All.FirstOrDefault(item => item.Id == id) is { } decision && decision.Status is not ("pending" or "held"))
        { ResetStep(); note = Approvals.DeliveryNote(decision); noteFor = decision.Id; banner = null; tab = "pending"; }
        Render();
    }
    private void OnHub() => Render();

    // 急ぎ first, nearer 期限, older first (Approval Box's order).
    private static List<ViewDecision> Sorted(IEnumerable<ViewDecision> items) => items.OrderBy(item => item.Urgency == "high" ? 0 : 1)
        .ThenBy(item => DateTimeOffset.TryParse(item.Deadline, out var at) ? at : DateTimeOffset.MaxValue).ThenBy(item => DateTimeOffset.TryParse(item.CreatedAt, out var created) ? created : DateTimeOffset.MaxValue).ToList();

    // ---- navigation
    private void ResetStep() { step = Step.None; chosenId = chosenLabel = stepMessage = null; writeText = ""; copied = false; }
    private bool Back() { if (step is Step.Choose or Step.Writing or Step.Confirm) { ResetStep(); Render(); return true; } if (linkOpen) { linkOpen = false; Render(); return true; } return false; }
    // The phone's back key: a step goes back first, then the link panel, then the detail goes back to the list (Compact), then the page closes.
    public bool GoBack() { if (Back()) return true; if (Compact && SelectedId is not null) { SelectedId = null; Render(); return true; } return false; }
    internal void SetTab(string value) { tab = value; SelectedId = null; ResetStep(); note = null; banner = null; linkOpen = false; Render(); }
    internal void Pick(string id) { if (SelectedId == id) return; SelectedId = id; ResetStep(); note = null; banner = null; Render(); }

    // ---- answering: through this device's session (the connector signs nothing for the person)
    private void ChooseOption(ViewDecision decision, ApprovalOption option) { step = Step.Choose; chosenId = option.Id; chosenLabel = option.Label; stepMessage = null; Render(); }
    private void StartWriting() { step = Step.Writing; chosenId = null; chosenLabel = null; stepMessage = null; Render(); }
    private void ConfirmWriting() { step = Step.Confirm; stepMessage = null; Render(); }

    private async Task SendAsync(ViewDecision decision)
    {
        if (Device is not { } device) return;
        var text = step == Step.Confirm ? writeText : null; var optionId = step == Step.Confirm ? null : chosenId; var wasText = text is not null;
        step = Step.Sending; stepMessage = null; Render();
        BellTeam.PeerChannel.SendOutcome outcome;
        try { outcome = await device.AnswerAsync(decision.Id!, optionId, text); }
        catch (BellTeam.PeerChannel.NoSessionException) { outcome = new("no_session"); }
        catch (Exception error) when (error is InvalidOperationException or KeyNotFoundException or ArgumentException) { outcome = new("gone"); }
        if (life.IsCancellationRequested) return;
        switch (outcome.Ack)
        {
            case "ok": break;   // stays "sending" until the result frame closes the decision in the book (OnDevice)
            case "refused:stale_version": ResetStep(); banner = Approvals.Amended(Approvals.OriginOf(decision).Who); note = null; break;
            case "refused:already_decided" or "gone": ResetStep(); break;
            case "unknown": step = wasText ? Step.Confirm : Step.Choose; stepMessage = Approvals.DeviceUnknown; break;
            default: step = wasText ? Step.Confirm : Step.Choose; stepMessage = Approvals.Retry; break;
        }
        Render();
    }

    private async Task ToggleHoldAsync(ViewDecision decision)
    {
        if (Device is not { } device) return;
        BellTeam.PeerChannel.SendOutcome outcome;
        try { outcome = await device.HoldAsync(decision.Id!, decision.Status != "held"); }
        catch (Exception error) when (error is BellTeam.PeerChannel.NoSessionException or InvalidOperationException or KeyNotFoundException) { outcome = new("no_session"); }
        ResetStep(); stepMessage = outcome.Ack == "ok" ? null : Approvals.HoldFailed; Render();
    }

    private async Task CopyResumeAsync(ViewDecision decision)
    {
        if (Clipboard is { } clipboard && decision.ResumePhrase is { Length: > 0 } phrase) await clipboard.SetTextAsync(phrase);
        copied = true; Render();
        await Task.Delay(2000); copied = false; if (!life.IsCancellationRequested) Render();
    }

    // ---- 工程表との連携 (Delta 2026-11-23): the one BellTeam-to-Approval Box connection the server-side link engine needs (entitlement through /v1/me). Not a gate on the list.
    internal Task OpenLinkForRenderAsync() => OpenLinkAsync();
    private async Task OpenLinkAsync() { linkOpen = true; connectNote = null; Render(); await ReadConnectionAsync(); }
    private async Task ReadConnectionAsync()
    {
        try
        {
            var read = await workspace.Management.Api.ApprovalConnectionAsync(life.Token);
            linkState = read.Connection?.State is { } state ? (state == "connected" ? "connected" : "not_connected") : null;
        }
        catch (OperationCanceledException) { return; }
        if (!life.IsCancellationRequested) Render();
    }
    private async Task StartConnectAsync()
    {
        connectLoop?.Cancel(); var loop = connectLoop = CancellationTokenSource.CreateLinkedTokenSource(life.Token);
        connect = Connect.Opening; connectNote = null; Render();
        try
        {
            var start = await workspace.Management.Api.ApprovalConnectAsync(loop.Token);
            if (start.Start?.AuthorizationUrl is { } url && url.StartsWith("https://", StringComparison.Ordinal))
            {
                connectUrl = url; if (!OpenUrl(url)) connectNote = "決裁箱の画面が開かなかったようです。「もう一度開く」を押してください。";
                connect = Connect.Waiting; Render(); await PollConnectAsync(loop.Token); return;
            }
            connect = Connect.Idle; connectNote = Approvals.ConnectFailed; Render();
        }
        catch (OperationCanceledException) { }
    }
    private async Task PollConnectAsync(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            await Task.Delay(2000, token);
            var read = await workspace.Management.Api.ApprovalConnectionAsync(token);
            switch (read.Connection?.State)
            {
                case "connected": connect = Connect.Idle; linkState = "connected"; Render(); return;
                case "denied": connect = Connect.Denied; Render(); return;
                case "waiting": break;
                case "not_connected" or "expired": connect = Connect.Idle; connectNote = "許可の待ち時間が過ぎました。もう一度つないでください。"; linkState = "not_connected"; Render(); return;
            }
        }
    }
    private async Task StopConnectAsync()
    {
        connectLoop?.Cancel(); connect = Connect.Idle; connectNote = null; Render();
        try { await workspace.Management.Api.ApprovalStopConnectAsync(life.Token); } catch (OperationCanceledException) { }
    }
    private async Task DisconnectAsync()
    {
        try { await workspace.Management.Api.ApprovalDisconnectAsync(life.Token); } catch (OperationCanceledException) { return; }
        await ReadConnectionAsync();
    }
    private static bool OpenUrl(string url)
    {
        try { Process.Start(new ProcessStartInfo("xdg-open", url) { UseShellExecute = false }); return true; }
        catch (Exception) { return false; }
    }
    internal static bool OpenWebLink(string url) => (url.StartsWith("https://", StringComparison.Ordinal) || url.StartsWith("http://", StringComparison.Ordinal)) && OpenUrl(url);
}
