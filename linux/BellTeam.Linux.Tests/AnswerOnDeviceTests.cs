using System.Text.Json;
using BellTeam.Core;

namespace BellTeam.Linux;

// 409 answer_on_device (a490j): the decision only the hosted daemon holds is answered on the device. The screen shows the line, not a failure.
public sealed class AnswerOnDeviceTests
{
    private static JsonElement Body(string json) => JsonDocument.Parse(json).RootElement;

    [Fact]
    public void ThatConflictIsTheLineAndNotAFailure()
    {
        var body = Body("{\"error\":{\"code\":\"answer_on_device\",\"message\":\"x\"}}");
        Assert.True(Approvals.IsAnswerOnDevice(409, body));
        var outcome = Approvals.AnswerOutcome(409, body);
        Assert.Equal("device", outcome.Kind);
        Assert.Equal("この決裁は、決裁箱のアプリで答えてください。", outcome.Message);
    }

    [Fact]
    public void OtherConflictsAndStatusesAreUnchanged()
    {
        Assert.False(Approvals.IsAnswerOnDevice(409, Body("{\"error\":{\"code\":\"conflict\"}}")));
        Assert.False(Approvals.IsAnswerOnDevice(500, Body("{\"error\":{\"code\":\"answer_on_device\"}}")));
        Assert.Equal("ok", Approvals.AnswerOutcome(200, null).Kind);
        Assert.Equal("gone", Approvals.AnswerOutcome(404, Body("{\"error\":{\"code\":\"not_found\"}}")).Kind);
    }
}
