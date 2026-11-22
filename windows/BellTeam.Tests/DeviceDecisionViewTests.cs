using BellTeam.App;
using BellTeam.Core;
using BellTeam.PeerChannel;

namespace BellTeam.Tests;

public class DeviceDecisionViewTests
{
    private static DecisionEntry Entry(DecisionStatus status = DecisionStatus.Pending, DecisionAnswer? answer = null, string? bot = "bot-0d7da1c1", string client = "claude-code") => new(
        "r1", 2, "K-AAA111", "デプロイしてよい？", "本文", [new("yes", "はい"), new("no", "いいえ")], "yes", "high", "2026-11-23T00:00:00Z",
        new(client, "アニス / a498", "a498", bot is null ? null : "アニス", bot, false), "2026-11-22T09:00:00Z", 5, [], status, answer, null, 1_000_000, true);

    [Fact]
    public void ABellTeamMemberRequestKeepsItsRecommendationRequesterAndAmendment()
    {
        var v = DeviceDecisionView.Of(Entry());
        Assert.Equal(("K-AAA111", "pending", "high", 5L), (v.Id, v.Status, v.Urgency, v.Version));
        Assert.Equal([true, false], v.Options!.Select(o => o.Recommended));
        Assert.Equal(("bellteam", "Claude Code", "bot-0d7da1c1", "アニス"), (v.Origin!.Kind, v.Origin.Tool, v.Requester!.BotId, v.Requester.Name));
        Assert.True(v.Amended!.Is); Assert.Null(v.Delivery);
        var origin = Approvals.OriginOf(v); Assert.Equal("アニス", origin.Name);
    }

    [Fact]
    public void AnExternalRequestHasNoRequesterAndAnAnsweredOneWaitsForTheAiToTakeIt()
    {
        var v = DeviceDecisionView.Of(Entry(DecisionStatus.Answered, new("no", "理由", "key1"), bot: null, client: "chatgpt"));
        Assert.Equal(("external", "ChatGPT", "answered", "waiting"), (v.Origin!.Kind, v.Origin.Tool, v.Status, v.Delivery));
        Assert.Null(v.Requester); Assert.Equal(("no", "理由"), (v.Answer!.OptionId, v.Answer.Text));
    }

    [Fact]
    public void ExpiredAndCancelledBothShowAsCancelledWithTheirReason()
    {
        var v = DeviceDecisionView.Of(Entry(DecisionStatus.Expired) with { CancelReason = "expired" });
        Assert.Equal(("cancelled", "expired", null), (v.Status, v.CancelReason, v.Delivery));
    }
}
