using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Layout;
using Avalonia.Media;
using BellTeam.Core;
using static BellTeam.Linux.FormUi;

namespace BellTeam.Linux;

// A sheet whose header carries a 保存 button (Mac goal and member editor toolbar).
public interface ISheetSave
{
    bool CanSave { get; }
    event Action? CanSaveChanged;
    Task SaveAsync();
    // The header's two buttons: the left one closes (the editors say キャンセル until something is saved), the right one saves.
    string CloseLabel => "閉じる";
    string SaveLabel => "保存";
    bool CanClose => true;
    // Escape closes an open alert before it closes the sheet; true when something was closed.
    bool DismissPopup() => false;
}

// The shared body of the Mac member and room editors: a scrolling grouped form, one status line, the Mac alert, and the busy state that locks everything.
// The header (キャンセル / 保存) belongs to the host: a sheet header or the member window's own bar, both reading ISheetSave.
public abstract partial class EditorFormView : Grid, ISheetSave, IDisposable
{
    private readonly ScrollViewer scroller = new() { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
    private readonly Grid alertLayer = new() { Background = new SolidColorBrush(Color.FromArgb(0x59, 0, 0, 0)), IsVisible = false, ZIndex = 5 };
    private readonly CancellationTokenSource lifetime;
    private bool busy, closed;
    protected readonly StackPanel Form = new() { Margin = new Thickness(20, 4, 20, 28) };
    protected readonly List<Task> InitialLoads = [];
    protected EditorFormView(LinuxWorkspace workspace)
    {
        lifetime = CancellationTokenSource.CreateLinkedTokenSource(workspace.ConnectionToken);
        Background = BellTheme.ConversationBackground;
        scroller.Content = Form; Children.Add(scroller); Children.Add(alertLayer);
    }
    // Set by the host: closes the sheet or the window.
    public Action? Closer { get; set; }
    protected CancellationToken Token => lifetime.Token;
    public Task ReadyTask => Task.WhenAll(InitialLoads);
    public bool IsBusy => busy;
    // The window host reads this so a close that the editor itself asks for is never held back by the busy state.
    public bool IsClosing => closed;
    public bool Ready { get; protected set; }
    public bool AlertOpen => alertLayer.IsVisible;
    public event Action? CanSaveChanged;
    public virtual bool CanSave => Ready && !busy && !SaveBlocked;
    public virtual bool CanClose => !busy;
    protected virtual bool SaveBlocked => false;
    public virtual string CloseLabel => "キャンセル";
    public virtual string SaveLabel => "保存";
    public abstract Task SaveAsync();
    protected void Notify() => CanSaveChanged?.Invoke();

    protected void Close()
    {
        if (closed) return;
        closed = true; Notify(); Closer?.Invoke();
    }
    public virtual void Dispose() { closed = true; if (!lifetime.IsCancellationRequested) lifetime.Cancel(); lifetime.Dispose(); }

    // Mac .disabled(saving): the whole form stops answering while a request runs, and the header buttons follow through ISheetSave.
    protected async Task RunAsync(Func<Task> work)
    {
        if (busy) return;
        busy = true; scroller.IsEnabled = false; Notify();
        try { await work(); }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { }
        finally { busy = false; scroller.IsEnabled = true; Notify(); }
    }

    // Render seam: the bottom of the form (the 削除 section and the result lines).
    public void ScrollToEndForRender() { scroller.UpdateLayout(); scroller.ScrollToEnd(); scroller.UpdateLayout(); }
    // Render seam: a part of the form at the top of the view.
    public void ScrollToForRender(Control target) { scroller.UpdateLayout(); scroller.Offset = new Vector(0, Math.Max(0, (target.TranslatePoint(new Point(0, 0), Form) ?? default).Y - 8)); scroller.UpdateLayout(); }
    public bool DismissPopup()
    {
        if (!AlertOpen) return false;
        alertLayer.IsVisible = false; return true;
    }

    // The Mac alert: a title, a message and stacked buttons. Any button closes it first, then runs its action.
    protected void ShowAlert(string title, string message, params AlertChoice[] choices)
    {
        alertLayer.Children.Clear(); alertLayer.Children.Add(AlertFrame(title, message, () => DismissPopup(), choices)); alertLayer.IsVisible = true;
    }
    // The alert card itself, also used by the schedule page's delete confirmation. Any button dismisses first, then runs its action.
    internal static Border AlertFrame(string title, string message, Action dismiss, params AlertChoice[] choices)
    {
        var card = new StackPanel { Width = 300 };
        var heading = Text(title, 14, Ink, FontWeight.SemiBold, new Thickness(20, 18, 20, message.Length == 0 ? 16 : 0)); heading.TextAlignment = TextAlignment.Center; card.Children.Add(heading);
        if (message.Length != 0) { var detail = Text(message, 12, Ink, FontWeight.Normal, new Thickness(20, 6, 20, 16)); detail.TextAlignment = TextAlignment.Center; card.Children.Add(detail); }
        foreach (var choice in choices)
        {
            var button = new Button
            {
                Classes = { "plain" }, Content = choice.Label, Background = Brushes.Transparent, BorderThickness = new Thickness(0, 1, 0, 0), BorderBrush = Hairline, CornerRadius = default, Foreground = choice.Destructive ? Red : Violet, FontSize = 14,
                FontWeight = choice.Bold ? FontWeight.SemiBold : FontWeight.Normal, Padding = new Thickness(0, 11), HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Center
            };
            AutomationProperties.SetName(button, choice.Label);
            button.Click += (_, _) => { dismiss(); choice.Click?.Invoke(); };
            card.Children.Add(button);
        }
        // The shadow sits on an outer frame: a clipped border would cut it off.
        var frame = new Border { CornerRadius = new CornerRadius(14), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, BoxShadow = BoxShadows.Parse("0 6 24 0 #4D000000"), Child = new Border { Child = card, Background = new SolidColorBrush(Color.FromRgb(0xF6, 0xF6, 0xF8)), CornerRadius = new CornerRadius(14), ClipToBounds = true } };
        AutomationProperties.SetName(frame, title);
        return frame;
    }
}
