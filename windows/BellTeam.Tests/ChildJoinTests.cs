using BellTeam.Core;
using Xunit;

namespace BellTeam.Tests;

public class ChildJoinTests
{
    // The library's code never reaches the person: other_account has its own sentence, every other code is the one generic line.
    [Theory]
    [InlineData("other_account", ChildJoinText.OtherAccount)]
    [InlineData("parent_refused", ChildJoinText.Failed)]
    [InlineData(null, ChildJoinText.Failed)]
    public void FailedLineSpeaksNoCode(string? code, string expected) => Assert.Equal(expected, ChildJoinText.FailedLine(code));
}
