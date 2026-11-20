using System.Net;
using System.Text;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Threading;
using Avalonia.VisualTree;
using BellTeam.Core;

namespace BellTeam.Linux;

// A machine seat's screen shows the text without the key bar; the approval banner stays driven by the approval read.
public sealed class ScreenMachineTests
{
    private sealed class Server(string screen, bool pending) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var body = request.RequestUri!.AbsolutePath switch
            {
                "/api/session" => """{"authenticated":true,"authMode":"local"}""",
                "/api/setup" => """{"phase":"ready","harnesses":[],"complete":true}""",
                "/api/bots" => """{"bots":[{"id":"b1","name":"ベル","displayName":"ベル","online":true}]}""",
                "/api/rooms" => """{"rooms":[]}""",
                "/api/queue" => """{"items":[]}""",
                "/api/owner" => """{"owner":{"name":"利用者"}}""",
                "/api/bots/b1/screen" => screen,
                "/api/bots/b1/screen/approval" => pending ? """{"status":"approval_required","promptDigest":"d1","choices":[{"decision":"approve_once","label":"許可"},{"decision":"deny","label":"拒否"}]}""" : """{"status":"none"}""",
                _ => null
            };
            return Task.FromResult(body is null ? new HttpResponseMessage(HttpStatusCode.NotFound) : new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
        }
    }

    private static async Task<string?[]> ButtonsAsync(string screen, bool pending)
    {
        using var workspace = new LinuxWorkspace(origin => new BellApi(origin, new Server(screen, pending)));
        await workspace.ConnectAsync("http://localhost:1/", listen: false);
        await workspace.SelectAsync(workspace.Entries.Single(item => !item.Target.IsRoom));
        var view = new ScreenView(workspace);
        var run = workspace.OpenScreenAsync();
        await workspace.ScreenFirstRead.WaitAsync(TimeSpan.FromSeconds(5));
        Dispatcher.UIThread.RunJobs();
        var names = view.GetVisualDescendants().OfType<Button>().Select(button => AutomationProperties.GetName(button)).ToArray();
        workspace.ReturnToProfile(); await run;
        return names;
    }

    [Fact]
    public Task AMachineSeatShowsNoKeyBar() => Ui.Run(async () =>
    {
        var names = await ButtonsAsync("""{"online":true,"screen":"hi","machine":true}""", pending: false);
        Assert.DoesNotContain("取消", names); Assert.DoesNotContain("決定", names); Assert.DoesNotContain("許可", names);
    });

    [Fact]
    public Task AMachineSeatShowsTheApprovalButtonsOnlyWhileARequestIsPending() => Ui.Run(async () =>
    {
        var names = await ButtonsAsync("""{"online":true,"screen":"hi","machine":true}""", pending: true);
        Assert.Contains("許可", names); Assert.Contains("拒否", names); Assert.DoesNotContain("取消", names); Assert.DoesNotContain("決定", names);
    });

    [Fact]
    public Task ATerminalSeatAndAnAnswerWithoutTheFieldKeepTheKeyBar() => Ui.Run(async () =>
    {
        var names = await ButtonsAsync("""{"online":true,"screen":"hi"}""", pending: false);
        Assert.Contains("取消", names); Assert.Contains("決定", names);
    });
}
