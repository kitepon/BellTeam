using System.ComponentModel;
using Avalonia.Threading;
using BellTeam.Core;

namespace BellTeam.Linux;

/// <summary>
/// The one 決裁箱 reader of the app (the entry row and the 決裁箱 window share it): this device's peer-channel session (the list is the device's book only since the /v1 close, 2026-12-12)
/// plus the id-level link lookup (<see cref="ApprovalLinks"/>) for the badge and the 工程とのつながり panel. Holds nothing stored. Everything reaches the screen on the UI thread.
/// </summary>
internal sealed class ApprovalsHub : IDisposable
{
    private readonly LinuxWorkspace workspace;
    private readonly CancellationTokenSource life = new();
    private string origin = "";
    /// <summary>This device's peer-channel session while the device part is on (null: it is off or this machine has no engine: the screen says so).</summary>
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
    internal void SetOffer(ApprovalOffer? offer, string? note = null) { Offer = offer; OfferNote = note; Run(() => Changed?.Invoke()); }
    internal void SetSignIn(bool signingIn, string? note = null) { SigningIn = signingIn; SignInNote = note; Run(() => Changed?.Invoke()); }
    /// <summary>The device's book, connection or links changed: the open window repaints.</summary>
    internal event Action? DeviceChanged;
    /// <summary>The device's decisions as the screen draws them, each joined with its chart link when that is known.</summary>
    internal IReadOnlyList<ViewDecision> DeviceViews => Device is null ? [] : [.. Device.Book.All.Select(DeviceDecisionView.Of).Select(Links.Join)];
    /// <summary>The counts of the entry row and the toolbar: what the device holds (null without a device).</summary>
    internal ApprovalSummary? Summary => Device is null ? null : DeviceSummary.Of(DeviceViews, DateTimeOffset.UtcNow);
    /// <summary>The summary or the device's state changed (UI thread).</summary>
    public event Action? Changed;

    public ApprovalsHub(LinuxWorkspace workspace, IDeviceDecisions? device = null)
    {
        this.workspace = workspace; Device = device;
        if (device is not null) device.Changed += () => Run(() => { Changed?.Invoke(); DeviceChanged?.Invoke(); ReadLinks(); });
        workspace.PropertyChanged += OnWorkspace;
    }

    private void OnWorkspace(object? sender, PropertyChangedEventArgs args)
    {
        if (args.PropertyName is nameof(LinuxWorkspace.Connected) or nameof(LinuxWorkspace.Server)) Run(ReadLinks);
    }
    private static void Run(Action action) { if (Dispatcher.UIThread.CheckAccess()) action(); else Dispatcher.UIThread.Post(action); }

    /// <summary>Asks BellTeam which of the device's decisions are linked to a chart task (a changed server forgets the answers).</summary>
    internal void ReadLinks()
    {
        if (!workspace.Connected || Device is null) return;
        if (origin != workspace.Server) { origin = workspace.Server; Links.Forget(); }
        _ = Links.ReadAsync(workspace.Management.Api, DeviceViews, () => Run(() => { Changed?.Invoke(); DeviceChanged?.Invoke(); }), life.Token);
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
