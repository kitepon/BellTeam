using System.Net;
using System.Text;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Threading;
using Avalonia.VisualTree;
using BellTeam.Core;
using Xunit.Abstractions;

namespace BellTeam.Linux;

// a471-scroll-jump-linux: a row that arrives while the reader is at the bottom is followed by an animated scroll (at most 33 px a frame), instant with motion off, and stopped by the reader's key.
public sealed class ScrollFollowTests(ITestOutputHelper output)
{
    private sealed class Server : HttpMessageHandler
    {
        private static string Rows(int count) => string.Join(",", Enumerable.Range(0, count).Select(index =>
            "{\"id\":\"r" + index + "\",\"kind\":\"message\",\"direction\":\"incoming\",\"at\":\"" + new DateTimeOffset(2026, 11, 21, 0, 0, 0, TimeSpan.Zero).AddMinutes(index).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'") +
            "\",\"message\":\"r" + index + " " + string.Concat(Enumerable.Repeat("あいうえお", 1 + index * 7 % 11)) + "\",\"sender\":{\"id\":\"b1\",\"name\":\"ベル\"}}"));
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var body = request.RequestUri!.PathAndQuery switch
            {
                "/api/session" => """{"authenticated":true,"authMode":"local"}""",
                "/api/setup" => """{"phase":"ready","harnesses":[],"complete":true}""",
                "/api/bots?avatar=omit" => """{"bots":[{"id":"b1","name":"ベル","displayName":"ベル","online":true}]}""",
                "/api/rooms?avatar=omit" => """{"rooms":[]}""",
                "/api/queue" => """{"items":[]}""",
                "/api/owner?avatar=omit" => """{"owner":{"name":"利用者"}}""",
                var p when p.Contains("/messages?limit=100") => "{\"items\":[" + Rows(100) + "],\"has_more\":false}",
                _ => null
            };
            return Task.FromResult(body is null ? new HttpResponseMessage(HttpStatusCode.NotFound) : new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
        }
    }

    private static async Task Settle(int rounds) { for (var round = 0; round < rounds; round++) { Dispatcher.UIThread.RunJobs(); await Task.Delay(20); } }
    private static ScrollViewer ScrollOf(Window window) => window.GetVisualDescendants().OfType<ScrollViewer>().First(candidate => AutomationProperties.GetName(candidate) == "会話");
    private static double DistanceToEnd(ScrollViewer scroll) => scroll.Extent.Height - scroll.Viewport.Height - scroll.Offset.Y;

    private async Task<(LinuxWorkspace Model, MainWindow Window, ScrollViewer Scroll)> OpenAtBottomAsync()
    {
        var model = new LinuxWorkspace(origin => new BellApi(origin, new Server()));
        var window = new MainWindow(model, persistPlacement: false) { AutoRetry = false }; window.Show();
        await model.ConnectAsync("http://localhost:1/", listen: false);
        await model.SelectAsync(model.Entries.Single());
        await Settle(60);
        var scroll = ScrollOf(window); BottomFollower.SnapToEnd(scroll); await Settle(10);
        Assert.True(DistanceToEnd(scroll) < 2, "the conversation opens at the bottom");
        return (model, window, scroll);
    }

    private static void AddRows(LinuxWorkspace model)
    {
        var last = model.Messages[^1].Message;
        for (var index = 0; index < 3; index++) model.Messages.Add(new MessageItem(last with { Id = "new" + index, At = last.At.AddMinutes(1 + index), Message = string.Concat(Enumerable.Repeat("新着の長い行です。", 30)) }));
    }

    [Fact]
    public Task NewRowsAtTheBottomAreFollowedFrameByFrameNotSnapped() => Ui.Run(async () =>
    {
        var (model, window, scroll) = await OpenAtBottomAsync();
        using (model)
        {
            BottomFollower.MotionOn = () => true;
            var offsets = new List<double> { scroll.Offset.Y };
            AddRows(model);
                        for (var frame = 0; frame < 150; frame++) { Dispatcher.UIThread.RunJobs(); await Task.Delay(8); if (offsets[^1] != scroll.Offset.Y) offsets.Add(scroll.Offset.Y); if (DistanceToEnd(scroll) < 1) break; }
            var steps = offsets.Zip(offsets.Skip(1), (a, b) => b - a).ToArray();
            output.WriteLine($"steps {steps.Length}, largest {steps.DefaultIfEmpty().Max():F1} px, to end {DistanceToEnd(scroll):F1}");
            Assert.True(DistanceToEnd(scroll) < 1, "the view followed to the end");
            Assert.True(steps.Length >= 3, "it moved in several steps, not one snap");
            Assert.True(steps.Max() <= BottomFollower.Step + 1, $"a step was {steps.Max():F1} px");
        }
        window.Close();
    });

    [Fact]
    public Task WithMotionOffTheViewFollowsAtOnce() => Ui.Run(async () =>
    {
        var (model, window, scroll) = await OpenAtBottomAsync();
        using (model)
        {
            BottomFollower.MotionOn = () => false;
            AddRows(model);
            await Settle(5);
            BottomFollower.MotionOn = () => true;
            Assert.True(DistanceToEnd(scroll) < 1, "motion off: the view is at the end at once");
        }
        window.Close();
    });

    [Fact]
    public Task TheReadersKeyStopsTheFollowing() => Ui.Run(async () =>
    {
        var (model, window, scroll) = await OpenAtBottomAsync();
        using (model)
        {
            BottomFollower.MotionOn = () => true;
            AddRows(model);
            for (var frame = 0; frame < 6; frame++) { Dispatcher.UIThread.RunJobs(); await Task.Delay(20); }
            Assert.True(DistanceToEnd(scroll) > 100, "still following");
            scroll.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Key = Key.Up });
            var stopped = scroll.Offset.Y; await Settle(15);
            Assert.True(Math.Abs(scroll.Offset.Y - stopped) < 1, "the following stopped where the reader's key found it");
        }
        window.Close();
    });
}
