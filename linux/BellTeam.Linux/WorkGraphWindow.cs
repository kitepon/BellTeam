using System.ComponentModel;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Threading;
using BellTeam.Core;

namespace BellTeam.Linux;

/// <summary>
/// The 相関図 window (Mac WindowGroup "work-graph"): its own top-level window, one at a time, at least 480x360 of content. The stream runs only while the window is
/// shown and not minimized, and starts again after a new connection (behavior-spec.md "Stream drop and recovery": window hidden closes the stream).
/// </summary>
public sealed class WorkGraphWindow : Window
{
    public static WorkGraphWindow? Current { get; private set; }
    /// <summary>The open window, or a new one. The caller shows and activates it, so a second open brings the existing window forward.</summary>
    public static WorkGraphWindow Open(LinuxWorkspace workspace, Func<string, Task> openMember) => Current ??= new WorkGraphWindow(workspace, openMember);

    internal WorkGraphCanvas Graph { get; private set; }
    /// <summary>The server whose graph is drawn. A graph is never shown or clicked under another server: another origin gets a fresh canvas, filled by that server's first snapshot.</summary>
    internal string Origin { get; private set; }
    internal TextBlock Notice { get; } = new() { FontSize = 16, Foreground = WorkGraphText.Muted, TextAlignment = TextAlignment.Center, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(24), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, IsVisible = false, IsHitTestVisible = false };
    internal TextBlock Pill { get; } = new() { FontSize = 14, Foreground = WorkGraphText.Muted, Margin = new Thickness(12, 6, 12, 6) };
    private readonly Border pillFrame;
    private readonly Grid root = new();
    private readonly LinuxWorkspace workspace;
    private readonly Func<string, Task> openMember;
    private readonly Func<double>? clock;
    private string? openError;

    internal WorkGraphWindow(LinuxWorkspace workspace, Func<string, Task> openMember, Func<double>? clock = null)
    {
        this.workspace = workspace; this.openMember = openMember; this.clock = clock;
        // The size is the whole window; the graph itself gets at least 480x360 (the window's content is the graph, so the minimum is the content's).
        Title = "相関図"; Width = 960; Height = 640; MinWidth = 480; MinHeight = 360; UseLayoutRounding = true; Background = BellTheme.ConversationBackground;
        Origin = workspace.Server;
        Graph = NewGraph();
        pillFrame = new Border { Child = Pill, Background = new Avalonia.Media.Immutable.ImmutableSolidColorBrush(Color.FromRgb(0xE8, 0xE0, 0xFF)), CornerRadius = new CornerRadius(12), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 12, 0, 0), IsVisible = false, IsHitTestVisible = false };
        AutomationProperties.SetAutomationId(Pill, "work-graph-status");
        AutomationProperties.SetAutomationId(Notice, "work-graph-unavailable");
        root.Children.Add(Graph); root.Children.Add(Notice); root.Children.Add(pillFrame);
        Content = root;
        PropertyChanged += (_, e) => { if (e.Property == IsVisibleProperty || e.Property == WindowStateProperty) Sync(); };
        workspace.PropertyChanged += WorkspaceChanged;
        Closed += (_, _) => { workspace.PropertyChanged -= WorkspaceChanged; Graph.Stop(); if (ReferenceEquals(Current, this)) Current = null; };
    }

    // A new connection (the first one, a new sign-in, another server) replaces the old stream.
    private void WorkspaceChanged(object? sender, PropertyChangedEventArgs args)
    {
        if (args.PropertyName != nameof(LinuxWorkspace.Connected)) return;
        if (Dispatcher.UIThread.CheckAccess()) Sync(); else Dispatcher.UIThread.Post(Sync);
    }

    private WorkGraphCanvas NewGraph()
    {
        var graph = new WorkGraphCanvas((id, version) => workspace.AvatarAsync($"{workspace.Server}api/bots/{Uri.EscapeDataString(id)}/avatar?v={Uri.EscapeDataString(version)}"), clock);
        graph.OpenMember = id => OpenMember(graph, id);
        graph.StatusChanged += Refresh;
        return graph;
    }

    // A click on a graph drawn for another server opens nothing: that graph is dropped and the current server's stream starts on a fresh one.
    private void OpenMember(WorkGraphCanvas graph, string botId)
    {
        if (!ReferenceEquals(graph, Graph)) return;
        if (Origin != workspace.Server) { Sync(); return; }
        _ = OpenAsync(openMember, botId);
    }

    private void ReplaceGraph()
    {
        Graph.Stop(); Graph.StatusChanged -= Refresh;
        var index = root.Children.IndexOf(Graph);
        Graph = NewGraph(); Origin = workspace.Server;
        if (index >= 0) root.Children[index] = Graph; else root.Children.Insert(0, Graph);
        openError = null; Refresh();
    }

    internal void Sync()
    {
        // Reconnecting to the same server keeps the drawn graph (the new snapshot is diffed against it); another server never sees it.
        if (Origin != workspace.Server) ReplaceGraph();
        var wanted = IsVisible && WindowState != WindowState.Minimized && workspace.Connected;
        if (wanted && !Graph.Running) Graph.Run((onActivity, token) => workspace.Management.Api.WorkGraphEventsAsync(onActivity, token), workspace.ConnectionToken);
        else if (!wanted && Graph.Running) Graph.Stop();
    }

    private async Task OpenAsync(Func<string, Task> open, string botId)
    {
        openError = null; Refresh();
        try { await open(botId); }
        catch (Exception error) { openError = "メインの窓を開けませんでした: " + error.Message; Refresh(); }
    }

    private void Refresh()
    {
        var (notice, pill) = Graph.Status;
        Notice.Text = notice ?? ""; Notice.IsVisible = notice is not null;
        Pill.Text = openError ?? pill ?? ""; pillFrame.IsVisible = Pill.Text.Length != 0;
    }
}
