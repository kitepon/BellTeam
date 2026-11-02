using System.Text.Json;
using System.Windows.Controls;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;

public sealed class DeliveryTrackingTests
{
    private const string Tracking = """{"schema":"bellteam.delivery-tracking.v1","admission":"accepted","completion":"unknown"}""";
    private static TimelineMessage Read(string fields) => JsonSerializer.Deserialize<TimelineMessage>($$"""{"id":"m1","at":"2026-10-13T01:00:00Z","direction":"outgoing",{{fields}}}""", BellApi.Json)!;

    [Theory]
    [InlineData("null")]
    [InlineData("false")]
    [InlineData("[]")]
    [InlineData("{\"schema\":\"other\",\"admission\":\"accepted\",\"completion\":\"unknown\"}")]
    [InlineData("{\"schema\":\"bellteam.delivery-tracking.v1\",\"admission\":\"accepted\",\"completion\":42}")]
    public void InvalidTrackingKeepsExistingDirectStatus(string tracking)
    {
        Assert.Equal("配達失敗", Timeline.DeliveryLabel(Read($"\"delivery\":\"failed\",\"deliveryTracking\":{tracking}"), false));
    }

    [Fact]
    public void DirectStatusRequiresFailedAndKnownTupleAndUpdatesWithHistory()
    {
        var old = Read("\"delivery\":\"failed\"");
        var updated = Read($"\"delivery\":\"failed\",\"deliveryTracking\":{Tracking}");
        Assert.Equal("配達失敗", Timeline.DeliveryLabel(old, false));
        Assert.Equal("受付済み・完了未確認", Timeline.DeliveryLabel(Timeline.Merge([old], [updated])[0], false));
        Assert.Equal("配達済み", Timeline.DeliveryLabel(Read($"\"delivery\":\"delivered\",\"deliveryTracking\":{Tracking}"), false));
        Assert.Equal("配達済み", Timeline.DeliveryLabel(Timeline.Merge([updated], [Read("\"delivery\":\"delivered\"")])[0], false));
    }

    [Fact]
    public void RoomUsesPerRecipientEvidenceAndPrioritizesFailures()
    {
        var uncertain = $$"""{"delivery":"failed","deliveryTracking":{{Tracking}}}""";
        string Label(string deliveries, string routing = "{}") => Timeline.DeliveryLabel(Read($"\"deliveries\":[{deliveries}],\"routing\":{routing}"), true);
        Assert.Equal("完了未確認の宛先あり", Label($"{uncertain},{{\"delivery\":\"running\"}},{{\"delivery\":\"queued\"}},{{\"delivery\":\"stopped\"}}"));
        Assert.Equal("配達失敗", Label($"{uncertain},{{\"delivery\":\"failed\"}}"));
        Assert.Equal("配達失敗", Label(uncertain, "{\"status\":\"failed\"}"));
        Assert.Equal("", Label("{\"delivery\":\"failed\"}"));
        Assert.Equal("", Label($"{uncertain},null"));
        Assert.Equal("", Timeline.DeliveryLabel(Read($"\"deliveryTracking\":{Tracking}"), true));
    }

    [Fact]
    public void MessageCardShowsTheDecodedDirectStatus()
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            try
            {
                using var workspace = new Workspace();
                var card = new MessageCard { Workspace = workspace, Message = Read($"\"delivery\":\"failed\",\"deliveryTracking\":{Tracking}") };
                Assert.Contains("受付済み・完了未確認", Assert.IsType<StackPanel>(card.Content).Children.OfType<TextBlock>().Single().Text);
            }
            catch (Exception error) { failure = error; }
            finally { System.Windows.Threading.Dispatcher.CurrentDispatcher.InvokeShutdown(); }
        });
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
        if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }
}
