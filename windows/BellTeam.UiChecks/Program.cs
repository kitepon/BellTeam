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
    dispatcher.BeginInvoke(async () => { try { if (args is ["--access-cookie", var action, var profile]) await AccessCookieCheck.Run([action,profile]); else if (args.Length == 0) await Run(); else throw new ArgumentException("引数は --access-cookie <write|read> <試験プロファイル> です。"); } catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; } finally { app.Shutdown(); dispatcher.InvokeShutdown(); } });
    Dispatcher.Run();
  }
  private static async Task Run() {
    var newMessage = false;
    var time = DateTimeOffset.UtcNow;
    var messages = Enumerable.Range(0,30).Select(index => new TimelineMessage { Id = "m" + index, At = time.AddMinutes(index - 30), Direction = "incoming", Message = "本文" + index + " " + new string('あ',180) }).ToArray();
    using var workspace = new Workspace(origin => new BellApi(origin, new MockHandler(request => {
      var path = request.RequestUri!.AbsolutePath;
      object result = path switch {
        "/api/session" => new { authenticated = true, authMode = "local" },
        "/api/bots" => new { bots = new[] { new { id = "one", name = "ユキ", displayName = "ユキ", color = "indigo" } } },
        "/api/rooms" => new { rooms = Array.Empty<object>() }, "/api/queue" => new { items = Array.Empty<object>() },
        "/api/owner" => new { owner = new { name = "利用者" } }, "/api/settings" => new { settings = Array.Empty<object>() },
        _ when path.EndsWith("/schedules") => new { schedules = Array.Empty<object>() },
        _ when path.EndsWith("/messages") => request.RequestUri.Query.Contains("before=")
          ? new MessagePage { Items = Enumerable.Range(0,10).Select(index => new TimelineMessage { Id = "old" + index, At = time.AddMinutes(index - 50), Direction = "incoming", Message = "以前の本文 " + new string('い',100) }).ToArray(), HasMore = false }
          : new MessagePage { Items = request.RequestUri.Query.Contains("after=") ? (newMessage ? [new TimelineMessage { Id = "new", At = time, Message = "新着です", Direction = "incoming" }] : []) : (newMessage ? messages.Concat([new TimelineMessage { Id = "new", At = time, Message = "新着です", Direction = "incoming" }]).ToArray() : messages), HasMore = true },
        _ => throw new InvalidOperationException("未対応の模擬URL: " + path)
      };
      return JsonSerializer.Serialize(result, BellApi.Json);
    })));
    var disconnected = new MainWindow(workspace, persistPlacement:false); disconnected.ShowSettings(); disconnected.ShowSchedules();
    Check(((FrameworkElement)disconnected.FindName("PageArea")).Visibility == Visibility.Collapsed && workspace.ActionError is null,"未接続で設定のページが開きました。"); disconnected.Close();
    await workspace.ConnectAsync("http://localhost", listen:false);
    var window = new MainWindow(workspace, persistPlacement:false); var root = (FrameworkElement)window.Content;
    async Task Layout() { root.Measure(new Size(1280,820)); root.Arrange(new Rect(0,0,1280,820)); root.UpdateLayout(); await Dispatcher.Yield(DispatcherPriority.ApplicationIdle); root.UpdateLayout(); }
    window.ShowSettings(); await window.PageReady; await Layout();
    Check(((FrameworkElement)window.FindName("PageArea")).Visibility == Visibility.Visible,"設定から勝手に会話へ戻りました。");
    var page = (EditorWindow)typeof(MainWindow).GetField("page",BindingFlags.Instance|BindingFlags.NonPublic)!.GetValue(window)!;
    var completion = new TaskCompletionSource<bool>(); var writing = (Task)typeof(EditorWindow).GetMethod("RunAsync",BindingFlags.Instance|BindingFlags.NonPublic)!.Invoke(page,[new Func<Task<bool>>(()=>completion.Task),false])!;
    var closing = new CancelEventArgs(); typeof(Window).GetMethod("OnClosing",BindingFlags.Instance|BindingFlags.NonPublic)!.Invoke(window,[closing]); Check(closing.Cancel,"ページへの書込中に窓を閉じられます。"); completion.SetResult(false); await writing;
    closing = new(); typeof(Window).GetMethod("OnClosing",BindingFlags.Instance|BindingFlags.NonPublic)!.Invoke(window,[closing]); Check(!closing.Cancel,"書込後も窓を閉じられません。");
    var list = (ListBox)window.FindName("ConversationList"); var entry = workspace.Entries.Single(); list.SelectedItem = entry; await Layout();
    Check(((FrameworkElement)window.FindName("PageArea")).Visibility == Visibility.Collapsed,"一覧から会話へ戻れません。");
    window.ShowSchedules(); await window.PageReady; await Layout();
    var item = Descendants<ListBoxItem>(list).Single(); item.RaiseEvent(new MouseButtonEventArgs(Mouse.PrimaryDevice,0,MouseButton.Left) { RoutedEvent = UIElement.PreviewMouseDownEvent }); await Layout();
    Check(((FrameworkElement)window.FindName("PageArea")).Visibility == Visibility.Collapsed,"同じ会話へ戻れません。");
    var scroll = (ScrollViewer)window.FindName("MessageScroll");
    scroll.ScrollToEnd(); await Layout(); Check(scroll.ScrollableHeight > 1000,"長い会話を配置できません。");
    scroll.ScrollToVerticalOffset(scroll.ScrollableHeight / 2); await Layout(); var offset = scroll.VerticalOffset;
    newMessage = true; await workspace.RefreshManagementAsync(); await Layout();
    Check(Math.Abs(scroll.VerticalOffset-offset) < 1,"新着で読んでいた位置が動きました。");
    Check(((Button)window.FindName("NewMessagesButton")).Visibility == Visibility.Visible,"新着の入口が見えません。");
    var oldHeight = scroll.ExtentHeight; var older = Descendants<Button>(root).Single(button => button.Content as string == "以前のメッセージを読む");
    older.RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); await Layout();
    Check(workspace.Messages.Count == 41,"以前のメッセージが増えていません。");
    Check(Math.Abs((scroll.VerticalOffset-offset) - (scroll.ExtentHeight-oldHeight)) < 1,"以前の履歴を追加して位置がずれました。");
    Check(Application.Current.Windows.Cast<Window>().All(candidate => new WindowInteropHelper(candidate).Handle == IntPtr.Zero),"確認で窓のハンドルを作成しました。");
    workspace.Messages.Clear(); typeof(Workspace).GetProperty(nameof(Workspace.Loading))!.SetValue(workspace,true);
    Check(!((TextBlock)window.FindName("WelcomeNote")).Text.Contains("最初のメッセージ"),"読込中に送信の案内が出ます。");
    window.Close(); Console.WriteLine("画面内移動・新着・過去ログ位置・前面非表示の確認に成功しました。");
  }
  private static void Check(bool value,string message) { if (!value) throw new InvalidOperationException(message); }
  private static IEnumerable<T> Descendants<T>(DependencyObject root) where T:DependencyObject { for(var index=0;index<VisualTreeHelper.GetChildrenCount(root);index++){var child=VisualTreeHelper.GetChild(root,index);if(child is T match)yield return match;foreach(var item in Descendants<T>(child))yield return item;} }
  private sealed class MockHandler(Func<HttpRequestMessage,string> response):HttpMessageHandler { protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token)=>Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent(response(request),System.Text.Encoding.UTF8,"application/json")}); }
}
