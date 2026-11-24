using BellTeam.Core;
using Xunit;

namespace BellTeam.Linux;

// abx-answer-banner-desktop (Delta's contract, screen-spec Answer outcomes + Link line): the answer line follows the delivery the server reports, never a default; a 404 of the link lookup is not 「つなげています」.
public sealed class ApprovalNotLinkedTests
{
    private static readonly ViewDecision Member = new() { Id = "d1", Status = "answered", Origin = new ApprovalOrigin { Kind = "bellteam" }, Requester = new ApprovalRequester { BotId = "bot-1", Name = "ラピ" } };

    [Fact]
    public void ALookupNotAnsweredYetKeepsConnectingAndA404SaysNoTaskFits()
    {
        Assert.Equal("工程表につなげています", Approvals.LinkNote(Member).Text);
        Assert.Equal("connecting", Approvals.LinkPanel(Member).Kind);
        var notLinked = Member with { NotLinked = true };
        Assert.Equal("この決裁に合う工程は、工程表に見つかっていません", Approvals.LinkNote(notLinked).Text);
        Assert.Equal(("unlinked", "この決裁に合う工程は、工程表に見つかっていません"), (Approvals.LinkPanel(notLinked).Kind, Approvals.LinkPanel(notLinked).Title));
    }

    [Fact]
    public void JoinMarksADecisionTheLookupAnswered404ForAndNoOtherOne()
    {
        var links = new ApprovalLinks();
        Assert.False(links.Join(Member).NotLinked);
        Assert.False(links.AnyNotLinked);
    }

    [Theory]
    [InlineData(null, "pen", false)]
    [InlineData("pending", "pen", false)]
    [InlineData("delivered", "ok", false)]
    [InlineData("fetched", "ok", false)]
    [InlineData("waiting", "vio", false)]
    [InlineData("unknown", "amb", true)]
    public void TheAnswerLineIsTheReportedDeliveryAndOnlyUnknownAsksForThePaste(string? delivery, string tone, bool copy)
    {
        var note = Approvals.DeliveryNote(Member with { Delivery = delivery });
        Assert.Equal((tone, copy), (note.Tone, note.Copy));
        Assert.Equal(delivery is null or "pending", note.Text.Contains("届きを確かめています"));
        Assert.Equal(delivery is "delivered" or "fetched", Approvals.DeliveryBadge(Member with { Delivery = delivery })!.Text == "届きました");
    }
}
