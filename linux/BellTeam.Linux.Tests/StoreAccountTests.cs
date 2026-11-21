using BellTeam.Core;
using Xunit;

namespace BellTeam.Linux;

public sealed class StoreAccountTests
{
    [Fact]
    public void TheBadgeAndLineAreTheMacBillingPageHead()
    {
        Assert.Equal(("有効", SettingsTone.Green, "購読中です"), StoreAccount.Status(true));
        Assert.Equal(("未設定", SettingsTone.Gray, "購読していません"), StoreAccount.Status(false));
    }

    [Theory]
    [InlineData("none", 0, StoreAccountState.SignedOut)]
    [InlineData("none", 1, StoreAccountState.SignedOut)]
    [InlineData("store", 0, StoreAccountState.SignedInNeedsPurchase)]
    [InlineData("store", 1, StoreAccountState.SignedInEntitled)]
    [InlineData("handoff", 0, StoreAccountState.Handoff)]
    [InlineData("handoff", 2, StoreAccountState.Handoff)]
    [InlineData("signed", 0, StoreAccountState.Signed)]
    [InlineData("signed", 1, StoreAccountState.Signed)]
    public void ThePassKindAndEntitlementsDecideTheAccountState(string kind, int entitlements, StoreAccountState expected) => Assert.Equal(expected, StoreAccount.Of(kind, entitlements));
}
