using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Layout;
using Avalonia.Media;
using BellTeam.Core;

namespace BellTeam.Linux;

// The in-window sheet a page opens its editors in (MainWindow).
public interface ISheetHost
{
    void OpenSheet(string title, Control content);
    void CloseSheet();
}

// The shared body of the Mac schedule editor: a scrolling grouped form, the Mac alert, and the busy state that locks everything.
// The header (キャンセル / 保存) belongs to the host, which reads ISheetSave.
public abstract class SheetFormView : Grid, ISheetSave, IDisposable
{
    private readonly ScrollViewer scroller = new() { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
    private readonly Grid alertLayer = new() { Background = new SolidColorBrush(Color.FromArgb(0x59, 0, 0, 0)), IsVisible = false };
    private readonly CancellationTokenSource lifetime;
    private bool busy, closed;
    protected readonly StackPanel Form = new() { Margin = new Thickness(20, 4, 20, 28) };
    protected SheetFormView(LinuxWorkspace workspace)
    {
        lifetime = CancellationTokenSource.CreateLinkedTokenSource(workspace.ConnectionToken);
        Background = BellTheme.ConversationBackground;
        scroller.Content = Form; Children.Add(scroller); Children.Add(alertLayer);
    }
    // Set by the host: closes the sheet.
    public Action? Closer { get; set; }
    protected CancellationToken Token => lifetime.Token;
    public bool IsBusy => busy;
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

    // Render seam: the bottom of the form (the result lines).
    public void ScrollToEndForRender() { scroller.UpdateLayout(); scroller.ScrollToEnd(); scroller.UpdateLayout(); }
    public bool DismissPopup()
    {
        if (!AlertOpen) return false;
        alertLayer.IsVisible = false; return true;
    }
    protected void ShowAlert(string title, string message, params AlertChoice[] choices)
    {
        alertLayer.Children.Clear(); alertLayer.Children.Add(FormKit.AlertFrame(title, message, () => DismissPopup(), choices)); alertLayer.IsVisible = true;
    }
}
