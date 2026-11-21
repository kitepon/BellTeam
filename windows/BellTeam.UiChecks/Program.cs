using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;
using System.Reflection;
using System.ComponentModel;
using BellTeam.App;
using BellTeam.Core;
public static class UiChecks {
  [STAThread] public static void Main(string[] args) {
    var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown }; app.Resources.MergedDictionaries.Add(new ResourceDictionary { Source = new Uri("pack://application:,,,/BellTeam;component/Theme.xaml") });
    var dispatcher = Dispatcher.CurrentDispatcher; SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(dispatcher));
    dispatcher.BeginInvoke(async () => { try { if (args is ["--access-cookie", var action, var profile]) await AccessCookieCheck.Run([action,profile]); else if (args is ["--notification-register"]) await NativeNotificationCheck.RunAsync(); else if (args is ["--notification-silent"]) await NativeNotificationCheck.RunAsync(showSilently:true); else if (args.Length == 0) await Run(); else throw new ArgumentException("引数は --access-cookie <write|read|clear|empty> <試験プロファイル> または --notification-register です。"); } catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; } finally { app.Shutdown(); dispatcher.InvokeShutdown(); } });
    Dispatcher.Run();
  }
  private static async Task Run() {
    await StartupChecks();
    await FillChecks(); await FillChecks(3); await JumpChecks(); await AnchorChecks(); await RefreshChecks(); await SmoothChecks();
    var newMessage = false;
    var time = DateTimeOffset.UtcNow;
    var messages = Enumerable.Range(0,30).Select(index => new TimelineMessage { Id = "m" + index, At = time.AddMinutes(index - 30), Direction = "incoming", Message = "本文" + index + " " + new string('あ',180) }).ToArray();
    // TimelineMessage carries JsonElement members (delivery tracking) that cannot be written while unset; skip only those, as the server omits absent fields.
    var wire = new JsonSerializerOptions(BellApi.Json) { TypeInfoResolver = new System.Text.Json.Serialization.Metadata.DefaultJsonTypeInfoResolver { Modifiers = { info => { foreach (var property in info.Properties.Where(property => property.PropertyType == typeof(JsonElement))) property.ShouldSerialize = (_, value) => ((JsonElement)value!).ValueKind != JsonValueKind.Undefined; } } } };
    using var workspace = new Workspace(origin => new BellApi(origin, new MockHandler(request => {
      var path = request.RequestUri!.AbsolutePath;
      object result = path switch {
        "/api/session" => new { authenticated = true, authMode = "local" },
        "/api/setup" => new { phase = "ready", harness = (string?)null, harnesses = Array.Empty<object>(), guideBotId = (string?)null, complete = true, auth = (object?)null },
        "/api/bots" => new { bots = new[] { new { id = "one", name = "ユキ", displayName = "ユキ", color = "indigo" } } },
        "/api/rooms" => new { rooms = Array.Empty<object>() }, "/api/queue" => new { items = Array.Empty<object>() },
        "/api/owner" => new { owner = new { name = "利用者" } }, "/api/settings" => new { settings = Array.Empty<object>() },
        _ when path.EndsWith("/schedules") => new { schedules = Array.Empty<object>() },
        _ when path.EndsWith("/messages") => request.RequestUri.Query.Contains("before=")
          ? new MessagePage { Items = Enumerable.Range(0,10).Select(index => new TimelineMessage { Id = "old" + index, At = time.AddMinutes(index - 50), Direction = "incoming", Message = "以前の本文 " + new string('い',100) }).ToArray(), HasMore = false }
          : new MessagePage { Items = request.RequestUri.Query.Contains("after=") ? (newMessage ? [new TimelineMessage { Id = "new", At = time, Message = "新着です", Direction = "incoming" }] : []) : (newMessage ? messages.Concat([new TimelineMessage { Id = "new", At = time, Message = "新着です", Direction = "incoming" }]).ToArray() : messages), HasMore = true },
        _ => throw new InvalidOperationException("未対応の模擬URL: " + path)
      };
      return JsonSerializer.Serialize(result, wire);
    })));
    var disconnected = new MainWindow(workspace, persistPlacement:false); disconnected.ShowSettings(); disconnected.ShowSchedules();
    var disconnectedRoot = (FrameworkElement)disconnected.Content; disconnectedRoot.Measure(new Size(1280,820)); disconnectedRoot.Arrange(new Rect(0,0,1280,820)); disconnectedRoot.UpdateLayout();
    Check(((FrameworkElement)disconnected.FindName("CornerButtons")).Visibility==Visibility.Collapsed,"会話を選ぶ前に詳細パネルと書き出しのボタンが出ます。");
    Check(((FrameworkElement)disconnected.FindName("PageArea")).Visibility == Visibility.Collapsed && workspace.ActionError is null,"未接続で設定のページが開きました。"); disconnected.Close();
    await workspace.ConnectAsync("http://localhost", listen:false);
    var window = new MainWindow(workspace, persistPlacement:false); var root = (FrameworkElement)window.Content;
    async Task Layout() { root.Measure(new Size(1280,820)); root.Arrange(new Rect(0,0,1280,820)); root.UpdateLayout(); await Dispatcher.Yield(DispatcherPriority.ApplicationIdle); root.UpdateLayout(); }
    window.ShowSettings(); await window.PageReady; await Layout();
    Check(((FrameworkElement)window.FindName("PageArea")).Visibility == Visibility.Visible,"設定から勝手に会話へ戻りました。");
    // 相関図 (W-MAC 13b): the sidebar entry sits between ゴール and 設定 like the Mac footer, and opening it twice shows one window.
    var footerLeft = new[] { "SchedulesNav", "GoalsNav", "WorkGraphNav", "LatticeNav", "SettingsNav" }.Select(name => ((FrameworkElement)window.FindName(name)).TranslatePoint(new Point(), root).X).ToArray();
    Check(footerLeft.SequenceEqual(footerLeft.Order()) && footerLeft.Distinct().Count() == 5 && ((Button)window.FindName("WorkGraphNav")).IsEnabled && ((Button)window.FindName("LatticeNav")).IsEnabled,"相関図・工程表の入口が予定・ゴール・相関図・工程表・設定の順に並びません。");
    var graphWindow = window.ShowWorkGraph(); Check(graphWindow is { Title: "相関図" } && ReferenceEquals(graphWindow,window.ShowWorkGraph()),"相関図を2回開くと窓が2つになります。");
    graphWindow!.Close(); Check(WorkGraphWindow.Current is null,"閉じた相関図の窓が残っています。");
    var page = (EditorWindow)typeof(MainWindow).GetField("page",BindingFlags.Instance|BindingFlags.NonPublic)!.GetValue(window)!;
    var completion = new TaskCompletionSource<bool>(); var writing = (Task)typeof(EditorWindow).GetMethod("RunAsync",BindingFlags.Instance|BindingFlags.NonPublic)!.Invoke(page,[new Func<Task<bool>>(()=>completion.Task),false])!;
    var closing = new CancelEventArgs(); typeof(Window).GetMethod("OnClosing",BindingFlags.Instance|BindingFlags.NonPublic)!.Invoke(window,[closing]); Check(closing.Cancel,"ページへの書込中に窓を閉じられます。"); completion.SetResult(false); await writing;
    closing = new(); typeof(Window).GetMethod("OnClosing",BindingFlags.Instance|BindingFlags.NonPublic)!.Invoke(window,[closing]); Check(!closing.Cancel,"書込後も窓を閉じられません。");
    var list = (ListBox)window.FindName("ConversationList"); var entry = workspace.Entries.Single(); list.SelectedItem = entry; await Layout();
    Check(((FrameworkElement)window.FindName("PageArea")).Visibility == Visibility.Collapsed,"一覧から会話へ戻れません。");
    var corner = (StackPanel)window.FindName("CornerButtons");
    // Mac toolbar: no avatar+name row over the conversation; the inspector toggle then the export are the two violet circles at the top right.
    Check(corner.Visibility==Visibility.Visible && corner.Children.OfType<Button>().Select(button=>System.Windows.Automation.AutomationProperties.GetName(button)).SequenceEqual(["詳細パネル","会話を書き出す"]),"会話の右上に詳細パネルと書き出しのボタンが並びません。");
    Check(Descendants<AvatarTile>(((FrameworkElement)window.FindName("ConversationArea"))).All(tile=>tile.Width!=34),"会話の上にアバターと名前の帯が残っています。");
    var inspectorPanel = (FrameworkElement)window.FindName("Inspector"); var toggle = (Button)window.FindName("InspectorToggle");
    Check(inspectorPanel.Visibility==Visibility.Visible,"会話を開いても詳細パネルが出ません。");
    toggle.RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); Check(inspectorPanel.Visibility==Visibility.Collapsed && corner.Visibility==Visibility.Visible,"右上のボタンで詳細パネルを閉じられません。");
    toggle.RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); Check(inspectorPanel.Visibility==Visibility.Visible,"右上のボタンで詳細パネルを開けません。");
    window.ShowSchedules(); await window.PageReady; await Layout();
    Check(corner.Visibility==Visibility.Collapsed,"予定のページに詳細パネルと書き出しのボタンが出ています。");
    var item = Descendants<ListBoxItem>(list).Single(); item.RaiseEvent(new MouseButtonEventArgs(Mouse.PrimaryDevice,0,MouseButton.Left) { RoutedEvent = UIElement.PreviewMouseDownEvent }); await Layout();
    Check(((FrameworkElement)window.FindName("PageArea")).Visibility == Visibility.Collapsed,"同じ会話へ戻れません。");
    Check(corner.Visibility==Visibility.Visible,"会話へ戻っても右上のボタンが戻りません。");
    // The shared sheet header buttons are Mac capsules, not flat text.
    window.OpenSheet("確認", new TextBlock()); await Layout();
    foreach (var sheetButton in new[]{"UpdateSheetClose","UpdateSheetSave","CropCancel","CropUse"}) { var pill = (Button)window.FindName(sheetButton); pill.ApplyTemplate(); Check(Descendants<Border>(pill).First().CornerRadius.TopLeft>=99,"シートの見出しのボタンがカプセルになりません。"); }
    window.CloseUpdateSheet();
    // The gallery covers the main window itself; Esc closes it and the arrow keys move between pictures.
    var gallery = window.ShowGallery(["/a.png","/b.png"],0); await Layout(); var galleryHost = (FrameworkElement)window.FindName("GalleryHost");
    Check(galleryHost.Visibility==Visibility.Visible && galleryHost.ActualWidth>=1280 && galleryHost.ActualHeight>=820,"画像の閲覧が窓いっぱいに開きません。");
    using (var keys = new HwndSource(new HwndSourceParameters("非表示の画像キー確認") { Width=1,Height=1,WindowStyle=unchecked((int)0x80000000),ExtendedWindowStyle=0x08000000 })) {
      void Press(Key key) => window.RaiseEvent(new KeyEventArgs(Keyboard.PrimaryDevice,keys,0,key) { RoutedEvent=Keyboard.PreviewKeyDownEvent });
      Press(Key.Right); Check(gallery.Selected==1,"→で次の画像へ進みません。"); Press(Key.Left); Check(gallery.Selected==0,"←で前の画像へ戻りません。");
      Press(Key.Escape); Check(window.Gallery is null && galleryHost.Visibility==Visibility.Collapsed,"Escで画像の閲覧を閉じられません。");
    }
    var scroll = (ScrollViewer)window.FindName("MessageScroll");
    scroll.ScrollToEnd(); await Layout(); Check(scroll.ScrollableHeight > 1000,"長い会話を配置できません。");
    scroll.ScrollToVerticalOffset(scroll.ScrollableHeight / 2); await Layout(); var offset = scroll.VerticalOffset;
    var latest = (Button)window.FindName("NewMessagesButton"); var band = (FrameworkElement)window.FindName("NewMessagesBand"); string Shown() => ((TextBlock)window.FindName("NewMessagesLabel")).Text;
    Check(band.Visibility == Visibility.Visible && Shown() == "最新へ","読み返している間に「最新へ」が出ません。");
    newMessage = true; await workspace.RefreshManagementAsync(); await Layout();
    Check(Math.Abs(scroll.VerticalOffset-offset) < 1,"新着で読んでいた位置が動きました。");
    Check(band.Visibility == Visibility.Visible && Shown() == "新着メッセージ" && System.Windows.Automation.AutomationProperties.GetName(latest) == "新着メッセージ","新着の入口が見えません。");
    // a471-windows-older-button: nothing is pressed to read older rows; the scroll motion reads them (as on the Mac; the prefetch scenes below check that).
    Check(!Descendants<Button>(root).Any(button => button.Content as string == "以前のメッセージを読む"),"以前のメッセージを読むボタンが出ています（先読みだけで読む）。");
    Check(Application.Current.Windows.Cast<Window>().All(candidate => new WindowInteropHelper(candidate).Handle == IntPtr.Zero),"確認で窓のハンドルを作成しました。");
    root.Measure(new Size(5120,1400)); root.Arrange(new Rect(0,0,5120,1400)); root.UpdateLayout();
    Check(Descendants<ProfileView>(root).Single().ActualWidth <= 760,"横長の窓でプロフィールが伸びすぎます。");
    Check(Descendants<MessageCard>(root).All(card=>((FrameworkElement)card.Content).ActualWidth<=900),"横長の窓で吹き出しが伸びすぎます。");
    workspace.DraftText = "同じ接続先の下書き"; await (Task)typeof(MainWindow).GetMethod("ChangeServerAsync",BindingFlags.Instance|BindingFlags.NonPublic)!.Invoke(window,[workspace.Server])!;
    await workspace.SelectAsync(workspace.Entries.Single()); Check(workspace.DraftText=="同じ接続先の下書き","同じ接続先の再入力でログアウトしています。"); workspace.DraftText="";
    workspace.Messages.Clear(); typeof(Workspace).BaseType!.GetProperty(nameof(Workspace.Loading))!.SetValue(workspace,true); // the private setter lives on the Core base (Workspace<TImage>)
    Check(((FrameworkElement)window.FindName("EmptyConversation")).Visibility==Visibility.Collapsed && ((FrameworkElement)window.FindName("LoadingSpinner")).Visibility==Visibility.Visible,"読込中に送信の案内が出ます。");
    Check(Application.Current.Windows.Cast<Window>().All(candidate => new WindowInteropHelper(candidate).Handle == IntPtr.Zero),"再接続の確認で窓を表示しました。");
    window.Close(); Console.WriteLine("画面内移動・新着・過去ログ位置・前面非表示の確認に成功しました。");
  }
  // The Mac RootView phases on the real MainWindow, against stub servers. Nothing here shows a window; a failure retries by itself on the backoff and 「もう一度試す」 tries at once.
  private static async Task StartupChecks() {
    const string select = "{\"phase\":\"select_harness\",\"harness\":null,\"harnesses\":[{\"id\":\"codex\",\"name\":\"Codex\"}],\"guideBotId\":null,\"complete\":false,\"auth\":null}";
    (MainWindow Window, Workspace Model, int[] Requests) Open(Func<string,string> answer, Func<int,CancellationToken,Task>? retryDelay = null) {
      var requests = new int[1];
      var model = new Workspace(origin => new BellApi(origin, new MockHandler(request => { requests[0]++; return answer(request.RequestUri!.AbsolutePath); })), retryDelay: retryDelay);
      return (new MainWindow(model, persistPlacement:false), model, requests);
    }
    void Lay(MainWindow window) { var content = (FrameworkElement)window.Content; content.Measure(new Size(1280,820)); content.Arrange(new Rect(0,0,1280,820)); content.UpdateLayout(); }
    async Task Settle(MainWindow window, Func<bool> done) { for (var turn = 0; turn < 200 && !done(); turn++) await Task.Delay(10); Check(done(), "起動の状態が決まりません。"); Lay(window); }
    // Real schedule: the first retry is immediate (attempt 0), the next waits 1 s +-20%.
    var failing = Open(path => path == "/api/session" ? throw new InvalidOperationException("模擬の接続失敗") : "{}");
    await failing.Window.ConnectAsync("http://localhost"); Lay(failing.Window);
    Check(failing.Window.Startup == StartupPhase.Failure && failing.Window.StartupContent is StartupFailureView,"接続の失敗が失敗の画面になりません。");
    await Settle(failing.Window, () => failing.Requests[0] >= 2);
    var immediate = failing.Requests[0]; await Task.Delay(600);
    Check(failing.Requests[0] == immediate,"最初の自動再試行の次が、待ち時間(0.8秒以上)より前に来ています。");
    await Settle(failing.Window, () => failing.Requests[0] > immediate);
    Check(failing.Window.Startup == StartupPhase.Failure && failing.Window.StartupContent is StartupFailureView,"自動再試行の後に失敗の画面が残りません。");
    // Injected schedule: attempt numbers 0, 1, 2 are asked for in order; the manual button tries at once and does not reset the schedule.
    var waits = new List<int>();
    var held = Open(path => path == "/api/session" ? throw new InvalidOperationException("模擬の接続失敗") : "{}", async (attempt, token) => { waits.Add(attempt); if (attempt > 0) await Task.Delay(Timeout.Infinite, token); });
    await held.Window.ConnectAsync("http://localhost"); Lay(held.Window);
    await Settle(held.Window, () => waits.Count == 2 && held.Requests[0] == 2);
    Check(waits.SequenceEqual([0, 1]),"自動再試行の待ち時間が0・1の順になりません。");
    var attempts = held.Requests[0]; await Task.Delay(200); Check(held.Requests[0] == attempts,"待ち時間の途中で再試行しています。");
    Lay(held.Window);
    var again = Descendants<Button>(held.Window.StartupContent!).Single(button => System.Windows.Automation.AutomationProperties.GetName(button) == "もう一度試す");
    again.RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); await Settle(held.Window, () => held.Requests[0] == attempts + 1 && waits.Count == 3 && held.Window.Startup == StartupPhase.Failure);
    Check(waits.SequenceEqual([0, 1, 2]),"「もう一度試す」の後の待ち時間が進んでいません。");
    var manual = held.Requests[0]; await Task.Delay(300); Check(held.Requests[0] == manual,"「もう一度試す」が1回の接続になりません。");
    held.Window.ConfirmServerChange = () => true; Lay(held.Window); var change = Descendants<Button>(held.Window.StartupContent!).Single(button => System.Windows.Automation.AutomationProperties.GetName(button) == "接続先を変更");
    change.RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); Check(held.Window.Startup == StartupPhase.Setup && held.Window.StartupContent is ServerSetupView,"失敗の画面から接続先の入力へ移れません。");
    Check(held.Requests[0] == manual,"接続先の入力を開いただけで通信しています。");
    held.Window.Close(); held.Model.Dispose();
    failing.Window.Close(); failing.Model.Dispose();

    var first = Open(_ => "{}"); first.Window.ShowServerSetup();
    Check(first.Window.Startup == StartupPhase.Setup && first.Window.StartupContent is ServerSetupView && first.Requests[0] == 0,"保存した接続先がない時に接続先の入力になりません。");
    first.Window.Close(); first.Model.Dispose();

    var login = Open(path => path == "/api/session" ? "{\"authenticated\":false,\"authMode\":\"cloudflare\"}" : "{}");
    await login.Window.ConnectAsync("http://localhost", openLogin:false);
    Check(login.Window.Startup == StartupPhase.SignIn && login.Window.StartupContent is LoginView,"Cloudflare Accessのログインが必要な接続先でログイン画面になりません。");
    login.Window.Close(); login.Model.Dispose();

    var onboarding = Open(path => path switch { "/api/session" => "{\"authenticated\":true,\"authMode\":\"local\"}", "/api/setup" => select, "/api/bots" => "{\"bots\":[]}", "/api/rooms" => "{\"rooms\":[]}", "/api/queue" => "{\"items\":[]}", "/api/owner" => "{\"owner\":{\"name\":\"利用者\"}}", _ => "{}" });
    await onboarding.Window.ConnectAsync("http://localhost"); Lay(onboarding.Window);
    Check(onboarding.Window.Startup == StartupPhase.Onboarding && onboarding.Window.StartupContent is OnboardingView,"初回設定が済んでいない接続先で初期設定の画面になりません。");
    Check(((FrameworkElement)onboarding.Window.FindName("StartupHost")).Visibility == Visibility.Visible,"初期設定が主窓を覆いません。");
    var polls = onboarding.Requests[0]; await Task.Delay(400); Check(onboarding.Requests[0] == polls && !((OnboardingView)onboarding.Window.StartupContent!).Polling,"AIを選ぶ前に状態を読み続けています。");
    Descendants<Button>(onboarding.Window.StartupContent!).Single(button => System.Windows.Automation.AutomationProperties.GetName(button) == "接続先を変更").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
    Check(onboarding.Window.Startup == StartupPhase.Setup,"初期設定から接続先の入力へ戻れません。");
    onboarding.Window.Close(); onboarding.Model.Dispose();

    var ready = Open(path => path switch { "/api/session" => "{\"authenticated\":true,\"authMode\":\"local\"}", "/api/setup" => "{\"phase\":\"ready\",\"harness\":null,\"harnesses\":[],\"guideBotId\":null,\"complete\":true,\"auth\":null}", "/api/bots" => "{\"bots\":[]}", "/api/rooms" => "{\"rooms\":[]}", "/api/queue" => "{\"items\":[]}", "/api/owner" => "{\"owner\":{\"name\":\"利用者\"}}", _ => "{}" });
    await ready.Window.ConnectAsync("http://localhost");
    Check(ready.Window.Startup == StartupPhase.Ready && ready.Window.StartupContent is null && ((FrameworkElement)ready.Window.FindName("StartupHost")).Visibility == Visibility.Collapsed,"初期設定済みの接続先で会話画面になりません。");
    ready.Window.Close(); ready.Model.Dispose();
    Check(Application.Current.Windows.Cast<Window>().All(candidate => new WindowInteropHelper(candidate).Handle == IntPtr.Zero),"起動画面の確認で窓のハンドルを作成しました。");
  }
  // a471-thinking-windows / a471-scrollback / a471-fill-drawn: a first page too short to scroll reads older pages by itself until 3 screens are DRAWN above the view, and stops there (not at the end of the history).
  // With foldedPages > 0 the first older pages are all folded rows (one line each run): a page that draws almost nothing must not end the loop.
  private static async Task FillChecks(int foldedPages = 0) {
    var time = DateTimeOffset.UtcNow; var olderReads = 0;
    TimelineMessage[] Rows(string prefix, int count, int minutes) => Enumerable.Range(0,count).Select(index => new TimelineMessage { Id = prefix + index, At = time.AddMinutes(minutes + index), Direction = "incoming", Message = "短い行 " + prefix + index }).ToArray();
    TimelineMessage[] Folded(string prefix, int count, int minutes) => Enumerable.Range(0,count).Select(index => new TimelineMessage { Id = prefix + index, At = time.AddMinutes(minutes + index), Direction = "incoming", Kind = "machine_event", Message = "hook: " + prefix + index, MachineEvent = new MachineEvent { Seq = index, View = "hook", Display = "fold", FoldGroup = "background", Title = "hook" } }).ToArray();
    var wire = new JsonSerializerOptions(BellApi.Json) { TypeInfoResolver = new System.Text.Json.Serialization.Metadata.DefaultJsonTypeInfoResolver { Modifiers = { info => { foreach (var property in info.Properties.Where(property => property.PropertyType == typeof(JsonElement))) property.ShouldSerialize = (_, value) => ((JsonElement)value!).ValueKind != JsonValueKind.Undefined; } } } };
    using var workspace = new Workspace(origin => new BellApi(origin, new MockHandler(request => {
      var path = request.RequestUri!.AbsolutePath;
      object result = path switch {
        "/api/session" => new { authenticated = true, authMode = "local" },
        "/api/setup" => new { phase = "ready", harness = (string?)null, harnesses = Array.Empty<object>(), guideBotId = (string?)null, complete = true, auth = (object?)null },
        "/api/bots" => new { bots = new[] { new { id = "one", name = "ユキ", displayName = "ユキ", color = "indigo" } } },
        "/api/rooms" => new { rooms = Array.Empty<object>() }, "/api/queue" => new { items = Array.Empty<object>() },
        "/api/owner" => new { owner = new { name = "利用者" } }, "/api/settings" => new { settings = Array.Empty<object>() },
        _ when path.EndsWith("/schedules") => new { schedules = Array.Empty<object>() },
        _ when path.EndsWith("/messages") => request.RequestUri.Query.Contains("before=")
          ? new MessagePage { Items = ++olderReads <= foldedPages ? Folded("fold" + olderReads + "-", 20, -30 * olderReads) : Rows("old" + olderReads + "-", 20, -30 * olderReads), HasMore = olderReads < 200 }
          : new MessagePage { Items = Rows("first", 3, 0), HasMore = true },
        _ => throw new InvalidOperationException("未対応の模擬URL: " + path)
      };
      return JsonSerializer.Serialize(result, wire);
    })));
    await workspace.ConnectAsync("http://localhost", listen:false);
    var window = new MainWindow(workspace, persistPlacement:false); var root = (FrameworkElement)window.Content;
    async Task Layout() { root.Measure(new Size(1280,820)); root.Arrange(new Rect(0,0,1280,820)); root.UpdateLayout(); await Dispatcher.Yield(DispatcherPriority.ApplicationIdle); root.UpdateLayout(); }
    await Layout();
    var scroll = (ScrollViewer)window.FindName("MessageScroll");
    ((ListBox)window.FindName("ConversationList")).SelectedItem = workspace.Entries.Single();
    for (var turn = 0; turn < 100 && !(workspace.Messages.Count > 3 && scroll.ScrollableHeight > 0 && !workspace.Loading); turn++) { await Task.Delay(20); await Layout(); }
    Check(scroll.ScrollableHeight > 0,"最初のページが画面を埋めないのに、古いページを読んで埋めていません。");
    Check(olderReads > foldedPages,"畳んだだけのページで古いページを読むのをやめています（読んだ回数 " + olderReads + "、畳んだページ " + foldedPages + "）。");
    Check(scroll.VerticalOffset >= 3 * scroll.ViewportHeight - 1,"描いた中身が上に3画面分に届いていません（offset " + scroll.VerticalOffset + "、viewport " + scroll.ViewportHeight + "）。");
    Check(workspace.HasMore && olderReads is > 0 and < 30,"上に残す分（描いた3画面）を超えても古いページを読み続けています（読んだ回数 " + olderReads + "、offset " + scroll.VerticalOffset + "、extent " + scroll.ExtentHeight + "、viewport " + scroll.ViewportHeight + "、行 " + workspace.Messages.Count + "）。");
    var settled = olderReads; await Task.Delay(300); await Layout();
    Check(olderReads == settled,"画面が埋まった後に古いページを読み続けています。");
    window.Close(); Console.WriteLine("最初のページが短い時に古いページで画面を埋める確認に成功しました（畳んだページ " + foldedPages + "）。");
  }
  // a471-scroll-jump: the row the Owner looks at stays put when an older page lands, also when he scrolled while the page was on its way (the position read when the request started must not be restored).
  private static async Task JumpChecks() {
    var time = DateTimeOffset.UtcNow; var gate = new TaskCompletionSource(); var olderRequested = false;
    TimelineMessage[] Rows(string prefix, int count, int minutes) => Enumerable.Range(0,count).Select(index => new TimelineMessage { Id = prefix + index, At = time.AddMinutes(minutes + index), Direction = "incoming", Message = "行 " + prefix + index }).ToArray();
    var wire = new JsonSerializerOptions(BellApi.Json) { TypeInfoResolver = new System.Text.Json.Serialization.Metadata.DefaultJsonTypeInfoResolver { Modifiers = { info => { foreach (var property in info.Properties.Where(property => property.PropertyType == typeof(JsonElement))) property.ShouldSerialize = (_, value) => ((JsonElement)value!).ValueKind != JsonValueKind.Undefined; } } } };
    using var workspace = new Workspace(origin => new BellApi(origin, new GatedHandler(async request => {
      var path = request.RequestUri!.AbsolutePath;
      if (path.EndsWith("/messages") && request.RequestUri.Query.Contains("before=")) { olderRequested = true; await gate.Task; return JsonSerializer.Serialize(new MessagePage { Items = Rows("old", 20, -100), HasMore = true }, wire); }
      object result = path switch {
        "/api/session" => new { authenticated = true, authMode = "local" },
        "/api/setup" => new { phase = "ready", harness = (string?)null, harnesses = Array.Empty<object>(), guideBotId = (string?)null, complete = true, auth = (object?)null },
        "/api/bots" => new { bots = new[] { new { id = "one", name = "ユキ", displayName = "ユキ", color = "indigo" } } },
        "/api/rooms" => new { rooms = Array.Empty<object>() }, "/api/queue" => new { items = Array.Empty<object>() },
        "/api/owner" => new { owner = new { name = "利用者" } }, "/api/settings" => new { settings = Array.Empty<object>() },
        _ when path.EndsWith("/schedules") => new { schedules = Array.Empty<object>() },
        _ when path.EndsWith("/messages") => new MessagePage { Items = Rows("first", 60, 0), HasMore = true },
        _ => throw new InvalidOperationException("未対応の模擬URL: " + path)
      };
      return JsonSerializer.Serialize(result, wire);
    })));
    await workspace.ConnectAsync("http://localhost", listen:false);
    var window = new MainWindow(workspace, persistPlacement:false); var root = (FrameworkElement)window.Content;
    async Task Layout() { root.Measure(new Size(1280,820)); root.Arrange(new Rect(0,0,1280,820)); root.UpdateLayout(); await Dispatcher.Yield(DispatcherPriority.ApplicationIdle); root.UpdateLayout(); }
    await Layout();
    var scroll = (ScrollViewer)window.FindName("MessageScroll");
    ((ListBox)window.FindName("ConversationList")).SelectedItem = workspace.Entries.Single();
    for (var turn = 0; turn < 100 && !(workspace.Messages.Count == 60 && scroll.ScrollableHeight > 0 && !workspace.Loading); turn++) { await Task.Delay(20); await Layout(); }
    Check(workspace.Messages.Count == 60 && scroll.ScrollableHeight > 3 * scroll.ViewportHeight,"最初のページが長い一覧になりません。");
    scroll.ScrollToVerticalOffset(2 * scroll.ViewportHeight); await Layout();   // less than 3 screens above: an older page is asked for
    for (var turn = 0; turn < 100 && !olderRequested; turn++) { await Task.Delay(20); await Layout(); }
    Check(olderRequested,"上に3画面分が無いのに古いページを読みません。");
    scroll.ScrollToVerticalOffset(scroll.VerticalOffset - 300); await Layout();   // the Owner keeps scrolling while the page is on its way
    double Top() => Descendants<MessageCard>(root).Single(card => card.Message?.Id == "first20").TransformToAncestor(scroll).Transform(new Point(0, 0)).Y;
    var before = Top();
    gate.SetResult();
    for (var turn = 0; turn < 100 && workspace.Messages.Count < 80; turn++) { await Task.Delay(20); await Layout(); }
    Check(workspace.Messages.Count >= 80,"古いページが届きません。");
    var after = Top();
    Check(Math.Abs(after - before) < 2,"古いページが届いて、見ている行が動きました（前 " + before + "、後 " + after + "）。");
    window.Close(); Console.WriteLine("古いページが届いても見ている行が動かない確認に成功しました。");
  }
  // a471-scroll-jump: a row that grows or appears ABOVE the viewed row (a late row, an image, a thinking text that grows) must not move it.
  private static async Task AnchorChecks() {
    var time = DateTimeOffset.UtcNow;
    TimelineMessage[] Rows(string prefix, int count, int minutes) => Enumerable.Range(0,count).Select(index => new TimelineMessage { Id = prefix + index, At = time.AddMinutes(minutes + index), Direction = "incoming", Message = "行 " + prefix + index }).ToArray();
    var wire = new JsonSerializerOptions(BellApi.Json) { TypeInfoResolver = new System.Text.Json.Serialization.Metadata.DefaultJsonTypeInfoResolver { Modifiers = { info => { foreach (var property in info.Properties.Where(property => property.PropertyType == typeof(JsonElement))) property.ShouldSerialize = (_, value) => ((JsonElement)value!).ValueKind != JsonValueKind.Undefined; } } } };
    using var workspace = new Workspace(origin => new BellApi(origin, new MockHandler(request => {
      var path = request.RequestUri!.AbsolutePath;
      object result = path switch {
        "/api/session" => new { authenticated = true, authMode = "local" },
        "/api/setup" => new { phase = "ready", harness = (string?)null, harnesses = Array.Empty<object>(), guideBotId = (string?)null, complete = true, auth = (object?)null },
        "/api/bots" => new { bots = new[] { new { id = "one", name = "ユキ", displayName = "ユキ", color = "indigo" } } },
        "/api/rooms" => new { rooms = Array.Empty<object>() }, "/api/queue" => new { items = Array.Empty<object>() },
        "/api/owner" => new { owner = new { name = "利用者" } }, "/api/settings" => new { settings = Array.Empty<object>() },
        _ when path.EndsWith("/schedules") => new { schedules = Array.Empty<object>() },
        _ when path.EndsWith("/messages") => new MessagePage { Items = Rows("first", 60, 0), HasMore = false },
        _ => throw new InvalidOperationException("未対応の模擬URL: " + path)
      };
      return JsonSerializer.Serialize(result, wire);
    })));
    await workspace.ConnectAsync("http://localhost", listen:false);
    var window = new MainWindow(workspace, persistPlacement:false); var root = (FrameworkElement)window.Content;
    async Task Layout() { root.Measure(new Size(1280,820)); root.Arrange(new Rect(0,0,1280,820)); root.UpdateLayout(); await Dispatcher.Yield(DispatcherPriority.ApplicationIdle); root.UpdateLayout(); }
    await Layout();
    var scroll = (ScrollViewer)window.FindName("MessageScroll");
    ((ListBox)window.FindName("ConversationList")).SelectedItem = workspace.Entries.Single();
    for (var turn = 0; turn < 100 && !(workspace.Messages.Count == 60 && scroll.ScrollableHeight > 0 && !workspace.Loading); turn++) { await Task.Delay(20); await Layout(); }
    scroll.ScrollToVerticalOffset(scroll.ScrollableHeight / 2); await Layout(); await Task.Delay(100); await Layout();
    double Y(MessageCard card) => card.TransformToAncestor(scroll).Transform(new Point(0, 0)).Y;
    var viewed = Descendants<MessageCard>(root).Where(card => card.Message is not null && Y(card) >= 0).OrderBy(Y).First().Message!.Id;
    double Top() => Y(Descendants<MessageCard>(root).Single(card => card.Message?.Id == viewed));
    var start = Top();
    Check(start > 0 && start < scroll.ViewportHeight,"見ている行が画面にありません（" + start + "）。");
    var grown = workspace.Messages.Single(item => item.Message.Id == "first5"); grown.Update(grown.Message with { Message = string.Join("\n\n", Enumerable.Range(0, 8).Select(n => "長い行 " + n)) });
    await Layout(); await Task.Delay(100); await Layout();
    Check(Math.Abs(Top() - start) < 2,"上の行の高さが変わって、見ている行が動きました（前 " + start + "、後 " + Top() + "）。");
    workspace.Messages.Insert(3, new MessageItem(new TimelineMessage { Id = "late", At = time.AddMinutes(-1), Direction = "incoming", Message = "遅れて届いた行\n\n二つ目" }));
    await Layout(); await Task.Delay(100); await Layout();
    Check(Math.Abs(Top() - start) < 2,"上に行が足されて、見ている行が動きました（前 " + start + "、後 " + Top() + "）。");
    window.Close(); Console.WriteLine("上の行が変わっても見ている行が動かない確認に成功しました。");
  }
  // a471-scroll-smooth: a row that arrives while the view is at the bottom is followed with an animated scroll (steps of at most 33 px), not a jump; the wheel stops it.
  private static async Task SmoothChecks() {
    var time = DateTimeOffset.UtcNow;
    TimelineMessage[] Rows(string prefix, int count, int minutes) => Enumerable.Range(0,count).Select(index => new TimelineMessage { Id = prefix + index, At = time.AddMinutes(minutes + index), Direction = "incoming", Message = "行 " + prefix + index }).ToArray();
    var wire = new JsonSerializerOptions(BellApi.Json) { TypeInfoResolver = new System.Text.Json.Serialization.Metadata.DefaultJsonTypeInfoResolver { Modifiers = { info => { foreach (var property in info.Properties.Where(property => property.PropertyType == typeof(JsonElement))) property.ShouldSerialize = (_, value) => ((JsonElement)value!).ValueKind != JsonValueKind.Undefined; } } } };
    using var workspace = new Workspace(origin => new BellApi(origin, new MockHandler(request => {
      var path = request.RequestUri!.AbsolutePath;
      object result = path switch {
        "/api/session" => new { authenticated = true, authMode = "local" },
        "/api/setup" => new { phase = "ready", harness = (string?)null, harnesses = Array.Empty<object>(), guideBotId = (string?)null, complete = true, auth = (object?)null },
        "/api/bots" => new { bots = new[] { new { id = "one", name = "ユキ", displayName = "ユキ", color = "indigo" } } },
        "/api/rooms" => new { rooms = Array.Empty<object>() }, "/api/queue" => new { items = Array.Empty<object>() },
        "/api/owner" => new { owner = new { name = "利用者" } }, "/api/settings" => new { settings = Array.Empty<object>() },
        _ when path.EndsWith("/schedules") => new { schedules = Array.Empty<object>() },
        _ when path.EndsWith("/messages") => new MessagePage { Items = Rows("first", 60, 0), HasMore = false },
        _ => throw new InvalidOperationException("未対応の模擬URL: " + path)
      };
      return JsonSerializer.Serialize(result, wire);
    })));
    await workspace.ConnectAsync("http://localhost", listen:false);
    var window = new MainWindow(workspace, persistPlacement:false); var root = (FrameworkElement)window.Content;
    async Task Layout() { root.Measure(new Size(1280,820)); root.Arrange(new Rect(0,0,1280,820)); root.UpdateLayout(); await Dispatcher.Yield(DispatcherPriority.ApplicationIdle); root.UpdateLayout(); }
    await Layout();
    var scroll = (ScrollViewer)window.FindName("MessageScroll");
    ((ListBox)window.FindName("ConversationList")).SelectedItem = workspace.Entries.Single();
    for (var turn = 0; turn < 100 && !(workspace.Messages.Count == 60 && scroll.ScrollableHeight > 0 && !workspace.Loading); turn++) { await Task.Delay(20); await Layout(); }
    scroll.ScrollToVerticalOffset(scroll.ScrollableHeight); await Layout(); await Task.Delay(100); await Layout();
    if (!SystemParameters.ClientAreaAnimation) { Console.WriteLine("この端末はアニメーション効果が切れているため、滑らかな追従の確認を省きました。"); window.Close(); return; }
    var last = scroll.VerticalOffset; var before = scroll.ScrollableHeight;
    workspace.Messages.Add(new MessageItem(new TimelineMessage { Id = "arrived", At = time.AddMinutes(100), Direction = "incoming", Message = "届いた行\n\n二つ目\n\n三つ目" }));
    var steps = new List<double>(); var grew = false;
    for (var turn = 0; turn < 200; turn++) { await Task.Delay(16); await Layout(); steps.Add(scroll.VerticalOffset - last); last = scroll.VerticalOffset; grew |= scroll.ScrollableHeight > before + 20; if (grew && scroll.VerticalOffset >= scroll.ScrollableHeight - 0.5) break; }
    Check(grew,"届いた行で内容が増えません。");
    Check(Math.Abs(scroll.VerticalOffset - scroll.ScrollableHeight) < 1,"届いた行へ最後まで追従しません（offset " + scroll.VerticalOffset + "、末尾 " + scroll.ScrollableHeight + "）。");
    Check(steps.Count(step => step > 0.5) >= 3,"届いた行を一度に動いて表示しています（動いた回数 " + steps.Count(step => step > 0.5) + "、歩み " + string.Join(",", steps.Take(12).Select(step => Math.Round(step))) + "、追従 " + typeof(MainWindow).GetField("following", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!.GetValue(window) + "、アニメ " + SystemParameters.ClientAreaAnimation + "）。");
    Check(steps.Max() <= 67,"1回の標本で33px×2より大きく動きました（" + steps.Max() + "）。"); // a sample here can span two 16 ms timer ticks, each at most 33 px
    // the wheel stops the following
    workspace.Messages.Add(new MessageItem(new TimelineMessage { Id = "arrived2", At = time.AddMinutes(101), Direction = "incoming", Message = "もう一行\n\n二つ目\n\n三つ目" }));
    await Task.Delay(40); await Layout();
    scroll.RaiseEvent(new System.Windows.Input.MouseWheelEventArgs(System.Windows.Input.Mouse.PrimaryDevice, Environment.TickCount, 0) { RoutedEvent = UIElement.PreviewMouseWheelEvent });
    var stopped = scroll.VerticalOffset; await Task.Delay(300); await Layout();
    Check(Math.Abs(scroll.VerticalOffset - stopped) < 1,"ホイールで追従が止まりません。");
    window.Close(); Console.WriteLine("下に届いた行を滑らかに追う確認に成功しました。");
  }
  // a471-scroll-refresh: the newest page is read again (SSE event, reconnect of the stream, return from sleep) while older rows stay. It may come back short for a moment (the newest rows missing) and then whole with new rows.
  // The rows already held must stay, and the row the Owner is looking at must not move, in both steps.
  private static async Task RefreshChecks() {
    var time = DateTimeOffset.UtcNow; var server = Enumerable.Range(0, 60).Select(index => new TimelineMessage { Id = "r" + index.ToString("D3"), At = time.AddMinutes(index), Direction = "incoming", Message = "行 " + index }).ToList();
    var wire = new JsonSerializerOptions(BellApi.Json) { TypeInfoResolver = new System.Text.Json.Serialization.Metadata.DefaultJsonTypeInfoResolver { Modifiers = { info => { foreach (var property in info.Properties.Where(property => property.PropertyType == typeof(JsonElement))) property.ShouldSerialize = (_, value) => ((JsonElement)value!).ValueKind != JsonValueKind.Undefined; } } } };
    using var workspace = new Workspace(origin => new BellApi(origin, new MockHandler(request => {
      var path = request.RequestUri!.AbsolutePath; var query = request.RequestUri.Query;
      object result = path switch {
        "/api/session" => new { authenticated = true, authMode = "local" },
        "/api/setup" => new { phase = "ready", harness = (string?)null, harnesses = Array.Empty<object>(), guideBotId = (string?)null, complete = true, auth = (object?)null },
        "/api/bots" => new { bots = new[] { new { id = "one", name = "ユキ", displayName = "ユキ", color = "indigo" } } },
        "/api/rooms" => new { rooms = Array.Empty<object>() }, "/api/queue" => new { items = Array.Empty<object>() },
        "/api/owner" => new { owner = new { name = "利用者" } }, "/api/settings" => new { settings = Array.Empty<object>() },
        _ when path.EndsWith("/schedules") => new { schedules = Array.Empty<object>() },
        _ when path.EndsWith("/messages") && query.Contains("after=") => new MessagePage { Items = server.Where(row => string.CompareOrdinal(row.Id, Uri.UnescapeDataString(query.Split("after=")[1].Split('&')[0])) > 0).ToArray(), HasMore = false },
        _ when path.EndsWith("/messages") => new MessagePage { Items = server.TakeLast(query.Contains("limit=30") ? 30 : 100).ToArray(), HasMore = false },
        _ => throw new InvalidOperationException("未対応の模擬URL: " + path)
      };
      return JsonSerializer.Serialize(result, wire);
    })));
    await workspace.ConnectAsync("http://localhost", listen:false);
    var window = new MainWindow(workspace, persistPlacement:false); var root = (FrameworkElement)window.Content;
    async Task Layout() { root.Measure(new Size(1280,820)); root.Arrange(new Rect(0,0,1280,820)); root.UpdateLayout(); await Dispatcher.Yield(DispatcherPriority.ApplicationIdle); root.UpdateLayout(); }
    await Layout();
    var scroll = (ScrollViewer)window.FindName("MessageScroll");
    ((ListBox)window.FindName("ConversationList")).SelectedItem = workspace.Entries.Single();
    for (var turn = 0; turn < 100 && !(workspace.Messages.Count == 60 && scroll.ScrollableHeight > 0 && !workspace.Loading); turn++) { await Task.Delay(20); await Layout(); }
    scroll.ScrollToVerticalOffset(scroll.ScrollableHeight - 2.5 * scroll.ViewportHeight); await Layout(); await Task.Delay(150); await Layout();   // reading near the newest rows, not at the bottom
    double Y(MessageCard card) => card.TransformToAncestor(scroll).Transform(new Point(0, 0)).Y;
    var viewed = Descendants<MessageCard>(root).Where(card => card.Message is not null && Y(card) >= 0).OrderBy(Y).First().Message!.Id;
    double Top() => Y(Descendants<MessageCard>(root).Single(card => card.Message?.Id == viewed));
    var start = Top(); var held = workspace.Messages.Count;
    // 1. the newest page comes back short: the newest 12 rows are missing for a moment
    var kept = server.ToList(); server.RemoveRange(48, 12);
    await workspace.RefreshManagementAsync(); await Layout(); await Task.Delay(100); await Layout();
    Check(workspace.Messages.Count == held,"最新ページが短く返った時に、持っている行が減りました（" + held + " → " + workspace.Messages.Count + "）。");
    Check(Math.Abs(Top() - start) < 2,"最新ページが短く返った時に、見ている行が動きました（前 " + start + "、後 " + Top() + "）。");
    // 2. it comes back whole with three new rows
    server = kept; server.AddRange(Enumerable.Range(60, 3).Select(index => new TimelineMessage { Id = "r" + index.ToString("D3"), At = time.AddMinutes(index), Direction = "incoming", Message = "新しい行 " + index }));
    await workspace.RefreshManagementAsync(); await Layout(); await Task.Delay(100); await Layout();
    Check(workspace.Messages.Count == held + 3,"最新ページが戻って、新しい行が足されません（" + workspace.Messages.Count + "）。");
    Check(Math.Abs(Top() - start) < 2,"最新ページが戻って新しい行が届いた時に、見ている行が動きました（前 " + start + "、後 " + Top() + "）。");
    window.Close(); Console.WriteLine("最新ページの取り直しで見ている行が動かない確認に成功しました。");
  }
  private static void Check(bool value,string message) { if (!value) throw new InvalidOperationException(message); }
  private static IEnumerable<T> Descendants<T>(DependencyObject root) where T:DependencyObject { for(var index=0;index<VisualTreeHelper.GetChildrenCount(root);index++){var child=VisualTreeHelper.GetChild(root,index);if(child is T match)yield return match;foreach(var item in Descendants<T>(child))yield return item;} }
  private sealed class GatedHandler(Func<HttpRequestMessage,Task<string>> response):HttpMessageHandler { protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token)=>new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent(await response(request),System.Text.Encoding.UTF8,"application/json")}; }
  private sealed class MockHandler(Func<HttpRequestMessage,string> response):HttpMessageHandler { protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token)=>Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent(response(request),System.Text.Encoding.UTF8,"application/json")}); }
}
