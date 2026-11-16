using System.Net.Http;
using System.Text.Json;
using BellTeam.Core;

namespace BellTeam.Tests;

// conversation reply.md: the Core half of replying to a chosen message.
public sealed class ReplyTests
{
    private static TimelineMessage Row(string json) => JsonSerializer.Deserialize<TimelineMessage>(json, BellApi.Json)!;
    private static TimelineMessage Plain(string id, string text, string? kind = "message") => new() { Id = id, At = DateTimeOffset.Parse("2026-11-16T12:00:00Z"), Kind = kind, Message = text };

    [Fact]
    public void ReplyToReadsTheSnapshotAndAMalformedValueIsNotAReply()
    {
        var row = Row("""{"id":"r1","at":"2026-11-16T12:00:00Z","kind":"message","direction":"outgoing","message":"違う","reply_to":{"id":"m1","available":true,"sender":{"id":"bot-a","name":"ベル"},"at":"2026-11-16T11:00:00Z","text":"元","truncated":true,"image":true}}""");
        Assert.Equal(new ReplyReference("m1", true, "ベル", "元", true, true), row.ReplyTo);
        Assert.Equal("元…", Timeline.QuoteBody(row.ReplyTo!));
        var gone = Row("""{"id":"r2","at":"2026-11-16T12:00:00Z","reply_to":{"id":"m9","available":false}}""").ReplyTo!;
        Assert.Equal((false, Timeline.UnavailableQuote), (gone.Available, Timeline.QuoteBody(gone)));
        Assert.Equal("（画像）", Timeline.QuoteBody(new ReplyReference("m2", true, "x", "", false, true)));
        foreach (var bad in new[] { "\"x\"", "5", "[]", "{}", "{\"id\":\"\"}", "{\"id\":3}" }) Assert.Null(Row($$"""{"id":"r3","at":"2026-11-16T12:00:00Z","reply_to":{{bad}}}""").ReplyTo);
        Assert.Null(Row("""{"id":"r4","at":"2026-11-16T12:00:00Z"}""").ReplyTo);
    }

    [Fact]
    public void ALocalQuoteCutsAt300CodePointsAndOnlyConversationRowsAreQuotable()
    {
        var wide = Plain("m1", string.Concat(Enumerable.Repeat("😀", 301)));
        var quote = ReplyReference.Local(wide, "ベル");
        Assert.Equal((300, true), (quote.Text.EnumerateRunes().Count(), quote.Truncated));
        Assert.False(ReplyReference.Local(Plain("m2", "a\r\nb"), "x").Truncated);
        Assert.Equal("a\nb", ReplyReference.Local(Plain("m2", "a\r\nb"), "x").Text);
        Assert.All(new[] { "message", "interim", "schedule" }, kind => Assert.True(Timeline.IsQuotable(Plain("m", "t", kind))));
        Assert.False(Timeline.IsQuotable(Plain("m", "t", "peer")));
        Assert.False(Timeline.IsQuotable(Plain(PendingSend.NewId(), "t")));
    }

    [Fact]
    public void ThePickedQuoteTravelsWithTheSendAndComesBackWhenTheSendFails()
    {
        var draft = new ConversationDraft { Text = "返事" };
        var quote = new ReplyReference("m1", true, "ベル", "元");
        draft.Quote = quote;
        var sent = draft.BeginSendContent();
        Assert.Equal((quote, null), (sent.Quote, draft.Quote));
        Assert.Equal(quote, new PendingSend("local-pending-1", "返事", 0, DateTimeOffset.Now, ReplyTo: sent.Quote).ToMessage().ReplyTo);
        draft.FailSend(sent, "失敗");
        Assert.Equal(quote, draft.Quote);
        var other = new ReplyReference("m2", true, "x", "別");
        draft.Quote = other; draft.FailSend(sent, "失敗");
        Assert.Equal(other, draft.Quote);
    }

