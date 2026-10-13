using System.IO;
using System.Net;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using BellTeam.Core;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace BellTeam.App;

public sealed class DesktopAccess(string? profileDirectory = null)
{
    public string ProfileDirectory { get; } = profileDirectory ?? Path.Combine(SettingsStore.UserDirectory, "WebView2");
    public CookieContainer Cookies { get; } = new();
    public async Task RestoreAsync(Uri origin)
    {
        if (origin.Scheme != "https") return;
        using var source = new HwndSource(new HwndSourceParameters("BellTeamログイン情報の読み取り") { Width = 1, Height = 1, WindowStyle = unchecked((int)0x80000000), ExtendedWindowStyle = 0x08000000 });
        var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: ProfileDirectory);
        var controller = await environment.CreateCoreWebView2ControllerAsync(source.Handle);
        try { controller.IsVisible = false; await CopyCookiesAsync(controller.CoreWebView2, origin); }
        finally { controller.Close(); }
    }
    public async Task<bool> CopyCookiesAsync(CoreWebView2 browser, Uri origin)
    {
        var cookies = await browser.CookieManager.GetCookiesAsync(origin.AbsoluteUri);
        AccessCookies.Replace(Cookies, origin, cookies.Select(cookie => new Cookie(cookie.Name, cookie.Value, cookie.Path, cookie.Domain) { HttpOnly = cookie.IsHttpOnly, Secure = cookie.IsSecure, Expires = cookie.IsSession ? DateTime.MinValue : cookie.Expires }));
        return Cookies.GetCookies(origin).Cast<Cookie>().Any(cookie => cookie.Name == "CF_Authorization" && !cookie.Expired);
    }
}

public sealed class AccessLoginWindow : Window
{
    private readonly WebView2 browser = new();
    private readonly TextBlock status = new() { Text = "ログイン画面を開いています…", TextWrapping = TextWrapping.Wrap, Margin = new Thickness(12) };
    private bool checking;
    private bool closed;
    private readonly DesktopAccess access;
    private readonly Uri origin;
    private readonly CancellationTokenSource lifetime = new();
    public AccessLoginWindow(DesktopAccess access, Uri origin)
    {
        this.access = access; this.origin = origin;
        SetResourceReference(StyleProperty, typeof(Window));
        Title = "Cloudflare Accessでログイン"; Width = 880; Height = 760; WindowStartupLocation = WindowStartupLocation.CenterOwner;
        var panel = new DockPanel(); DockPanel.SetDock(status, Dock.Bottom); panel.Children.Add(status); panel.Children.Add(browser); Content = panel;
        Loaded += async (_, _) =>
        {
            try
            {
                if (origin.Scheme != "https") throw new BellApiException("外部ログインにはHTTPSの接続先を指定してください。");
                var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: access.ProfileDirectory);
                if (closed) return;
                await browser.EnsureCoreWebView2Async(environment);
                if (closed) return;
                browser.CoreWebView2.NavigationCompleted += async (_, _) => await CheckAsync();
                browser.CoreWebView2.NewWindowRequested += (_, args) => { args.Handled = true; browser.CoreWebView2.Navigate(args.Uri); };
                browser.CoreWebView2.Navigate(new Uri(origin, "api/session").AbsoluteUri);
                status.Text = "Cloudflare Accessでログインしてください。完了すると自動で接続します。";
            }
            catch (Exception) { if (!closed) status.Text = "ログイン画面を開けませんでした。WebView2 Runtimeと接続先を確認して、開き直してください。"; }
        };
        Closed += (_, _) => { closed = true; lifetime.Cancel(); lifetime.Dispose(); browser.Dispose(); };
    }
    private async Task CheckAsync()
    {
        if (checking || closed) return;
        checking = true;
        try
        {
            if (!await access.CopyCookiesAsync(browser.CoreWebView2, origin) || closed) return;
            using var api = new BellApi(origin, cookies: access.Cookies);
            var session = await api.GetAsync<SessionInfo>("/api/session", lifetime.Token);
            if (session.Authenticated && !closed) DialogResult = true;
        }
        catch (BellApiException error) when (error.RequiresLogin) { }
        catch (Exception) { if (!closed) status.Text = "ログイン後の接続を確認できませんでした。閉じて接続先を確認してください。"; }
        finally { checking = false; }
    }
}
