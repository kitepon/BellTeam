using System.Net;
using Android.Webkit;
using Avalonia;
using Avalonia.Android;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Platform;
using BellTeam.Core;
using BellTeam.Linux;
using AndroidWebView = Android.Webkit.WebView;

namespace BellTeam.Android;

// Cloudflare Access sign-in on Android (the twin of windows DesktopAccess/AccessLoginView): the Access login runs in the system WebView, whose CookieManager keeps the CF_Authorization
// cookie between launches; the cookie is copied into the CookieContainer that BellApi sends (Core AccessCookies), exactly as on Windows.
public sealed class AccessSession
{
    public CookieContainer Cookies { get; } = new();

    // Runs before every connection (Workspace prepareConnection): a login kept by the WebView from an earlier launch is picked up again.
    public Task PrepareAsync(Uri origin) { if (origin.Scheme == Uri.UriSchemeHttps) CopyCookies(origin); return Task.CompletedTask; }

    // True when the WebView holds a CF_Authorization cookie for the origin; it replaces the one in the container.
    public bool CopyCookies(Uri origin)
    {
        var raw = CookieManager.Instance?.GetCookie(origin.AbsoluteUri) ?? "";
        var cookies = raw.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Select(part => part.Split('=', 2)).Where(pair => pair.Length == 2)
            .Select(pair => new Cookie(pair[0], pair[1], "/", origin.Host) { Secure = origin.Scheme == Uri.UriSchemeHttps, HttpOnly = true }).ToArray();
        AccessCookies.Replace(Cookies, origin, cookies);
        return Cookies.GetCookies(origin).Cast<Cookie>().Any(cookie => cookie.Name == "CF_Authorization" && !cookie.Expired);
    }

    public void SignOut() { AccessCookies.Clear(Cookies); CookieManager.Instance?.RemoveAllCookies(null); CookieManager.Instance?.Flush(); }
}

// The system WebView inside an Avalonia page.
internal sealed class WebViewHost : NativeControlHost
{
    public AndroidWebView? View { get; private set; }
    public Action<AndroidWebView>? Created { get; set; }
    protected override IPlatformHandle CreateNativeControlCore(IPlatformHandle parent)
    {
        View = new AndroidWebView(MainActivity.Current);
        View.Settings.JavaScriptEnabled = true; View.Settings.DomStorageEnabled = true;
        CookieManager.Instance?.SetAcceptCookie(true); CookieManager.Instance?.SetAcceptThirdPartyCookies(View, true);
        Created?.Invoke(View);
        return new AndroidViewControlHandle(View);
    }
    protected override void DestroyNativeControlCore(IPlatformHandle control) { View?.Destroy(); View = null; base.DestroyNativeControlCore(control); }
}

// The 「ログイン」 page: Access's login in a WebView; once the session answers authenticated the page calls loggedIn and the shell connects again.
public sealed class AccessLoginPage : Grid
{
    private readonly WebViewHost host = new();
    private readonly TextBlock status = new() { Text = AndroidStrings.AccessLogin_status_1, TextWrapping = TextWrapping.Wrap, Foreground = BellTheme.Ink, FontSize = 14, Margin = new Thickness(12, 8) };
    private readonly CancellationTokenSource life = new();
    private readonly AccessSession access;
    private readonly Uri origin;
    private readonly Action loggedIn;
    private bool checking, done;

    public AccessLoginPage(AccessSession access, Uri origin, Action loggedIn, Action changeServer)
    {
        this.access = access; this.origin = origin; this.loggedIn = loggedIn;
        RowDefinitions = new RowDefinitions("*,Auto"); Background = Brushes.White;
        var change = SettingsUi.Capsule(AndroidStrings.AccessLogin_AccessLoginPage_1, SettingsUi.Fill, SettingsUi.Ink, 8, 13, new Thickness(14, 8)); change.FontWeight = FontWeight.Normal; change.HorizontalAlignment = HorizontalAlignment.Right; change.Margin = new Thickness(12, 0, 12, 12); change.Click += (_, _) => changeServer();
        var bottom = new StackPanel { Background = BellTheme.BandFill, Children = { status, change } }; SetRow(bottom, 1);
        Children.Add(host); Children.Add(bottom);
        if (origin.Scheme != Uri.UriSchemeHttps) { status.Text = AndroidStrings.AccessLogin_AccessLoginPage_2; return; }
        host.Created = view =>
        {
            view.SetWebViewClient(new Client(this));
            view.LoadUrl(new Uri(origin, "api/session").AbsoluteUri);
            status.Text = AndroidStrings.AccessLogin_AccessLoginPage_3;
        };
    }

    public void End() { life.Cancel(); }

    private async Task CheckAsync()
    {
        if (checking || done) return;
        checking = true;
        try
        {
            if (!access.CopyCookies(origin)) return;
            using var api = new BellApi(origin, cookies: access.Cookies);
            var session = await api.GetAsync<SessionInfo>("/api/session", life.Token);
            if (session.Authenticated && !done) { done = true; loggedIn(); }
        }
        catch (BellApiException error) when (error.RequiresLogin) { }
        catch (OperationCanceledException) when (life.IsCancellationRequested) { }
        catch (Exception) { if (!done) status.Text = AndroidStrings.AccessLogin_CheckAsync_1; }
        finally { checking = false; }
    }

    // A page that finishes loading is the moment to look for the cookie; links stay inside the WebView.
    private sealed class Client(AccessLoginPage page) : WebViewClient
    {
        public override void OnPageFinished(AndroidWebView? view, string? url) { base.OnPageFinished(view, url); Avalonia.Threading.Dispatcher.UIThread.Post(() => _ = page.CheckAsync()); }
    }
}
