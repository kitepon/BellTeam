using BellTeam.App;
using Kitepon.LoginBilling.Desktop;

namespace BellTeam.Tests;

public class ApprovalBoxAccountTests
{
    [Fact]
    public void WithoutAPassInItsOwnStoreTheStateIsSignedOutAndTheStoreIsNotBellTeams()
    {
        var account = new ApprovalBoxAccount("http://127.0.0.1:8788", new MemoryPassStore());
        Assert.False(account.SignedIn);
        Assert.Null(account.PassHeader());                      // no pass, no header: the package then says SignedOut and sends nothing
        Assert.NotEqual("BellTeam", ApprovalBoxAccount.StoreName);
        Assert.Equal("https://approval-box.kitepon.dev", ApprovalBoxAccount.ProductOrigin);
    }
}
