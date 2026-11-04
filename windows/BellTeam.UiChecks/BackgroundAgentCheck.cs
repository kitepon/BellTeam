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

    private sealed class Handler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            var json = request.RequestUri!.AbsolutePath switch
            {
                "/api/session" => "{\"authenticated\":true,\"authMode\":\"local\"}",
                "/api/bots" => "{\"bots\":[]}", "/api/rooms" => "{\"rooms\":[]}", "/api/queue" => "{\"items\":[]}",
                "/api/owner" => "{\"owner\":{\"name\":\"利用者\"}}",
                "/api/settings" => "{\"settings\":[],\"backgroundAgent\":{\"revision\":\"11111111-1111-4111-8111-111111111111\",\"selection\":{\"harness\":\"codex\",\"model\":\"example\",\"reasoningEffort\":\"high\"}}}",
                "/api/models" => "{\"models\":{\"codex\":{\"efforts\":[\"high\"],\"models\":[{\"id\":\"example\",\"efforts\":[\"high\"]}]}}}",
                _ => throw new InvalidOperationException("未対応の模擬URL: " + request.RequestUri)
            };
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json") });
        }
    }
}
