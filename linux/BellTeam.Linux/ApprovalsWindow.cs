using System.Diagnostics;
using System.Security.Cryptography;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Input.Platform;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Threading;
using BellTeam.Core;
using static BellTeam.Linux.LatticeLook;

namespace BellTeam.Linux;

/// <summary>
/// The 決裁箱 window (docs/architecture/modules/approval-box-extension/screen-spec.md): its own window, one at a time, list | 詳細 | 工程とのつながり. It reads /api/approvals/* only, through the shared
/// <see cref="ApprovalsHub"/> feed (summary, stream) and its own list reads; saves nothing; closing drops the drawing. State here: the tab, the 出どころ filter, the selected decision, the step of one answer
/// (with its Idempotency-Key) and the connect request. Every failure view leaves on its own or by one action on the same screen.
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
    private List<ViewDecision>? open;                  // 待ち + 保留; null = not read yet
    private List<ViewDecision> done = [];
    private string? doneCursor; private bool doneRead, loadingOpen, loadingDone, openAgain;
    private string? listProblem;
    internal string? SelectedId { get; private set; }
    private Step step = Step.None; private string? chosenId, chosenLabel, key, stepMessage, writeText = "";
    private string? banner; private ApprovalDeliveryNote? note; private string? noteFor;
    private Connect connect = Connect.Idle; private string? connectNote, connectUrl; private CancellationTokenSource? connectLoop;
    private bool copied;

    internal ApprovalsWindow(ApprovalsHub hub, LinuxWorkspace workspace, Action<string, string> openCard, Action<string> openChat)
    {
        this.hub = hub; this.workspace = workspace; this.openCard = openCard; this.openChat = openChat;
        Title = "決裁箱"; Width = 1360; Height = 860; MinWidth = 1100; MinHeight = 640; UseLayoutRounding = true; Background = BellTheme.ConversationBackground;
        root.RowDefinitions = new RowDefinitions("Auto,*"); root.Children.Add(toolbarHost); Grid.SetRow(body, 1); root.Children.Add(body); Content = root;
        hub.Changed += OnHub; hub.DecisionsChanged += OnDecisions;
        Activated += (_, _) => hub.Refresh();
        AddHandler(KeyDownEvent, (_, e) => { if (e.Key == Key.Escape && Back()) e.Handled = true; }, Avalonia.Interactivity.RoutingStrategies.Tunnel);
        Closed += (_, _) => { hub.Changed -= OnHub; hub.DecisionsChanged -= OnDecisions; life.Cancel(); connectLoop?.Cancel(); if (ReferenceEquals(Current, this)) Current = null; };
        hub.Sync(); hub.Refresh();
        Render();
        if (Status == ApprovalFeedStatus.Live) _ = ReadOpenAsync();
    }
    private readonly Action<string> openChat;

    private ApprovalFeedStatus Status => hub.Feed?.Status ?? ApprovalFeedStatus.Connecting;
    private ApprovalSummary? Summary => hub.Feed?.Summary;
    private IEnumerable<ViewDecision> All => (open ?? []).Concat(done);
    /// <summary>The render seam: true once the first read of the shown tab is drawn, or a failure view stands.</summary>
    internal bool Settled => Status is not (ApprovalFeedStatus.Connecting or ApprovalFeedStatus.Drop or ApprovalFeedStatus.Live) || Status == ApprovalFeedStatus.Live && open is not null && (tab != "done" || doneRead);
    internal async Task PreviewAsync(string tabName, string? id, int? option, bool writing = false)
    {
        SetTab(tabName); if (tabName == "done") for (var i = 0; i < 200 && !doneRead; i++) await Task.Delay(20);
        if (id is not null) Pick(id);
        if (Selected is { } decision && option is { } index && decision.Options is { } options && index < options.Length) ChooseOption(decision, options[index]);
        if (writing) StartWriting();
    }
    internal ViewDecision? Selected => SelectedId is null ? null : All.FirstOrDefault(item => item.Id == SelectedId);

    /// <summary>決裁を開く from a 工程表 詳細, or a deep link: the 待ち list with that decision selected once it is read.</summary>
    internal void Select(string? id)
    {
        SelectedId = id; ResetStep(); note = null; banner = null;
        if (id is not null && All.FirstOrDefault(item => item.Id == id) is { } found) tab = found.Status switch { "held" => "held", "pending" => "pending", _ => "done" };
        if (id is not null && Selected is null && open is not null) _ = ReadOneAsync(id);
        Render();
    }
    private async Task ReadOneAsync(string id)
    {
        var read = await workspace.Management.Api.ApprovalAsync(id, life.Token);
        if (read.Decision is not { } decision) return;
        Put(decision); tab = decision.Status switch { "held" => "held", "pending" => "pending", _ => "done" }; Render();
    }

    // ---- reading
    private void OnHub() { if (hub.Feed?.Status == ApprovalFeedStatus.Live) { listProblem = null; if (open is null) _ = ReadOpenAsync(); } Render(); }
    private void OnDecisions() { if (Status != ApprovalFeedStatus.Live) return; _ = ReadOpenAsync(); if (tab == "done" || doneRead) { doneRead = false; if (tab == "done") _ = ReadDoneAsync(false); } }

    /// <summary>GET ?status=pending,held. Reads that arrive while one runs are folded into one more read after it; a failure waits on the 1, 2, 4 … 30 s backoff until it reads or the window closes.</summary>
    private async Task ReadOpenAsync()
    {
        if (loadingOpen) { openAgain = true; return; }
        loadingOpen = true; var attempt = 0;
        try
        {
            do
            {
                openAgain = false;
                var read = await workspace.Management.Api.ApprovalListAsync("pending,held", null, life.Token);
                if (read.List is { } list) { open = (list.Items ?? []).ToList(); listProblem = null; Render(); attempt = 0; continue; }
                if (read.Failure is { } failure && Approvals.IsTerminal(failure)) { hub.ReadAgain(); return; }
                listProblem = Approvals.Reconnect; Render();
                await Task.Delay(Approvals.BackoffMs(attempt++), life.Token); openAgain = true;
            } while (openAgain && !life.IsCancellationRequested);
        }
        catch (OperationCanceledException) { }
        finally { loadingOpen = false; }
    }

    private async Task ReadDoneAsync(bool more)
    {
        if (loadingDone) return;
        loadingDone = true;
        try
        {
            var read = await workspace.Management.Api.ApprovalListAsync("answered,cancelled", more ? doneCursor : null, life.Token);
            if (read.List is { } list) { done = (more ? done : []).Concat(list.Items ?? []).ToList(); doneCursor = list.NextCursor; doneRead = true; listProblem = null; }
            else if (read.Failure is { } failure && Approvals.IsTerminal(failure)) hub.ReadAgain();
            else listProblem = Approvals.Reconnect;
        }
        catch (OperationCanceledException) { }
        finally { loadingDone = false; }
        Render();
    }

    /// <summary>One decision replaced everywhere it is listed; a decision that is no longer open moves to 済み.</summary>
    private void Put(ViewDecision decision)
    {
        open ??= [];
        open.RemoveAll(item => item.Id == decision.Id); done.RemoveAll(item => item.Id == decision.Id);
        if (decision.Status is "pending" or "held") open.Add(decision); else done.Insert(0, decision);
        open = Sorted(open);
    }
    // 急ぎ first, nearer 期限, older first (Approval Box's order, kept after a local replace).
    private static List<ViewDecision> Sorted(IEnumerable<ViewDecision> items) => items.OrderBy(item => item.Urgency == "high" ? 0 : 1)
        .ThenBy(item => DateTimeOffset.TryParse(item.Deadline, out var at) ? at : DateTimeOffset.MaxValue).ThenBy(item => DateTimeOffset.TryParse(item.CreatedAt, out var created) ? created : DateTimeOffset.MaxValue).ToList();

    // ---- navigation
    private void ResetStep() { step = Step.None; chosenId = chosenLabel = key = stepMessage = null; writeText = ""; copied = false; }
    private bool Back() { if (step is Step.Choose or Step.Writing or Step.Confirm) { ResetStep(); Render(); return true; } return false; }
    // The phone's back key: a step goes back first, then the detail goes back to the list (Compact), then the page closes.
    public bool GoBack() { if (Back()) return true; if (Compact && SelectedId is not null) { SelectedId = null; Render(); return true; } return false; }
    internal void SetTab(string value) { tab = value; SelectedId = null; ResetStep(); note = null; banner = null; if (value == "done" && !doneRead) _ = ReadDoneAsync(false); Render(); }
    internal void Pick(string id) { if (SelectedId == id) return; SelectedId = id; ResetStep(); note = null; banner = null; Render(); }

    // ---- answering
    private void ChooseOption(ViewDecision decision, ApprovalOption option) { step = Step.Choose; chosenId = option.Id; chosenLabel = option.Label; if (key is null) key = Guid.NewGuid().ToString(); stepMessage = null; Render(); }
    private void StartWriting() { step = Step.Writing; chosenId = null; chosenLabel = null; key = null; stepMessage = null; Render(); }
    private void ConfirmWriting() { step = Step.Confirm; key ??= Guid.NewGuid().ToString(); stepMessage = null; Render(); }

    private async Task SendAsync(ViewDecision decision)
    {
        var text = step == Step.Confirm ? writeText : null; var optionId = step == Step.Confirm ? null : chosenId; var sendKey = key ?? Guid.NewGuid().ToString(); key = sendKey;
        step = Step.Sending; stepMessage = null; Render();
        ApprovalResponse reply;
        try { reply = await workspace.Management.Api.ApprovalAnswerAsync(decision.Id!, optionId, text, decision.Version, sendKey, life.Token); }
        catch (OperationCanceledException) { return; }
        var outcome = reply.LoginRequired ? new ApprovalOutcome("retry", Message: "ログインが必要です。ログインし直してください。") : Approvals.AnswerOutcome(reply.Status, reply.Body);
        var wasText = text is not null;
        switch (outcome.Kind)
        {
            case "ok" when reply.Decision is { } answered:
                Put(answered); ResetStep(); note = Approvals.DeliveryNote(answered); noteFor = answered.Id; banner = null; tab = "pending"; break;
            case "conflict" when outcome.Decision is { } latest:
                Put(latest); ResetStep(); banner = Approvals.Amended(Approvals.OriginOf(latest).Who); note = null; break;
            case "gone":
                open?.RemoveAll(item => item.Id == decision.Id); SelectedId = null; ResetStep(); break;
            case "retry" or "stop":
                step = wasText ? Step.Confirm : Step.Choose; stepMessage = outcome.Message ?? Approvals.Retry;
                if (outcome.Kind == "stop") hub.ReadAgain();
                break;
            default: step = wasText ? Step.Confirm : Step.Choose; stepMessage = Approvals.Retry; break;
        }
        Render();
    }

    private async Task ToggleHoldAsync(ViewDecision decision)
    {
        var read = await workspace.Management.Api.ApprovalHoldAsync(decision.Id!, decision.Status != "held", life.Token);
        if (read.Decision is { } updated) { Put(updated); stepMessage = null; ResetStep(); }
        else stepMessage = Approvals.HoldFailed;
        Render();
    }

    private async Task CopyResumeAsync(ViewDecision decision)
    {
        if (Clipboard is { } clipboard && decision.ResumePhrase is { Length: > 0 } phrase) await clipboard.SetTextAsync(phrase);
        copied = true; Render();
        await Task.Delay(2000); copied = false; if (!life.IsCancellationRequested) Render();
    }

    // ---- つなぐ (screen-spec 「つなぐ」): the module asks Approval Box for a request and polls; the app only opens the page and reads the state.
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
            if (start.Failure is ApprovalFailure.NotEntitled or ApprovalFailure.Expired or ApprovalFailure.Old) { connect = Connect.Idle; hub.ReadAgain(); return; }
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
                case "connected": connect = Connect.Idle; hub.ReadAgain(); return;
                case "denied": connect = Connect.Denied; Render(); return;
                case "waiting": break;
                case "not_connected" or "expired": connect = Connect.Idle; connectNote = "許可の待ち時間が過ぎました。もう一度つないでください。"; Render(); return;
            }
        }
    }
    private async Task StopConnectAsync()
    {
        connectLoop?.Cancel(); connect = Connect.Idle; connectNote = null; Render();
        try { await workspace.Management.Api.ApprovalStopConnectAsync(life.Token); } catch (OperationCanceledException) { }
    }
    private static bool OpenUrl(string url)
    {
        try { Process.Start(new ProcessStartInfo("xdg-open", url) { UseShellExecute = false }); return true; }
        catch (Exception) { return false; }
    }
    internal static bool OpenWebLink(string url) => (url.StartsWith("https://", StringComparison.Ordinal) || url.StartsWith("http://", StringComparison.Ordinal)) && OpenUrl(url);
}
