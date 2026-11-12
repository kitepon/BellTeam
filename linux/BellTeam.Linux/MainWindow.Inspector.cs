using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using BellTeam.Core;

namespace BellTeam.Linux;

// The detail panel (inspector), its toggle, the editor sheets and windows, and the crop sheet: what windows MainWindow.xaml(.cs) hosts for ProfileView and the editors.
public sealed partial class MainWindow
{
    private bool inspectorVisible = true;
    private Grid mainGrid = null!;
    private readonly Border inspector = new() { Background = new SolidColorBrush(Color.Parse("#99FFFFFF")), BorderBrush = new SolidColorBrush(Color.Parse("#E0DBE8")), BorderThickness = new Thickness(1, 0, 0, 0), Padding = new Thickness(0, 52, 0, 0), IsVisible = false };
    private ScrollViewer inspectorScroll = null!;
    private Button inspectorToggle = null!;
    // Mac window toolbar (top right): the inspector toggle, then the export, as violet filled circles.
    private readonly StackPanel cornerButtons = new() { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 7, 10, 0), ZIndex = 5, IsVisible = false };
    internal ProfileView ProfilePanel { get; private set; } = null!;
    internal ScreenView ScreenPanel { get; private set; } = null!;
    // The editor sheet's first read (and its form) has finished; the render modes wait for it.
    public Task EditorReady { get; private set; } = Task.CompletedTask;

    private void AddInspector(Grid main)
    {
        mainGrid = main;
        ProfilePanel = new ProfileView(model) { Host = this, MaxWidth = 760, HorizontalAlignment = HorizontalAlignment.Center };
        ScreenPanel = new ScreenView(model);
        inspectorScroll = new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled, Content = ProfilePanel };
        inspector.Child = new Grid { Children = { inspectorScroll, ScreenPanel } };
        Grid.SetColumn(inspector, 3); main.Children.Add(inspector);
        inspectorToggle = new Button { Classes = { "plain" }, Width = 38, Height = 38, Padding = default, CornerRadius = new CornerRadius(19), Background = BellTheme.Violet, HorizontalContentAlignment = HorizontalAlignment.Center, VerticalContentAlignment = VerticalAlignment.Center, Content = Icons.Draw(InspectorIcons.Panel, 20, Brushes.White) };
        AutomationProperties.SetName(inspectorToggle, "詳細パネル"); AutomationProperties.SetAutomationId(inspectorToggle, "inspector-toggle"); ToolTip.SetTip(inspectorToggle, "詳細パネル（Ctrl+Shift+I）");
        inspectorToggle.Click += (_, _) => ToggleInspector();
        cornerButtons.Children.Add(inspectorToggle); cornerButtons.Children.Add(exportButton);
        Grid.SetColumn(cornerButtons, 2); Grid.SetColumnSpan(cornerButtons, 2); main.Children.Add(cornerButtons);
        UpdateInspectorPanels();
    }
    private void UpdateInspectorPanels() { inspectorScroll.IsVisible = model.ProfileVisible; ScreenPanel.IsVisible = model.ScreenVisible; }
    // Without a selection (the welcome screen) or on a page there is no inspector column, as on the Mac. A room's panel is a fixed 280.
    private void ProfileLayout()
    {
        var show = inspectorVisible && model.HasSelection && conversationArea.IsVisible;
        inspector.IsVisible = show;
        var column = mainGrid.ColumnDefinitions[3]; column.MinWidth = show ? 280 : 0;
        column.Width = show ? model.IsRoom ? new GridLength(280) : new GridLength(1, GridUnitType.Star) : new GridLength(0);
        mainGrid.ColumnDefinitions[2].MinWidth = 370;
    }
    private void ToggleInspector()
    {
        inspectorVisible = !inspectorVisible;
        if (!inspectorVisible) model.ReturnToProfile();
        ProfileLayout();
    }
    public void HideInspectorForRender() { inspectorVisible = false; ProfileLayout(); }
    public AvatarActionsView? ShowAvatarSheetForRender(AvatarVariant variant) => ProfilePanel.OpenActionsForRender(variant);

    // ---- sheet header: the Mac sheet's two pills, 閉じる / キャンセル on the left and 保存 on the right ----
    internal static Button SheetPill(string text)
    {
        var button = new Button
        {
            Classes = { "plain" }, Content = text, Padding = new Thickness(16, 7), CornerRadius = new CornerRadius(99), FontWeight = FontWeight.Normal, Foreground = BellTheme.Ink, Background = new SolidColorBrush(Color.Parse("#80FFFFFF")),
            BorderBrush = new SolidColorBrush(Color.Parse("#C9C4DE")), BorderThickness = new Thickness(1), VerticalAlignment = VerticalAlignment.Center
        };
        AutomationProperties.SetName(button, text); return button;
    }
    private readonly Button sheetClose = Aligned(SheetPill("閉じる"), HorizontalAlignment.Left, new Thickness(12, 0, 0, 0));
    private readonly Button sheetSaveButton = Aligned(SheetPill("保存"), HorizontalAlignment.Right, new Thickness(0, 0, 12, 0), visible: false);
    private static Button Aligned(Button button, HorizontalAlignment alignment, Thickness margin, bool visible = true) { button.HorizontalAlignment = alignment; button.Margin = margin; button.IsVisible = visible; return button; }
    private ISheetSave? sheetSave;
    private void SheetSaveChanged()
    {
        if (sheetSave is null) return;
        sheetSaveButton.IsEnabled = sheetSave.CanSave; sheetSaveButton.Content = sheetSave.SaveLabel; sheetClose.Content = sheetSave.CloseLabel; sheetClose.IsEnabled = sheetSave.CanClose;
        AutomationProperties.SetName(sheetClose, sheetSave.CloseLabel); AutomationProperties.SetName(sheetSaveButton, sheetSave.SaveLabel);
    }
    private void BeforeSheetOpens(Control content)
    {
        ReleaseSheetSave();
        if (content is ISheetSave save) { sheetSave = save; save.CanSaveChanged += SheetSaveChanged; sheetSaveButton.IsVisible = true; SheetSaveChanged(); }
        if (content is AvatarActionsView actions) actions.BusyChanged += () => sheetClose.IsEnabled = !actions.Busy;
    }
    private void AfterSheetCloses()
    {
        CloseCropSheet(null); ReleaseSheetSave();
        (sheetHost.Content as IDisposable)?.Dispose();
        sheetClose.IsEnabled = true;
    }
    private void ReleaseSheetSave()
    {
        if (sheetSave is not null) sheetSave.CanSaveChanged -= SheetSaveChanged;
        sheetSave = null; sheetSaveButton.IsVisible = false; sheetClose.Content = "閉じる"; sheetSaveButton.Content = "保存";
    }
    private bool SheetBusy => sheetHost.Content is AvatarActionsView { Busy: true } || sheetSave is { CanClose: false };
    private void CloseFromSheetHeader() { if (!SheetBusy) CloseSheet(); }
    // Escape closes an open alert before it closes the sheet.
    private void EscapeSheet() { if (sheetSave?.DismissPopup() == true || SheetBusy) return; CloseSheet(); }
    void IInspectorHost.CloseSheet() => CloseSheet();
    Window? IInspectorHost.OwnerWindow => this;

    // ---- editors: 追加 opens the new-member and new-room sheets, the profile's edit button the room sheet; a member is edited in a window of its own ----
    public void ShowMemberSheet()
    {
        if (!model.Connected) return;
        var view = new MemberEditorView(model, null, ShowTerminalSettings); OpenEditorSheet("メンバーを追加", view); EditorReady = ReadyAfter(view.InitializeAsync(), view);
    }
    public void ShowRoomSheet(string? id)
    {
        if (!model.Connected) return;
        var view = new RoomEditorView(model, id); OpenEditorSheet(id is null ? "ルームを作る" : "ルームを編集", view); EditorReady = ReadyAfter(view.InitializeAsync(), view);
    }
    private static async Task ReadyAfter(Task initialize, EditorFormView view) { await initialize; await view.ReadyTask; }
    private void OpenEditorSheet(string title, EditorFormView view) { CloseSheet(); view.Closer = CloseSheet; OpenSheet(title, view); }
    // Render seam: the open editor sheet.
    public EditorFormView? OpenEditor => sheetHost.Content as EditorFormView;
    // The member editor's 端末を管理: the main window shows 設定 and comes forward.
    private void ShowTerminalSettings() { ShowPage("設定"); Raise(); }

    private readonly Dictionary<string, MemberEditorWindow> memberWindows = [];
    public void EditMember(string id)
    {
        if (!model.Connected) return;
        if (memberWindows.TryGetValue(id, out var open)) { open.Activate(); return; }
        var window = new MemberEditorWindow(model, id, ShowTerminalSettings);
        memberWindows[id] = window; window.Closed += (_, _) => memberWindows.Remove(id);
        window.Show(this); _ = window.InitializeAsync();
    }
    public void EditRoom(string id) => ShowRoomSheet(id);
    private void CloseMemberWindows() { foreach (var window in memberWindows.Values.ToArray()) window.Close(); }
    // Render seam: the member editor window, built but never shown.
    public MemberEditorWindow CreateMemberWindowForRender(string id) => new(model, id, ShowTerminalSettings);

    // ---- the crop sheet: one request at a time. 使用する hands the result back to whoever asked; anything else gives null ----
    private Grid? cropSheetField;
    private Grid cropSheet => cropSheetField ??= BuildCropSheet();
    private readonly ContentControl cropHost = new();
    private TaskCompletionSource<AvatarCropOutcome?>? cropRequest;
    private AvatarCropView? cropView;
    // Mac AvatarCropEditor sheet: 680x520, over whatever sheet is open.
    private Grid BuildCropSheet()
    {
        var cancel = SheetPill("キャンセル"); cancel.HorizontalAlignment = HorizontalAlignment.Left; cancel.Margin = new Thickness(12, 0, 0, 0); cancel.Click += (_, _) => CloseCropSheet(null);
        var use = SheetPill("使用する"); use.HorizontalAlignment = HorizontalAlignment.Right; use.Margin = new Thickness(0, 0, 12, 0); use.Click += (_, _) => { if (cropView?.TryUse() is { } outcome) CloseCropSheet(outcome); };
        var title = new TextBlock { Text = "画像を調整", HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, FontSize = 15, FontWeight = FontWeight.SemiBold, Foreground = BellTheme.Ink };
        var header = new Grid { Height = 52, Background = new SolidColorBrush(Color.Parse("#F2F2F7")), Children = { cancel, use, title } };
        var line = new Border { Height = 1, Background = new SolidColorBrush(Color.Parse("#E6E6EB")) };
        DockPanel.SetDock(header, Dock.Top); DockPanel.SetDock(line, Dock.Top);
        var frame = new Border { Width = 680, Height = 520, CornerRadius = new CornerRadius(14), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, BoxShadow = BoxShadows.Parse("0 8 30 0 #40000000"), Child = new Border { Background = new SolidColorBrush(Color.Parse("#F2F2F7")), CornerRadius = new CornerRadius(14), ClipToBounds = true, Child = new DockPanel { Children = { header, line, cropHost } } } };
        AutomationProperties.SetName(frame, "画像を調整");
        return new Grid { Background = new SolidColorBrush(Color.Parse("#66000000")), IsVisible = false, Focusable = true, Children = { frame } };
    }
    public Task<AvatarCropOutcome?> CropAsync(Bitmap image, AvatarVariant variant, AvatarCropRect? initialCrop, bool wantsSelection)
    {
        CloseCropSheet(null);
        cropView = new AvatarCropView(image, variant, initialCrop, wantsSelection); cropHost.Content = cropView; cropSheet.IsVisible = true; cropSheet.Focus();
        return (cropRequest = new(TaskCreationOptions.RunContinuationsAsynchronously)).Task;
    }
    private void CloseCropSheet(AvatarCropOutcome? outcome)
    {
        var request = cropRequest; cropRequest = null; cropView = null; cropHost.Content = null; cropSheet.IsVisible = false;
        request?.TrySetResult(outcome);
    }
    // Render seam: the crop sheet over the main window.
    public AvatarCropView ShowCropForRender(Bitmap image, AvatarVariant variant)
    {
        _ = CropAsync(image, variant, null, false); return cropView!;
    }
}
