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

    internal WorkGraphCanvas Graph { get; }
    internal TextBlock Notice { get; } = new() { FontSize = 16, Foreground = WorkGraphText.Muted, TextAlignment = TextAlignment.Center, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(24), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, Visibility = Visibility.Collapsed, IsHitTestVisible = false };
    internal TextBlock Pill { get; } = new() { FontSize = 14, Foreground = WorkGraphText.Muted, Margin = new Thickness(12, 6, 12, 6) };
    private readonly Border pillFrame;
    private readonly Workspace workspace;
    private string? openError;

    internal WorkGraphWindow(Workspace workspace, Func<string, Task> openMember, Func<double>? clock = null)
    {
        this.workspace = workspace;
        Title = "相関図"; Width = 960; Height = 640; UseLayoutRounding = true;
        SetResourceReference(StyleProperty, typeof(Window)); SetResourceReference(BackgroundProperty, "ConversationBackground");
        Graph = new WorkGraphCanvas((id, version) => workspace.AvatarAsync($"{workspace.Server}api/bots/{Uri.EscapeDataString(id)}/avatar?v={Uri.EscapeDataString(version)}"), clock)
        { OpenMember = id => _ = OpenAsync(openMember, id) };
        pillFrame = new Border { Child = Pill, Background = new SolidColorBrush(Color.FromRgb(0xE8, 0xE0, 0xFF)), CornerRadius = new CornerRadius(12), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 12, 0, 0), Visibility = Visibility.Collapsed, IsHitTestVisible = false };
        System.Windows.Automation.AutomationProperties.SetAutomationId(Pill, "work-graph-status");
        System.Windows.Automation.AutomationProperties.SetAutomationId(Notice, "work-graph-unavailable");
        var root = new Grid(); root.Children.Add(Graph); root.Children.Add(Notice); root.Children.Add(pillFrame);
        Content = root;
        Graph.StatusChanged += Refresh;
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

    private void Sync()
    {
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
