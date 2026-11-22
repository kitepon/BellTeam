using System.ComponentModel;
using Avalonia.Threading;
using BellTeam.Core;

namespace BellTeam.Linux;

/// <summary>
/// The one 決裁箱 reader of the app (the entry row and the 決裁箱 window share it): an <see cref="ApprovalsFeed"/> on the connected server, started when the app connects, replaced when the server changes,
/// stopped when it disconnects. Core's feed raises on a worker thread; everything here reaches the screen on the UI thread. Holds nothing stored: the server is the source.
/// </summary>
internal sealed class ApprovalsHub : IDisposable
{
    private readonly LinuxWorkspace workspace;
    private string origin = "";
    /// <summary>This device's peer-channel session while both ways are open (null: only the server read, nothing changes: Android, arm64, the switch off).</summary>
    internal IDeviceDecisions? Device { get; }
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
    /// <summary>The device's book or connection changed: the open window repaints.</summary>
    internal event Action? DeviceChanged;
    public ApprovalsFeed? Feed { get; private set; }
    /// <summary>The summary, the status or the feed itself changed (UI thread).</summary>
    public event Action? Changed;
    /// <summary>A decision was created / updated / deleted, or the stream came back (UI thread): the open window reads again.</summary>
    public event Action? DecisionsChanged;

    public ApprovalsHub(LinuxWorkspace workspace, IDeviceDecisions? device = null)
    {
        this.workspace = workspace; Device = device;
        if (device is not null) device.Changed += () => Run(() => { Changed?.Invoke(); DeviceChanged?.Invoke(); });
        workspace.PropertyChanged += OnWorkspace;
    }

    private void OnWorkspace(object? sender, PropertyChangedEventArgs args)
    {
        if (args.PropertyName is nameof(LinuxWorkspace.Connected) or nameof(LinuxWorkspace.Server)) Run(Sync);
    }
    private static void Run(Action action) { if (Dispatcher.UIThread.CheckAccess()) action(); else Dispatcher.UIThread.Post(action); }

    /// <summary>Starts, replaces or stops the feed for what the workspace is connected to.</summary>
    public void Sync()
    {
        if (!workspace.Connected) { Feed?.Stop(); return; }
        if (Feed is not null && origin == workspace.Server) { if (!Feed.Running) Feed.Start(); return; }
        Feed?.Stop();
        origin = workspace.Server;
        var feed = Feed = new ApprovalsFeed(workspace.Management.Api);
        feed.SummaryChanged += () => Run(() => { if (ReferenceEquals(Feed, feed)) Changed?.Invoke(); });
        feed.StatusChanged += () => Run(() => { if (ReferenceEquals(Feed, feed)) { Changed?.Invoke(); if (feed.Status == ApprovalFeedStatus.Live) DecisionsChanged?.Invoke(); } });
        feed.Resynced += () => Run(() => DecisionsChanged?.Invoke());
        feed.DecisionChanged += _ => Run(() => DecisionsChanged?.Invoke());
        feed.Start();
        Changed?.Invoke();
    }

    /// <summary>Coming to the front or opening the screen: a feed that is not live reads at once (the live one needs nothing).</summary>
    public void Refresh() { if (Feed is { } feed && feed.Status != ApprovalFeedStatus.Live) feed.Refresh(); }
    /// <summary>読み直す: always reads.</summary>
    public void ReadAgain() => Feed?.Refresh();

    public void Dispose() { workspace.PropertyChanged -= OnWorkspace; Feed?.Stop(); }
}
