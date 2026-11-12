using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using BellTeam.Core;
using static BellTeam.App.LatticeLook;

namespace BellTeam.App;

/// <summary>
/// 止め一覧 (screen-spec.md "止め一覧", state diagram there): every chart's stops, newest first, and one 外す per stop, confirmed in the row.
/// Reads on open, 読み直す / F5, after every 外す answer and when the window comes back to the foreground; only an unreadable answer (503, network, bad JSON)
/// re-reads on a timer, 1, 2, 4 … 30 s while shown. Saves nothing.
/// </summary>
internal sealed class LatticeStopsPage : Grid
{
    internal enum Phase { Loading, Ready, Retry, Old, Login }
    private readonly LatticeWindow window;
    private readonly ContentControl body = new();
    private BellApi? api;
    private CancellationTokenSource? run, wait;
    private int generation, attempt;
    private LatticeStop?[] stops = [];
    private bool unread;
    private string? confirmId;
    private readonly HashSet<string> removing = [];
    private readonly Dictionary<string, string> notes = [];
    private readonly Dictionary<string, FrameworkElement> rowElements = [];
    private readonly Dictionary<string, Control> focusable = [];
    internal Phase State { get; private set; } = Phase.Loading;
    internal IReadOnlyList<LatticeStopRow> Rows { get; private set; } = [];
    internal string? Confirming => confirmId;
    internal Task Reading { get; private set; } = Task.CompletedTask;
    public bool Running => run is not null;

    public LatticeStopsPage(LatticeWindow window)
    {
        this.window = window;
        Children.Add(body);
        // Tapping anywhere but a button closes the confirm step (buttons handle their own clicks).
        AddHandler(MouseLeftButtonDownEvent, new MouseButtonEventHandler((_, e) => { if (confirmId is not null && !InButton(e.OriginalSource as DependencyObject)) Cancel(false); }), true);
        Render();
    }
    private static bool InButton(DependencyObject? at)
    {
        for (; at is not null; at = at is Visual or System.Windows.Media.Media3D.Visual3D ? VisualTreeHelper.GetParent(at) : LogicalTreeHelper.GetParent(at)) if (at is ButtonBase) return true;
        return false;
    }

    public void Run(BellApi api, CancellationToken connection) { this.api = api; run = CancellationTokenSource.CreateLinkedTokenSource(connection); Read(); }
    public void Stop() { wait?.Cancel(); wait = null; run?.Cancel(); run?.Dispose(); run = null; generation++; }
    /// <summary>Back to the foreground: read again unless this server has no 止め一覧.</summary>
    public void Foreground() { if (Running && State != Phase.Old) Read(); }

