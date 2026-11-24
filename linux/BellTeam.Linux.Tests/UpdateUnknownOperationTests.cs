using BellTeam.Core;
using Xunit;

namespace BellTeam.Linux;

// An operation whose phase or admission is unknown is a result nobody confirmed: its target part reads "確認できません", never "更新中" (same rule as Apple).
public sealed class UpdateUnknownOperationTests
{
    private static readonly UpdateComponent Body = new("body", "BellTeam本体", "", null, null, new UpdateComparison("update_available", null), [], new UpdateCapability(true, null), new UpdateAvailability(true, null), default);

    private static UpdateOperation Operation(string admission, string phase)
    {
        var target = new UpdateTarget("body", null, new UpdateVersion("2", null, null, "published"));
        var plan = new UpdatePlan(Guid.NewGuid(), "component", "body", DateTimeOffset.UtcNow, [target], new UpdateCompatibility(true, null), new UpdateImpact(true, ""), new UpdateCapability(true, null), "update");
        return new UpdateOperation(Guid.NewGuid(), plan, admission, phase, "pending", "pending", null, null);
    }

    [Theory]
    [InlineData("pending", "unknown", UpdateBadge.Unknown)]
    [InlineData("unknown", "preparing", UpdateBadge.Unknown)]
    [InlineData("accepted", "applying", UpdateBadge.Updating)]
    public void ATargetIsUpdatingOnlyWhenTheOperationIsKnownToRun(string admission, string phase, UpdateBadge badge)
        => Assert.Equal(badge, UpdateScreen.Badge(Body, Operation(admission, phase)));
}
