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
    var latest = (Button)window.FindName("NewMessagesButton"); Check(latest.Visibility == Visibility.Visible && latest.Content as string == "最新へ ↓","読み返している間に「最新へ ↓」が出ません。");
    newMessage = true; await workspace.RefreshManagementAsync(); await Layout();
    Check(Math.Abs(scroll.VerticalOffset-offset) < 1,"新着で読んでいた位置が動きました。");
    Check(latest.Visibility == Visibility.Visible && latest.Content as string == "新着メッセージ ↓","新着の入口が見えません。");
    var oldHeight = scroll.ExtentHeight; var older = Descendants<Button>(root).Single(button => button.Content as string == "以前のメッセージを読む");
    older.RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); await Layout();
    Check(workspace.Messages.Count == 41,"以前のメッセージが増えていません。");
    Check(Math.Abs((scroll.VerticalOffset-offset) - (scroll.ExtentHeight-oldHeight)) < 1,"以前の履歴を追加して位置がずれました。");
    Check(Application.Current.Windows.Cast<Window>().All(candidate => new WindowInteropHelper(candidate).Handle == IntPtr.Zero),"確認で窓のハンドルを作成しました。");
    root.Measure(new Size(5120,1400)); root.Arrange(new Rect(0,0,5120,1400)); root.UpdateLayout();
    Check(Descendants<ProfileView>(root).Single().ActualWidth <= 760,"横長の窓でプロフィールが伸びすぎます。");
    Check(Descendants<MessageCard>(root).All(card=>((FrameworkElement)card.Content).ActualWidth<=900),"横長の窓で吹き出しが伸びすぎます。");
    workspace.DraftText = "同じ接続先の下書き"; await (Task)typeof(MainWindow).GetMethod("ChangeServerAsync",BindingFlags.Instance|BindingFlags.NonPublic)!.Invoke(window,[workspace.Server])!;
    await workspace.SelectAsync(workspace.Entries.Single()); Check(workspace.DraftText=="同じ接続先の下書き","同じ接続先の再入力でログアウトしています。"); workspace.DraftText="";
    workspace.Messages.Clear(); typeof(Workspace).GetProperty(nameof(Workspace.Loading))!.SetValue(workspace,true);
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
    Lay(held.Window); var change = Descendants<Button>(held.Window.StartupContent!).Single(button => System.Windows.Automation.AutomationProperties.GetName(button) == "接続先を変更");
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
  private static void Check(bool value,string message) { if (!value) throw new InvalidOperationException(message); }
  private static IEnumerable<T> Descendants<T>(DependencyObject root) where T:DependencyObject { for(var index=0;index<VisualTreeHelper.GetChildrenCount(root);index++){var child=VisualTreeHelper.GetChild(root,index);if(child is T match)yield return match;foreach(var item in Descendants<T>(child))yield return item;} }
  private sealed class MockHandler(Func<HttpRequestMessage,string> response):HttpMessageHandler { protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token)=>Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent(response(request),System.Text.Encoding.UTF8,"application/json")}); }
}
