using System.ComponentModel;
using Avalonia.Threading;
using BellTeam.Core;

namespace BellTeam.Linux;

/// <summary>
/// The one 決裁箱 reader of the app (the entry row and the 決裁箱 window share it): the Approval Box client (Kitepon.ApprovalBox.Client: /v1 or this device's peer-channel session, the server picks)
/// plus the id-level link lookup (<see cref="ApprovalLinks"/>) for the badge and the 工程とのつながり panel. Holds nothing stored. Everything reaches the screen on the UI thread.
/// </summary>
internal sealed class ApprovalsHub : IDisposable
{
    private readonly LinuxWorkspace workspace;
    private readonly CancellationTokenSource life = new();
    private string origin = "";
    /// <summary>The Approval Box client of this machine (null: this build has none, the screen says so).</summary>
    internal IApprovalSource? Source { get; }
    internal ApprovalLinks Links { get; } = new();
    /// <summary>Starts the Approval Box web sign-in of the second library instance (set when that instance exists; the 「Approval Boxにサインイン」 button shows only then).</summary>
    internal Action? SignInApprovalBox { get; set; }
    /// <summary>The Approval Box web sign-in is open in the browser (SigningIn); 「やめる」 calls CancelSignIn. The note is why the last try ended, if it did not end by the person's own choice.</summary>
    internal bool SigningIn { get; private set; }
    internal string? SignInNote { get; private set; }
    internal Action? CancelSignIn { get; set; }
    /// <summary>NeedsApproval -> Waiting and back (5.3): the code and QR of the Waiting state are the component's (State.Offer); these two are its requestApproval / cancelApproval.</summary>
    internal Action? RequestApproval { get; set; }
    internal Action? CancelApproval { get; set; }
    internal void SetSignIn(bool signingIn, string? note = null) { SigningIn = signingIn; SignInNote = note; Run(() => Changed?.Invoke()); }
    /// <summary>The device's book, connection or links changed: the open window repaints.</summary>
    internal event Action? DeviceChanged;
    /// <summary>「Approval Boxからサインアウト」: the account's sign-out (BellTeam's own sign-in is not touched). Set when the account exists.</summary>
    internal Action? SignOutApprovalBox { get; set; }
    /// <summary>The device's decisions as the screen draws them, each joined with its chart link when that is known.</summary>
    internal IReadOnlyList<ViewDecision> DeviceViews => Source is null ? [] : [.. Source.Decisions.Select(Links.Join)];
    /// <summary>The counts of the entry row and the toolbar: what the device holds (null without a device).</summary>
    internal ApprovalSummary? Summary => Source is null ? null : DeviceSummary.Of(DeviceViews, DateTimeOffset.UtcNow);
    /// <summary>The summary or the device's state changed (UI thread).</summary>
    public event Action? Changed;

    public ApprovalsHub(LinuxWorkspace workspace, IApprovalSource? source = null)
    {
        this.workspace = workspace; Source = source;
        if (source is not null) source.Changed += () => Notify(readLinks: true);
        workspace.PropertyChanged += OnWorkspace;
        _ = AskNotLinkedAgainAsync();
    }

    // A decision the engine answered 404 for is asked again every 30 s while one exists (contract: the first answer ends 「つなげています」, a 404 never stays).
    private async Task AskNotLinkedAgainAsync()
    {
        try { while (true) { await Task.Delay(TimeSpan.FromSeconds(30), life.Token); if (Links.AnyNotLinked) Run(ReadLinks); } }
        catch (OperationCanceledException) { }
    }

    private void OnWorkspace(object? sender, PropertyChangedEventArgs args)
    {
        if (args.PropertyName is nameof(LinuxWorkspace.Connected) or nameof(LinuxWorkspace.Server)) Run(ReadLinks);
    }
    // One repaint at a time, at most one queued: the /v1 stream replays the account's whole history at launch and every event used to repaint the whole list on the UI thread (a repaint of 250 decisions is ~300 ms).
    private int notifyQueued, linksWanted;
    private void Notify(bool readLinks)
    {
        if (readLinks) Volatile.Write(ref linksWanted, 1);
        if (Interlocked.Exchange(ref notifyQueued, 1) == 1) return;
        Run(() => { Volatile.Write(ref notifyQueued, 0); Changed?.Invoke(); DeviceChanged?.Invoke(); if (Interlocked.Exchange(ref linksWanted, 0) == 1) ReadLinks(); });
    }

    private static void Run(Action action) { if (Dispatcher.UIThread.CheckAccess()) action(); else Dispatcher.UIThread.Post(action); }

    /// <summary>Asks BellTeam which of the device's decisions are linked to a chart task (a changed server forgets the answers).</summary>
    internal void ReadLinks()
    {
        if (!workspace.Connected || Source is null) return;
        if (origin != workspace.Server) { origin = workspace.Server; Links.Forget(); }
        BellApi api; try { api = workspace.Management.Api; } catch (BellApiException) { return; }   // the workspace closed or has no server yet: the links stay unknown (a failed link draws nothing)
        _ = Links.ReadAsync(api, DeviceViews, () => Notify(readLinks: false), life.Token);
    }

    public void Dispose() { workspace.PropertyChanged -= OnWorkspace; life.Cancel(); }
}

/// <summary>The counts the entry row and the toolbar show, from the device's decisions alone.</summary>
internal static class DeviceSummary
{
    internal static ApprovalSummary Of(IEnumerable<ViewDecision> device, DateTimeOffset now)
    {
        var list = device.ToList(); bool Today(string? at) => Approvals.DayHeading(at, now) == "今日";
        return new ApprovalSummary
        {
            Schema = Approvals.SummarySchema,
            Pending = list.Count(item => item.Status == "pending"),
            Held = list.Count(item => item.Status == "held"),
            Urgent = list.Count(item => item.Status is "pending" or "held" && item.Urgency == "high"),
            AnsweredToday = list.Count(item => item.Status == "answered" && Today(Approvals.DoneAt(item))),
            FiledToday = list.Count(item => Today(item.CreatedAt)),
        };
    }
}
