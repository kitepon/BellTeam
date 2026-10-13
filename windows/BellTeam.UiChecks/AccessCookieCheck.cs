using System.IO;
using System.Net;
using System.Windows.Interop;
using System.Windows.Threading;
using BellTeam.App;
using Microsoft.Web.WebView2.Core;
using System.Runtime.InteropServices;
public static class AccessCookieCheck {
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsWindowVisible(IntPtr handle);
  public static async Task Run(string[] args) {
    var profile = Path.GetFullPath(args[1]); var origin = new Uri("https://bellteam-login-test.invalid/");
    if (args[0] == "write") {
      using var source = new HwndSource(new HwndSourceParameters("BellTeam非表示ログイン試験") { Width = 1, Height = 1, WindowStyle = unchecked((int)0x80000000), ExtendedWindowStyle = 0x08000000 });
      var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: profile);
      var controller = await environment.CreateCoreWebView2ControllerAsync(source.Handle);
      try {
        controller.IsVisible = false;
        var cookie = controller.CoreWebView2.CookieManager.CreateCookie("CF_Authorization", "FAKE-ACCESS-COOKIE", origin.Host, "/");
        cookie.IsSecure = true; cookie.IsHttpOnly = true; cookie.Expires = DateTime.UtcNow.AddDays(1);
        controller.CoreWebView2.CookieManager.AddOrUpdateCookie(cookie);
        if ((await controller.CoreWebView2.CookieManager.GetCookiesAsync(origin.AbsoluteUri)).Count != 1) throw new InvalidOperationException("模擬Cookieを保存できません。");
        if (IsWindowVisible(source.Handle)) throw new InvalidOperationException("試験の窓が表示されています。");
        Console.WriteLine("模擬Cookieを非表示で保存しました。");
      } finally { controller.Close(); }
    } else if (args[0] == "clear") {
      var access = new DesktopAccess(profile); await access.SignOutAsync(); Console.WriteLine("模擬Cookieを消去しました。");
    } else if (args[0] is "read" or "empty") {
      var access = new DesktopAccess(profile); await access.RestoreAsync(origin);
      if (args[0] == "empty") { if (access.Cookies.GetCookies(origin).Count != 0) throw new InvalidOperationException("模擬Cookieが残っています。"); Console.WriteLine("別プロセスでCookieが空であることを確認しました。"); }
      else { if (access.Cookies.GetCookies(origin).Cast<Cookie>().Single().Value != "FAKE-ACCESS-COOKIE") throw new InvalidOperationException("模擬Cookieを復元できません。"); Console.WriteLine("別プロセスで模擬Cookieを復元しました。"); }
    } else throw new ArgumentException("試験の操作はwrite・read・clear・emptyを指定してください。");
  }
}
