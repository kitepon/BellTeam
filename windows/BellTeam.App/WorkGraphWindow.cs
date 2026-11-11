using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using BellTeam.Core;

namespace BellTeam.App;

/// <summary>
/// The 相関図 window (Mac WindowGroup "work-graph"): its own top-level window, one at a time, at least 480x360 of content. The stream runs only while the window is
/// shown and not minimized, and starts again after a new connection (behavior-spec.md "Stream drop and recovery": window hidden closes the stream).
/// </summary>
public sealed class WorkGraphWindow : Window
{
    public static WorkGraphWindow? Current { get; private set; }
    /// <summary>The open window, or a new one. The caller shows and activates it, so a second open brings the existing window forward.</summary>
    public static WorkGraphWindow Open(Workspace workspace, Func<string, Task> openMember) => Current ??= new WorkGraphWindow(workspace, openMember);

    internal WorkGraphCanvas Graph { get; private set; }
    /// <summary>The server whose graph is drawn. A graph is never shown or clicked under another server: another origin gets a fresh canvas, filled by that server's first snapshot.</summary>
    internal string Origin { get; private set; }
    internal TextBlock Notice { get; } = new() { FontSize = 16, Foreground = WorkGraphText.Muted, TextAlignment = TextAlignment.Center, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(24), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, Visibility = Visibility.Collapsed, IsHitTestVisible = false };
    internal TextBlock Pill { get; } = new() { FontSize = 14, Foreground = WorkGraphText.Muted, Margin = new Thickness(12, 6, 12, 6) };
    private readonly Border pillFrame;
    private readonly Grid root = new();
    private readonly Workspace workspace;
    private readonly Func<string, Task> openMember;
    private readonly Func<double>? clock;
    private string? openError;

    internal WorkGraphWindow(Workspace workspace, Func<string, Task> openMember, Func<double>? clock = null)
    {
        this.workspace = workspace; this.openMember = openMember; this.clock = clock;
        Title = "相関図"; Width = 960; Height = 640; UseLayoutRounding = true;
        SetResourceReference(StyleProperty, typeof(Window)); SetResourceReference(BackgroundProperty, "ConversationBackground");
        Origin = workspace.Server;
        Graph = NewGraph();
        pillFrame = new Border { Child = Pill, Background = new SolidColorBrush(Color.FromRgb(0xE8, 0xE0, 0xFF)), CornerRadius = new CornerRadius(12), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 12, 0, 0), Visibility = Visibility.Collapsed, IsHitTestVisible = false };
        System.Windows.Automation.AutomationProperties.SetAutomationId(Pill, "work-graph-status");
        System.Windows.Automation.AutomationProperties.SetAutomationId(Notice, "work-graph-unavailable");
        root.Children.Add(Graph); root.Children.Add(Notice); root.Children.Add(pillFrame);
        Content = root;
        // The size above is the whole window; 480x360 is what the graph itself gets.
        Loaded += (_, _) => { MinWidth = 480 + ActualWidth - root.ActualWidth; MinHeight = 360 + ActualHeight - root.ActualHeight; };
        IsVisibleChanged += (_, _) => Sync();
        StateChanged += (_, _) => Sync();
        workspace.PropertyChanged += WorkspaceChanged;
        Closed += (_, _) => { workspace.PropertyChanged -= WorkspaceChanged; Graph.Stop(); if (ReferenceEquals(Current, this)) Current = null; };
    }

    // A new connection (the first one, a new sign-in, another server) replaces the old stream.
    private void WorkspaceChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs args)
    {
        if (args.PropertyName != nameof(Workspace.Connected)) return;
        if (Dispatcher.CheckAccess()) Sync(); else Dispatcher.BeginInvoke(Sync);
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
        root.Children.Insert(Math.Max(0, index), Graph);
        if (index >= 0) root.Children.RemoveAt(index + 1);
        openError = null; Refresh();
    }

    private void Sync()
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
        Notice.Text = notice ?? ""; Notice.Visibility = notice is null ? Visibility.Collapsed : Visibility.Visible;
        Pill.Text = openError ?? pill ?? ""; pillFrame.Visibility = Pill.Text.Length == 0 ? Visibility.Collapsed : Visibility.Visible;
    }
}
