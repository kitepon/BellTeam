using BellTeam.Core;

namespace BellTeam.Linux;

// The Claude slot row says how many members use the slot (the Mac's words), never their names or ids.
public sealed class AccountUsersLineTests
{
    private static readonly AccountSlot First = new() { Slot = "1st", Seats = ["bot-2f617c2f", "bot-8f47c439"] };

    [Fact]
    public void AMemberCountFromTheBotsAccountsWhenTheServerSendsThem()
    {
        var accounts = new SeatAccount?[] { new("claude", "1st"), new("claude", "2nd"), new("codex", "1st"), null };
        Assert.Equal("いま1人がこのアカウントで動いています", AccountText.UsersLine(accounts, "claude", First));
        Assert.Equal("いまこのアカウントで動いているメンバーはいません", AccountText.UsersLine(accounts, "claude", new AccountSlot { Slot = "3rd" }));
    }

    [Fact]
    public void AnOlderBodyGivesTheSeatCountAndNeverTheIds()
    {
        var line = AccountText.UsersLine(new SeatAccount?[] { null }, "claude", First);
        Assert.Equal("2人が使用", line); Assert.DoesNotContain("bot-", line);
        Assert.Null(AccountText.UsersLine(new SeatAccount?[] { null }, "claude", new AccountSlot { Slot = "1st" }));
    }
}
