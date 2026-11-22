using System.Text;
using System.Text.Json;
using BellTeam.PeerChannel;

namespace BellTeam.Tests;

public class DeviceFramesTests
{
    private static Received Frame(string t, string json) { var bytes = Encoding.UTF8.GetBytes(json); return new(t, JsonDocument.Parse(json), bytes, new BellTeam.PeerChannel.Frame(t, bytes, [])); }
    private const string Req = "{\"id\":\"f1\",\"at\":1,\"rid\":\"r1\",\"rv\":1,\"schema\":\"approval-box/decision@1\",\"content\":{\"decision_id\":\"K-1\",\"title\":\"t\",\"options\":[{\"id\":\"yes\",\"label\":\"はい\"}]}}";
    private static (JsonDocument?, JsonDocument?, FrameChecks.ResultCode?) NoCheck(Received r) => throw new InvalidOperationException("not a result");

    [Fact]
    public void ARequestIsAckedOkAndKeptWithItsFrameBytesAndControlFramesTakeNoAck()
    {
        var book = new DecisionBook(); var r = Frame("request", Req);
        Assert.Equal("f1", DeviceFrames.IdOf(r));
        Assert.Equal("ok", DeviceFrames.Handle(r, book, NoCheck, 5));
        Assert.Equal(r.Frame.B, book.Find("r1")!.Body);
        Assert.Null(DeviceFrames.Handle(Frame("hello", "{\"id\":\"h\"}"), book, NoCheck, 6));
        Assert.Null(DeviceFrames.Handle(Frame("ack", "{\"id\":\"a\"}"), book, NoCheck, 6));
    }

    [Fact]
    public void AVerifiedResultClosesTheRequestWithTheWinningAnswerAndAnUnverifiedOneChangesNothing()
    {
        var book = new DecisionBook(); DeviceFrames.Handle(Frame("request", Req), book, NoCheck, 1);
        var result = Frame("result", "{\"id\":\"f2\",\"rid\":\"r1\",\"status\":\"answered\",\"decided_by\":\"dev1\"}");
        Assert.Equal("refused:not_verified", DeviceFrames.Handle(result, book, _ => (null, null, FrameChecks.ResultCode.AnswerNotVerified), 2));
        Assert.Equal("refused:invalid", DeviceFrames.Handle(result, book, _ => (null, null, FrameChecks.ResultCode.Invalid), 2));
        Assert.Equal(DecisionStatus.Pending, book.Find("r1")!.Status);
        Assert.Equal("ok", DeviceFrames.Handle(result, book, r => (JsonDocument.Parse(r.Frame.B), JsonDocument.Parse("{\"rid\":\"r1\",\"rv\":1,\"content\":{\"option_id\":\"yes\"}}"), null), 3));
        var e = book.Find("r1")!;
        Assert.Equal((DecisionStatus.Answered, "yes", "dev1"), (e.Status, e.Answer!.OptionId, e.Answer.DecidedBy));
    }

    [Fact]
    public void AResultWithoutAnAnswerClosesAsCancelledAndClosedKeepsItsReason()
    {
        var book = new DecisionBook(); DeviceFrames.Handle(Frame("request", Req), book, NoCheck, 1);
        var closed = Frame("result", "{\"id\":\"f3\",\"rid\":\"r1\",\"status\":\"closed\"}");
        Assert.Equal("ok", DeviceFrames.Handle(closed, book, r => (JsonDocument.Parse(r.Frame.B), null, null), 4));
        Assert.Equal((DecisionStatus.Cancelled, "closed"), (book.Find("r1")!.Status, book.Find("r1")!.CancelReason));
    }
}
