using System.Text.Json;
using BellTeam.Core;

namespace BellTeam.Linux;

// a471-reply-forward-linux: a machine seat's bubble row gets reply, quote, forward and copy by its own id and its whole text (machine-stream.md "Reply, forward, quote and copy of a bubble").
public sealed class BubbleActionsTests
{
    private static TimelineMessage Row(string view, bool bubble, string id = "me-7-0", string text = "一行目\\n二行目") => JsonSerializer.Deserialize<TimelineMessage>(
        "{\"id\":\"" + id + "\",\"kind\":\"machine_event\",\"direction\":\"incoming\",\"at\":\"2026-11-21T06:35:00Z\",\"message\":\"一行目\",\"sender\":{\"id\":\"b1\",\"name\":\"ベル\"},\"machine_event\":{\"seq\":7,\"part\":0,\"view\":\"" + view + "\",\"display\":\"show\",\"text\":\"" + text + "\"" + (bubble ? ",\"bubble\":true" : "") + "}}", BellApi.Json)!;

    [Fact]
    public void OnlyABubbleRowOfTheSeatHasTheActionsAndCarriesItsWholeText()
    {
        var bubble = Row("words", true);
        Assert.True(Timeline.IsQuotable(bubble)); Assert.True(Timeline.IsForwardable(bubble));
        Assert.Equal("一行目\n二行目", bubble.QuoteText);
        var quote = ReplyReference.Local(bubble, "ベル");
        Assert.Equal(("me-7-0", "一行目\n二行目", false), (quote.Id, quote.Text, quote.Part));
        Assert.Equal("二行目", ReplyReference.Local(bubble, "ベル", new QuoteSelection("二行目")).Text);
        foreach (var plain in new[] { Row("words", false), Row("thinking", false), Row("tool_use", false) })
        { Assert.False(Timeline.IsQuotable(plain)); Assert.False(Timeline.IsForwardable(plain)); }
        Assert.False(Timeline.IsQuotable(Row("words", true, PendingSend.NewId()))); // a local echo is never quoted
    }
}
