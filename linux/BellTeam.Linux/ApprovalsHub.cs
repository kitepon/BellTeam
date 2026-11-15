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
    public ApprovalsFeed? Feed { get; private set; }
    /// <summary>The summary, the status or the feed itself changed (UI thread).</summary>
    public event Action? Changed;
    /// <summary>A decision was created / updated / deleted, or the stream came back (UI thread): the open window reads again.</summary>
    public event Action? DecisionsChanged;

    public ApprovalsHub(LinuxWorkspace workspace)
    {
        this.workspace = workspace;
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