    /// <summary>Reads now: cancels a waiting retry; an older read still in flight is ignored when it answers.</summary>
    internal void Read()
    {
        if (run is not { } source || api is null) return;
        wait?.Cancel(); wait = null;
        Reading = ReadAsync(api, source.Token, ++generation);
    }
    private async Task ReadAsync(BellApi api, CancellationToken token, int mine)
    {
        LatticeBlockers data;
        try { data = await api.BlockersAsync(token); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
        catch (BellApiException error) when (error.Status == System.Net.HttpStatusCode.NotFound) { if (mine == generation) { State = Phase.Old; Render(); } return; }
        // A lost sign-in stops reading; the next 読み直す, foreground or connection change reads again.
        catch (BellApiException error) when (error.RequiresLogin) { if (mine == generation) { State = Phase.Login; Render(); } return; }
        catch (Exception) { if (mine == generation) Retry(token); return; }
        if (mine != generation) return;
        if (data.Schema != LatticeStops.Schema || data.Blockers is null) { Retry(token); return; }
        attempt = 0; State = Phase.Ready; stops = data.Blockers; unread = data.UnreadCharts is { Length: > 0 };
        var ids = stops.Select(stop => stop?.StopId).ToHashSet();
        if (confirmId is not null && !ids.Contains(confirmId)) confirmId = null;
        foreach (var id in notes.Keys.Where(id => !ids.Contains(id)).ToList()) notes.Remove(id);
        Render();
    }
    private async void Retry(CancellationToken token)
    {
        State = Phase.Retry; Render();
        var mine = wait = CancellationTokenSource.CreateLinkedTokenSource(token);
        try { await Task.Delay(LatticeChart.BackoffMs(attempt++), mine.Token); }
        catch (OperationCanceledException) { return; }
        finally { mine.Dispose(); }
        if (ReferenceEquals(wait, mine)) { wait = null; Read(); }
    }

    internal void Ask(string stopId) { confirmId = stopId; Render($"confirm:{stopId}"); }
    internal void Cancel(bool refocus) { var id = confirmId; confirmId = null; Render(refocus && id is not null ? $"ask:{id}" : null); }
    /// <summary>Esc: closes the confirm step if open, else goes back to 一覧.</summary>
    internal void Escape() { if (confirmId is not null) Cancel(true); else window.ShowList(); }

    internal async Task RemoveAsync(LatticeStopRow row)
    {
        if (api is null || run is not { } source) return;
        var id = row.StopId; confirmId = null; notes.Remove(id); removing.Add(id); Render();
        LatticeUnblockOutcome outcome;
        try { outcome = await api.UnblockAsync(row.ProjectId, id, source.Token); }
        catch (OperationCanceledException) { removing.Remove(id); return; }
        removing.Remove(id);
        if (!Running) return;
        if (outcome.Kind == LatticeUnblockKind.Drop)
        {
            stops = stops.Where(stop => stop?.StopId != id).ToArray();
            if (Motion && rowElements.TryGetValue(id, out var element)) element.BeginAnimation(OpacityProperty, new DoubleAnimation(0, TimeSpan.FromMilliseconds(200)));
            else Render();
        }
        else { notes[id] = outcome.Kind == LatticeUnblockKind.Refused ? LatticeStops.Refused(outcome.Reason) : LatticeStops.Later; Render(); }
        Read();   // every answer re-reads at once
    }

    private void Render(string? focus = null)
    {
        Rows = LatticeStops.Rows(stops, window.Now(), window.Roster, window.OwnerProfile.Name, window.OwnerProfile.AvatarVersion);
        rowElements.Clear(); focusable.Clear();
        var page = new StackPanel { Margin = new Thickness(40, 30, 40, 40), MaxWidth = 1180 };
        var header = new DockPanel { Margin = new Thickness(0, 0, 0, 22) };
        var back = Plain(Glass(Row(Icon("", 12, Muted), Spaced(Text("すべての工程表", 15, Ink, FontWeights.SemiBold), 8)), 14, new Thickness(12, 8, 14, 8), 0xB3), "すべての工程表へ戻る");
        back.Margin = new Thickness(0, 0, 18, 0); back.Click += (_, _) => window.ShowList(); DockPanel.SetDock(back, Dock.Left);
        System.Windows.Automation.AutomationProperties.SetAutomationId(back, "lattice-stops-back"); header.Children.Add(back);
        var reload = Action("読み直す", ""); reload.Margin = new Thickness(12, 0, 0, 0); reload.VerticalAlignment = VerticalAlignment.Center; reload.Click += (_, _) => Read(); DockPanel.SetDock(reload, Dock.Right);
        System.Windows.Automation.AutomationProperties.SetAutomationId(reload, "lattice-stops-reload"); header.Children.Add(reload);
        header.Children.Add(Text("止め一覧", 28, Ink, FontWeights.Bold));
        page.Children.Add(header);
        if (State == Phase.Ready && unread) page.Children.Add(Line(LatticeStops.Unread));
        if (State == Phase.Retry)
        {
            var pill = Glass(Row(Spinner(14), Spaced(Text(LatticeStops.Retry, 13, Ink), 8)), 99, new Thickness(14, 7, 16, 7), 0xF2);
            pill.HorizontalAlignment = HorizontalAlignment.Left; pill.Margin = new Thickness(0, 0, 0, 14); page.Children.Add(pill);
        }
        if (State == Phase.Loading) page.Children.Add(LatticeWindow.Notice(LatticeStops.Loading, null, null));
        else if (State == Phase.Old) page.Children.Add(LatticeWindow.Notice(LatticeStops.Old, null, null));
        else if (State == Phase.Login) page.Children.Add(LatticeWindow.Notice(LatticeChart.LoginRequired, null, null));
        else if (Rows.Count == 0 && State == Phase.Ready) page.Children.Add(LatticeWindow.Notice(LatticeStops.Empty, null, null));
        else
        {
            var list = new StackPanel { Opacity = State == Phase.Retry ? .5 : 1 };
            foreach (var row in Rows) list.Children.Add(RowElement(row));
            page.Children.Add(list);
        }
        body.Content = new ScrollViewer { Content = page, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, PanningMode = PanningMode.VerticalOnly };
        if (focus is not null && focusable.TryGetValue(focus, out var target)) Dispatcher.BeginInvoke(() => target.Focus(), System.Windows.Threading.DispatcherPriority.Input);
    }
    private static TextBlock Line(string text)
    {
        var line = Text(text, 13, Amber, FontWeights.SemiBold, TextWrapping.Wrap); line.Margin = new Thickness(4, 0, 0, 14);
        System.Windows.Automation.AutomationProperties.SetAutomationId(line, "lattice-stops-unread");
        return line;
    }

    private FrameworkElement RowElement(LatticeStopRow row)
    {
        var id = row.StopId; var busy = removing.Contains(id); var asking = confirmId == id && !busy;
        var main = new Grid(); main.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); main.ColumnDefinitions.Add(new ColumnDefinition());
        var glyph = StateGlyph("blocked", 22, Red); glyph.VerticalAlignment = VerticalAlignment.Top; glyph.Margin = new Thickness(0, 2, 14, 0); main.Children.Add(glyph);
        var info = new StackPanel(); SetColumn(info, 1); main.Children.Add(info);
        var title = Text(row.Title, 16, Ink, FontWeights.Bold, TextWrapping.Wrap); title.TextTrimming = TextTrimming.CharacterEllipsis; title.MaxHeight = 16 * 1.34 * 2; info.Children.Add(title);
        var chart = Text(row.Chart, 12.5, Muted); chart.Margin = new Thickness(0, 2, 0, 8); info.Children.Add(chart);
        info.Children.Add(Field("担当", Person(row.Lane)));
        var reason = Text(row.Reason, 13, Ink, null, TextWrapping.Wrap); reason.TextTrimming = TextTrimming.CharacterEllipsis; reason.MaxHeight = 13 * 1.34 * 3;
        info.Children.Add(Field("理由", reason));
        var by = Person(row.By); if (row.Time.Length > 0) by.Children.Add(Spaced(Text(row.Time, 12.5, Muted), 10));
        info.Children.Add(Field("止めた人", by));
        var open = Plain(main, $"{row.Title}を開く"); open.HorizontalContentAlignment = HorizontalAlignment.Stretch; open.Click += (_, _) => window.OpenCard(row.ProjectId, row.CardId);
        System.Windows.Automation.AutomationProperties.SetAutomationId(open, "lattice-stop-open");

        var act = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(16, 0, 0, 0) };
        if (busy)
        {
            var spinning = Action("外す", "", true); spinning.Content = Row(Spinner(13), Spaced(Text("外す", 13, Colors.White), 6)); spinning.IsEnabled = false; act.Children.Add(spinning);
        }
        else if (asking)
        {
            var ask = Text(LatticeStops.Ask, 13, Ink, FontWeights.SemiBold); ask.Margin = new Thickness(0, 0, 10, 0); act.Children.Add(ask);
            var confirm = Action("外す", "", true); confirm.Click += (_, _) => _ = RemoveAsync(row); focusable[$"confirm:{id}"] = confirm;
            System.Windows.Automation.AutomationProperties.SetAutomationId(confirm, "lattice-stop-confirm"); act.Children.Add(confirm);
            var cancel = Action("やめる", ""); cancel.Click += (_, _) => Cancel(true);
            System.Windows.Automation.AutomationProperties.SetAutomationId(cancel, "lattice-stop-cancel"); act.Children.Add(cancel);
        }
        else
        {
            var remove = Action("外す", ""); remove.Click += (_, _) => Ask(id); focusable[$"ask:{id}"] = remove;
            System.Windows.Automation.AutomationProperties.SetName(remove, $"外す、{row.Title}"); System.Windows.Automation.AutomationProperties.SetAutomationId(remove, "lattice-stop-remove"); act.Children.Add(remove);
        }
        var dock = new DockPanel(); DockPanel.SetDock(act, Dock.Right); dock.Children.Add(act); dock.Children.Add(open);
        var stack = new StackPanel(); stack.Children.Add(dock);
        if (notes.TryGetValue(id, out var note))
        {
            var said = Text(note, 13, Red, FontWeights.SemiBold, TextWrapping.Wrap); said.Margin = new Thickness(36, 10, 0, 0);
            System.Windows.Automation.AutomationProperties.SetAutomationId(said, "lattice-stop-note"); stack.Children.Add(said);
        }
        var frame = Glass(stack, 18, new Thickness(18, 14, 16, 14)); frame.Margin = new Thickness(0, 0, 0, 12);
        System.Windows.Automation.AutomationProperties.SetName(frame, row.Label); System.Windows.Automation.AutomationProperties.SetAutomationId(frame, "lattice-stop");
        rowElements[id] = frame;
        return frame;
    }
    private StackPanel Person(LatticePerson? person)
    {
        var row = Row(); if (person is not null) row.Children.Add(new LatticeAvatar(person, 18, window.Avatar));
        row.Children.Add(Spaced(Text(LatticeChart.NameOf(person), 13, person is { Known: true } or { Authored: true } ? Ink : Muted), person is null ? 0 : 6));
        return row;
    }
    private static DockPanel Field(string label, UIElement value)
    {
        var dock = new DockPanel { Margin = new Thickness(0, 0, 0, 4) };
        var name = Text(label, 11.5, Muted); name.Width = 56; name.VerticalAlignment = VerticalAlignment.Top; name.Margin = new Thickness(0, 1, 0, 0); DockPanel.SetDock(name, Dock.Left); dock.Children.Add(name);
        dock.Children.Add(value);
        return dock;
    }
}
