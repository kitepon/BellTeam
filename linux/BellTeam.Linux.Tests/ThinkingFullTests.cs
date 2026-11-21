using System.Text.Json;
using Avalonia.Controls;
using Avalonia.Threading;
using Avalonia.VisualTree;
using BellTeam.Core;

namespace BellTeam.Linux;

// a471-thinking-full-linux: a shown thinking row draws its whole text (machine-stream.md "Thinking is always shown whole"): no line limit, ellipsis or height cap on a long one.
public sealed class ThinkingFullTests
{
    private sealed class NoServer : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.NotFound));
    }

    [Fact]
    public Task ALongThinkingRowIsDrawnWholeWithoutALineLimitOrEllipsis() => Ui.Run(async () =>
    {
        var lines = Enumerable.Range(1, 40).Select(n => $"{n}行目: thinking summary sentence number {n} that goes on for a while.").ToArray();
        var text = string.Join("\\n", lines);   // about 2 000 characters, 40 lines
        var json = "{\"id\":\"me-9-0\",\"kind\":\"machine_event\",\"direction\":\"incoming\",\"at\":\"2026-11-21T06:35:00Z\",\"message\":\"thinking: 1行目\",\"sender\":{\"id\":\"b1\",\"name\":\"ベル\"},\"machine_event\":{\"seq\":9,\"part\":0,\"view\":\"thinking\",\"display\":\"show\",\"title\":\"thinking\",\"text\":\"" + text + "\"}}";
        var model = new LinuxWorkspace(origin => new BellApi(origin, new NoServer()));
        using (model)
        {
            var card = new MessageCard(new MessageItem(JsonSerializer.Deserialize<TimelineMessage>(json, BellApi.Json)!), model);
            var host = new Window { Content = card, Width = 900, Height = 600 }; host.Show();
            Dispatcher.UIThread.RunJobs();
            var blocks = card.GetVisualDescendants().OfType<TextBlock>().ToList();
            var drawn = string.Join("\n", blocks.Select(block => block.Inlines is { Count: > 0 } ? block.Inlines.Text : block.Text));
            foreach (var line in lines) Assert.Contains(line, drawn);
            Assert.All(blocks.Where(block => (block.Inlines is { Count: > 0 } ? block.Inlines.Text : block.Text)?.Contains(lines[0]) == true), block => { Assert.Equal(0, block.MaxLines); Assert.Equal(Avalonia.Media.TextTrimming.None, block.TextTrimming); });   // the body blocks only: name and origin labels may trim
            card.Measure(new Avalonia.Size(900, double.PositiveInfinity));   // unbounded: the window's own height must not be what is measured
            Assert.True(card.DesiredSize.Height > 40 * 15, "the row grows with its text instead of being cut: " + card.DesiredSize.Height);
            host.Close();
        }
    });
    // a471-thinking-bubble-linux: the thinking row is the answer's bubble with lighter slanted text and has copy only (no reply, no forward).
    [Fact]
    public Task AThinkingRowIsASlantedLightBubbleWithCopyOnly() => Ui.Run(async () =>
    {
        var json = "{\"id\":\"me-9-0\",\"kind\":\"machine_event\",\"direction\":\"incoming\",\"at\":\"2026-11-21T06:35:00Z\",\"message\":\"thinking: one\",\"sender\":{\"id\":\"b1\",\"name\":\"ベル\"},\"machine_event\":{\"seq\":9,\"part\":0,\"view\":\"thinking\",\"display\":\"show\",\"title\":\"thinking\",\"text\":\"one\\ntwo\"}}";
        var model = new LinuxWorkspace(origin => new BellApi(origin, new NoServer()));
        using (model)
        {
            var card = new MessageCard(new MessageItem(JsonSerializer.Deserialize<TimelineMessage>(json, BellApi.Json)!), model);
            var host = new Window { Content = card, Width = 900, Height = 600 }; host.Show();
            Dispatcher.UIThread.RunJobs();
            var markdown = card.GetVisualDescendants().OfType<MarkdownView>().First();
            Assert.Equal(Avalonia.Media.FontStyle.Italic, markdown.FontStyle);
            Assert.Equal(BellTheme.Muted, markdown.Foreground);
            bool Shown(string name) => card.GetVisualDescendants().OfType<Button>().First(button => Avalonia.Automation.AutomationProperties.GetName(button) == name).IsVisible;
            Assert.True(Shown("このメッセージをコピー"));
            Assert.False(Shown("このメッセージに返信")); Assert.False(Shown("このメッセージを転送"));
            host.Close();
        }
    });
}
