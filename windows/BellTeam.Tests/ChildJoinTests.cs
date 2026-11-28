using BellTeam.Core;
using Xunit;

namespace BellTeam.Tests;

public class ChildJoinTests
{
    // The library's code never reaches the person: other_account has its own sentence, every other code is the one generic line.
    [Theory]
    [InlineData("other_account", "この端末と親の端末で、サインインしているアカウントが違います。親の端末と同じアカウント（AppleかGoogle）でこの端末にサインインして、もう一度QRコードを出してください。")]
    [InlineData("parent_refused", "つなげませんでした。もう一度つないでください。")]
    [InlineData(null, "つなげませんでした。もう一度つないでください。")]
    public void FailedLineSpeaksNoCode(string? code, string expected) => Assert.Equal(expected, ChildJoinText.FailedLine(code));
}
