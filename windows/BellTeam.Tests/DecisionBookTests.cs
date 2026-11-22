using System.Text;
using System.Text.Json;
using BellTeam.PeerChannel;

namespace BellTeam.Tests;

// The device history of decisions (contract 8.2 request/amend/cancel/result, 8.4 highest rv per rid), content = approval-box/decision@1.
public class DecisionBookTests
{
    private static (JsonElement Body, byte[] Bytes) Body(string rid, long rv, string title = "デプロイしてよい？", string status = "")
    {
        var json = "{\"rid\":\"" + rid + "\",\"rv\":" + rv + ",\"schema\":\"approval-box/decision@1\",\"content\":{\"decision_id\":\"K-AAA111\",\"title\":\"" + title + "\",\"context\":\"本文\"," +
            "\"options\":[{\"id\":\"yes\",\"label\":\"はい\"},{\"id\":\"no\",\"label\":\"いいえ\"}],\"recommendation\":\"yes\",\"urgency\":\"high\"," +
            "\"source\":{\"client\":\"claude-code\",\"session_label\":\"アニス / a498\",\"work_label\":\"a498\",\"requester\":\"アニス\",\"requester_bot_id\":\"bot-0d7da1c1\"},\"created_at\":\"2026-11-22T09:00:00Z\",\"version\":" + rv + "}}";
        return (JsonDocument.Parse(json).RootElement, Encoding.UTF8.GetBytes(json));
    }
    private static JsonElement Json(string json) => JsonDocument.Parse(json).RootElement;

    [Fact]
    public void ARequestIsKeptAsPendingWithItsContentAndExactBodyBytes()
    {
        var book = new DecisionBook(); var (body, bytes) = Body("r1", 1);
        Assert.Equal("ok", book.Apply("request", body, bytes, 10));
        var e = book.Find("r1")!;
        Assert.Equal((DecisionStatus.Pending, "K-AAA111", "デプロイしてよい？", "yes", "bot-0d7da1c1"), (e.Status, e.DecisionId, e.Title, e.Recommendation, e.Source.RequesterBotId));
        Assert.Equal(["yes", "no"], e.Options.Select(o => o.Id));
        Assert.Equal(bytes, e.Body);
    }

    [Fact]
    public void AnAmendOfAHigherVersionReplacesTheContentAndKeepsHeldAndALowerOrRepeatedVersionIsIgnored()
    {
        var book = new DecisionBook(); var (b1, y1) = Body("r1", 1); book.Apply("request", b1, y1, 10); book.SetHeld("r1", true, 11);
        var (b2, y2) = Body("r1", 2, "直した題");
        Assert.Equal("ok", book.Apply("amend", b2, y2, 12));
        var e = book.Find("r1")!;
        Assert.Equal((2L, "直した題", DecisionStatus.Held, true), (e.Rv, e.Title, e.Status, e.Amended));
        Assert.Equal("ok", book.Apply("request", b1, y1, 13)); Assert.Equal(2, book.Find("r1")!.Rv);
        Assert.Equal("ok", book.Apply("amend", b2, y2, 14)); Assert.Equal(12, book.Find("r1")!.UpdatedAt);
    }

    [Fact]
    public void AnAmendForARequestThisDeviceMissedIsKeptAsNewAndAFrameWithoutContentIsRefused()
    {
        var book = new DecisionBook(); var (b, y) = Body("r9", 3);
        Assert.Equal("ok", book.Apply("amend", b, y, 1)); Assert.Equal(3, book.Find("r9")!.Rv);
        Assert.Equal("refused:invalid", book.Apply("request", Json("{\"rid\":\"r2\",\"rv\":1,\"schema\":\"approval-box/decision@1\",\"content\":{\"title\":\"x\"}}"), [], 1));
        Assert.Equal("refused:invalid", book.Apply("request", Json("{\"rid\":\"r2\",\"rv\":1,\"schema\":\"other@1\",\"content\":{}}"), [], 1));
        Assert.Null(book.Find("r2"));
    }

    [Fact]
    public void CancelAndResultCloseAnOpenRequestOnceAndACancelOfAnUnknownRequestIsAcknowledged()
    {
        var book = new DecisionBook(); var (b, y) = Body("r1", 1); book.Apply("request", b, y, 1);
        Assert.Equal("ok", book.Apply("cancel", Json("{\"rid\":\"r1\",\"rv\":1,\"reason\":\"取り下げ\"}"), [], 2));
        Assert.Equal((DecisionStatus.Cancelled, "取り下げ"), (book.Find("r1")!.Status, book.Find("r1")!.CancelReason));
        book.Close("r1", "answered", Json("{\"option_id\":\"no\"}"), "dev", 3);
        Assert.Equal(DecisionStatus.Cancelled, book.Find("r1")!.Status);
        Assert.Equal("ok", book.Apply("cancel", Json("{\"rid\":\"nope\",\"rv\":1}"), [], 4)); Assert.Null(book.Find("nope"));

        var (b2, y2) = Body("r2", 1); book.Apply("request", b2, y2, 5);
        book.Close("r2", "answered", Json("{\"option_id\":\"yes\",\"text\":\"理由\"}"), "key1", 6);
        var a = book.Find("r2")!;
        Assert.Equal((DecisionStatus.Answered, "yes", "理由", "key1"), (a.Status, a.Answer!.OptionId, a.Answer.Text, a.Answer.DecidedBy));
        var (b3, y3) = Body("r3", 1); book.Apply("request", b3, y3, 7); book.Close("r3", "expired", null, "", 8);
        Assert.Equal((DecisionStatus.Expired, "expired"), (book.Find("r3")!.Status, book.Find("r3")!.CancelReason));
    }

    [Fact]
    public void HoldTogglesOnlyAnOpenRequest()
    {
        var book = new DecisionBook(); var (b, y) = Body("r1", 1); book.Apply("request", b, y, 1);
        book.SetHeld("r1", true, 2); Assert.Equal(DecisionStatus.Held, book.Find("r1")!.Status);
        book.SetHeld("r1", false, 3); Assert.Equal(DecisionStatus.Pending, book.Find("r1")!.Status);
        book.Close("r1", "answered", Json("{\"option_id\":\"yes\"}"), "k", 4); book.SetHeld("r1", true, 5);
        Assert.Equal(DecisionStatus.Answered, book.Find("r1")!.Status);
    }

    [Fact]
    public void TheHistorySurvivesExportAndImportAndAnUnreadableFileIsNoHistory()
    {
        var book = new DecisionBook(); var (b, y) = Body("r1", 1); book.Apply("request", b, y, 1); book.Close("r1", "answered", Json("{\"option_id\":\"yes\"}"), "k", 2);
        var back = DecisionBook.Import(book.Export()); var e = back.Find("r1")!;
        Assert.Equal((DecisionStatus.Answered, "yes"), (e.Status, e.Answer!.OptionId)); Assert.Equal(y, e.Body);
        Assert.Empty(DecisionBook.Import("not json").All);
    }
}
