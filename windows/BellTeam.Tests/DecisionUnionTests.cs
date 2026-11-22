using BellTeam.Core;

namespace BellTeam.Tests;

public class DecisionUnionTests
{
    private static ViewDecision D(string id, string status = "pending", string urgency = "normal", string title = "t", string created = "2026-11-22T01:00:00Z") => new() { Id = id, Status = status, Urgency = urgency, Title = title, CreatedAt = created, UpdatedAt = created };
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-11-22T05:00:00Z");

    [Fact]
    public void TheDeviceCopyWinsAServerOnlyDecisionStaysAndEachCopyNamesItsSource()
    {
        var merged = DecisionUnion.Merge([D("K-1", title: "server"), D("K-2")], [D("K-1", title: "device"), D("K-3")]);
        Assert.Equal(["K-1", "K-3", "K-2"], merged.Select(item => item.Id));
        Assert.Equal(("device", "device"), (merged[0].Source, merged[0].Title));
        Assert.Equal(["device", "device", "server"], merged.Select(item => item.Source));
    }

    [Fact]
    public void AVerifiedDeviceThatHoldsNothingChangesNothingForTheServerList()
    {
        var server = new[] { D("K-1"), D("K-2") };
        Assert.Equal(["K-1", "K-2"], DecisionUnion.Merge(server, []).Select(item => item.Id));
        Assert.All(DecisionUnion.Merge(server, []), item => Assert.Equal("server", item.Source));
    }

    [Fact]
    public void TheSummaryAddsOnlyWhatTheServerListsDoNotKnow()
    {
        var serverSummary = new ApprovalSummary { Pending = 2, Urgent = 1, Held = 1, AnsweredToday = 3, FiledToday = 5 };
        var serverKnown = new[] { D("K-1"), D("K-2") };
        var device = new[] { D("K-1"), D("K-3", urgency: "high"), D("K-4", "held"), D("K-5", "answered") };
        var s = DecisionUnion.Summary(serverSummary, serverKnown, device, Now);
        Assert.Equal((3, 2, 2, 4, 8), (s.Pending, s.Urgent, s.Held, s.AnsweredToday, s.FiledToday));
        var none = DecisionUnion.Summary(null, [], [], Now);
        Assert.Equal((0, 0, 0, 0, 0), (none.Pending, none.Urgent, none.Held, none.AnsweredToday, none.FiledToday));
    }
}