    [Theory]
    [InlineData("m1", true)]
    [InlineData(null, false)]
    public async Task ReplyToIsInTheBodyOnlyWhenSet(string? replyTo, bool expected)
    {
        string? body = null;
        var api = new BellApi(new Uri("http://localhost"), new StubHandler(async (request, _) => { body = await request.Content!.ReadAsStringAsync(); return StubHandler.Json("""{"delivery_id":"d1"}"""); }));
        await api.SendAsync(new ChatTarget("bot-one", false), "返事", [], null, default, replyTo);
        using var json = JsonDocument.Parse(body!);
        Assert.Equal(expected, json.RootElement.TryGetProperty("reply_to", out var value) && value.GetString() == replyTo);
        Assert.Equal(expected, json.RootElement.TryGetProperty("reply_to", out _));
    }

    [Fact]
    public void APartReplyReadsItsRangeAndAnUnavailablePartKeepsTheExcerptUnderTheFixedLine()
    {
        var part = Row("""{"id":"r1","at":"2026-11-16T12:00:00Z","reply_to":{"id":"m1","available":true,"sender":{"id":"u","name":"あなた"},"text":"選んだ部分","part":true,"range":{"start":12,"end":17}}}""").ReplyTo!;
        Assert.Equal(new ReplyReference("m1", true, "あなた", "選んだ部分", false, false, true, 12, 17), part);
        Assert.Null(Timeline.QuoteNote(part));
        Assert.Null(Row("""{"id":"r1","at":"2026-11-16T12:00:00Z","reply_to":{"id":"m1","available":true,"text":"x","part":true,"range":{"start":5,"end":2}}}""").ReplyTo!.RangeStart);
        var gone = Row("""{"id":"r2","at":"2026-11-16T12:00:00Z","reply_to":{"id":"m9","available":false,"part":true,"text":"残った抜粋","truncated":true}}""").ReplyTo!;
        Assert.Equal(("残った抜粋…", Timeline.UnavailableQuote), (Timeline.QuoteBody(gone), Timeline.QuoteNote(gone)));
        Assert.False(gone.Available);
    }

    [Fact]
    public void ASelectionBecomesTheLocalQuoteAndTravelsWithTheSend()
    {
        var local = ReplyReference.Local(Plain("m1", "前置き。ここだけ。後ろ。"), "ベル", new QuoteSelection("ここだけ。"));
        Assert.Equal(("ここだけ。", true, false), (local.Text, local.Part, local.Image));
        var draft = new ConversationDraft { Text = "賛成" };
        var selection = new QuoteSelection("ここだけ。");
        draft.Quote = local; draft.Selection = selection;
        var sent = draft.BeginSendContent();
        Assert.Equal((selection, null), (sent.Selection, draft.Selection));
        draft.FailSend(sent, "失敗");
        Assert.Equal((local, selection), (draft.Quote, draft.Selection));
    }

    [Theory]
    [InlineData("m1", true, true)]
    [InlineData(null, true, false)]
    [InlineData("m1", false, false)]
    public async Task ReplyQuoteIsSentOnlyWithReplyToAndASelection(string? replyTo, bool withSelection, bool expected)
    {
        string? body = null;
        var api = new BellApi(new Uri("http://localhost"), new StubHandler(async (request, _) => { body = await request.Content!.ReadAsStringAsync(); return StubHandler.Json("""{"delivery_id":"d1"}"""); }));
        await api.SendAsync(new ChatTarget("bot-one", false), "賛成", [], null, default, replyTo, withSelection ? new QuoteSelection("a\r\nb") : null);
        using var json = JsonDocument.Parse(body!);
        Assert.Equal(expected, json.RootElement.TryGetProperty("reply_quote", out var quote));
        if (expected) { Assert.Equal("a\nb", quote.GetProperty("text").GetString()); Assert.False(quote.TryGetProperty("start", out _)); }
    }
}
