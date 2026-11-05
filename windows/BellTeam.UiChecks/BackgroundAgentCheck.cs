using System.Net;
using System.IO;
using System.Net.Http;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using BellTeam.App;
using BellTeam.Core;

internal static class BackgroundAgentCheck
{
    public static async Task RunAsync(string output)
    {
        using var workspace = new Workspace(origin => new BellApi(origin, new Handler()));
        await workspace.ConnectAsync("http://localhost", listen: false);
        if (!workspace.Connected) throw new InvalidOperationException(workspace.ConnectionError);
        var editor = new BackgroundAgentWindow(workspace);
        await editor.InitializeAsync();
        var root = (FrameworkElement)editor.Content;
        if (root is System.Windows.Controls.Panel panel) panel.Background = editor.Background;
        root.Measure(new Size(700, 800)); root.Arrange(new Rect(0, 0, 700, 800)); root.UpdateLayout();
        var bitmap = new RenderTargetBitmap(700, 800, 96, 96, PixelFormats.Pbgra32); bitmap.Render(root);
        var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap));
        using (var file = File.Create(output)) encoder.Save(file);
        editor.Close();
    }

    public static async Task RunListAsync(string output)
    {
        using var workspace = new Workspace(origin => new BellApi(origin, new Handler()));
        await workspace.ConnectAsync("http://localhost", listen: false);
        if (!workspace.Connected || workspace.Entries.Count != 2 || !workspace.Entries.Any(entry => entry.PreviewText.Contains("設定を確認中"))) throw new InvalidOperationException("一覧の要約を読み取れませんでした。");
        var window = new MainWindow(workspace, persistPlacement: false);
        var root = (FrameworkElement)window.Content;
        root.Measure(new Size(1280, 820)); root.Arrange(new Rect(0, 0, 1280, 820)); root.UpdateLayout();
        var bitmap = new RenderTargetBitmap(1280, 820, 96, 96, PixelFormats.Pbgra32); bitmap.Render(root);
        var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap));
        using (var file = File.Create(output)) encoder.Save(file);
        window.Close();
    }

    private sealed class Handler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            var json = request.RequestUri!.AbsolutePath switch
            {
                "/api/session" => "{\"authenticated\":true,\"authMode\":\"local\"}",
                "/api/bots" => "{\"bots\":[{\"id\":\"a\",\"name\":\"ミカ\",\"displayName\":\"ミカ\",\"currentWork\":{\"state\":\"unknown\",\"summary\":\"設定を確認中\",\"summaryStatus\":\"current\",\"summaryUpdatedAt\":\"2026-11-04T23:00:00Z\",\"observedAt\":null,\"source\":\"background_agent\"}}]}",
                "/api/rooms" => "{\"rooms\":[{\"id\":\"r\",\"name\":\"試験室\",\"memberIds\":[\"a\"],\"currentWork\":{\"scope\":\"participants\",\"members\":[{\"botId\":\"a\",\"currentWork\":{\"state\":\"unknown\",\"summary\":\"設定を確認中\",\"summaryStatus\":\"current\",\"summaryUpdatedAt\":\"2026-11-04T23:00:00Z\",\"observedAt\":null,\"source\":\"background_agent\"}}]}}]}", "/api/queue" => "{\"items\":[]}",
                "/api/owner" => "{\"owner\":{\"name\":\"利用者\"}}",
                "/api/settings" => "{\"settings\":[],\"backgroundAgent\":{\"revision\":\"11111111-1111-4111-8111-111111111111\",\"selection\":{\"harness\":\"codex\",\"model\":\"example\",\"reasoningEffort\":\"high\"}}}",
                "/api/models" => "{\"models\":{\"codex\":{\"efforts\":[\"high\"],\"models\":[{\"id\":\"example\",\"efforts\":[\"high\"]}]}}}",
                _ => throw new InvalidOperationException("未対応の模擬URL: " + request.RequestUri)
            };
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json") });
        }
    }
}
