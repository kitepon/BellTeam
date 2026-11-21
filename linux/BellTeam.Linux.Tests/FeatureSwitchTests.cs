using System.Net;
using System.Text;
using Avalonia.Controls;
using Avalonia.VisualTree;
using BellTeam.Core;

namespace BellTeam.Linux;

// a479-switch-linux: a feature with no fields (thinkingDisplay, 「AIの考えの表示」) draws as one plain on/off switch and saves only enabled.
public sealed class FeatureSwitchTests
{
    private sealed class Server : HttpMessageHandler
    {
        public string? Patch;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.PathAndQuery;
            if (request.Method == HttpMethod.Patch) Patch = path + " " + await request.Content!.ReadAsStringAsync(cancellationToken);
            var setting = """{"id":"thinkingDisplay","title":"AIの考えの表示","enabled":""" + (Patch is null ? "false" : "true") + ""","status":""" + (Patch is null ? "\"disabled\"" : "\"enabled\"") + ""","fields":[]}""";
            var body = path switch
            {
                "/api/settings" => """{"settings":[""" + setting + "]}",
                "/api/settings/thinkingDisplay" => """{"setting":""" + setting + "}",
                _ => null
            };
            return body is null ? new HttpResponseMessage(HttpStatusCode.NotFound) : new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        }
    }

    [Fact]
    public Task AFeatureWithNoFieldsIsOnePlainSwitchThatPatchesOnlyEnabled() => Ui.Run(async () =>
    {
        var server = new Server();
        var workspace = new LinuxWorkspace(origin => new BellApi(origin, server));
        await workspace.ConnectAsync("http://localhost:1/", listen: false);
        var editor = new FeatureEditor(workspace, "thinkingDisplay", "AIの考えの表示");
        var page = editor.AsPage(() => { }, keepActions: true);
        await editor.InitializeAsync();
        var window = new Window { Content = page }; window.Show();
        var texts = page.GetVisualDescendants().OfType<TextBlock>().Select(text => text.Text).ToArray();
        Assert.DoesNotContain(texts, text => text?.Contains("必要な項目") == true);
        Assert.DoesNotContain(texts, text => text == "設定");
        Assert.Empty(page.GetVisualDescendants().OfType<TextBox>());
        var toggle = Assert.Single(page.GetVisualDescendants().OfType<CheckBox>());
        Assert.Equal("有効にする", toggle.Content); Assert.False(toggle.IsChecked);
        toggle.IsChecked = true;
        var save = page.GetVisualDescendants().OfType<Button>().Single(button => button.Content as string == "保存");
        save.RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Button.ClickEvent));
        for (var round = 0; round < 100 && server.Patch is null; round++) { Avalonia.Threading.Dispatcher.UIThread.RunJobs(); await Task.Delay(20); }
        Assert.Equal("/api/settings/thinkingDisplay {\"values\":{},\"enabled\":true}", server.Patch);
        window.Close(); workspace.Dispose();
    });
}
