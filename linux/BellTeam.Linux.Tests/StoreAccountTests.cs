using BellTeam.Core;
using Xunit;

namespace BellTeam.Linux;

public sealed class StoreAccountTests
{
    [Theory]
    [InlineData("none", 0, StoreAccountState.SignedOut)]
    [InlineData("none", 1, StoreAccountState.SignedOut)]
    [InlineData("store", 0, StoreAccountState.SignedInNeedsPurchase)]
    [InlineData("store", 1, StoreAccountState.SignedInEntitled)]
    [InlineData("handoff", 0, StoreAccountState.Handoff)]
    [InlineData("handoff", 2, StoreAccountState.Handoff)]
    public void ThePassKindAndEntitlementsDecideTheAccountState(string kind, int entitlements, StoreAccountState expected) => Assert.Equal(expected, StoreAccount.Of(kind, entitlements));
}
