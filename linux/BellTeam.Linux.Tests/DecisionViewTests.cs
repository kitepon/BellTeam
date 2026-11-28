using Kitepon.ApprovalBox.Client;

namespace BellTeam.Linux;

// The component's Decision -> the screen's ViewDecision: the fields the screen draws, and the origin rule (BellTeam's own, applied against the member list).
public sealed class DecisionViewTests
{
    private static Decision Make(string status, DecisionSource source, IReadOnlyList<DecisionHistoryItem>? history = null) => new("D-1", "題", "背景", [new("a", "進める"), new("b", "見送る")], "b", "high", null, status, 4, "2026-11-24T00:00:00Z", "2026-11-24T00:01:00Z",
        source, history ?? [], null, [new("x1", "写真.png", "image/png", 12, "ab")], null, null, null, null);

    [Fact]
    public void TheFieldsTheScreenDrawsAreMappedAndTheRecommendedOptionIsMarked()
    {
        var view = DecisionView.Of(Make("pending", new(null, null, null, null, null, null, null)), []);
        Assert.Equal(("D-1", "pending", 4L, "high"), (view.Id, view.Status, view.Version, view.Urgency));
        Assert.Equal([false, true], view.Options!.Select(o => o.Recommended));
        Assert.Equal("x1", view.RequestAttachments![0].Id);
        Assert.Equal("unknown", view.Origin!.Kind);
    }

    [Fact]
    public void TheRequesterIsTheRosterMemberByBotIdAndAnUnknownOneIsExternal()
    {
        IReadOnlyList<(string Id, string Name)> roster = [("bot-molly", "モリー")];
        var member = DecisionView.Of(Make("pending", new("claude-code", "s", null, null, "別名", "bot-molly", null)), roster);
        Assert.Equal(("bellteam", "botId", "モリー"), (member.Origin!.Kind, member.Origin.Basis, member.Requester!.Name));
        var outsider = DecisionView.Of(Make("pending", new("claude-code", "s", null, null, "誰か", "bot-x", null)), roster);
        Assert.Equal("external", outsider.Origin!.Kind); Assert.Null(outsider.Requester);
    }

    [Fact]
    public void ALastAmendedHistoryItemMakesTheDecisionAmended()
    {
        var view = DecisionView.Of(Make("pending", new(null, null, null, null, null, null, null), [new("t", "amended", "ai", "直した", ["title"])]), []);
        Assert.True(view.Amended!.Is); Assert.Equal("title", Assert.Single(view.Amended.Fields!));
    }
}
