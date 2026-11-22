using BellTeam.App;
using BellTeam.PeerChannel;
using Kitepon.LoginBilling.Desktop;

namespace BellTeam.Tests;

public class ApprovalBoxAccountTests
{
    [Fact]
    public async Task WithoutAPassInItsOwnStoreTheStateIsSignedOutAndTheStoreIsNotBellTeams()
    {
        var account = new ApprovalBoxAccount("http://127.0.0.1:8788", new MemoryPassStore());
        Assert.False(account.SignedIn);
        await Assert.ThrowsAsync<SignedOutException>(() => account.AccessAsync(CancellationToken.None));
        Assert.NotEqual("BellTeam", ApprovalBoxAccount.StoreName);
        Assert.Equal("https://approval-box.kitepon.dev", ApprovalBoxAccount.ProductOrigin);
    }
}
