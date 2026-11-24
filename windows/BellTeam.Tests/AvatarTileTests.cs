using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;

// The member list icons blinked: a refreshed roster gave the tile a new entry and it cleared the loaded image before it read it again.
public sealed class AvatarTileTests
{
    [Fact]
    public void ALoadedAvatarStaysOnScreenWhenTheRosterHandsTheTileTheSameMemberAgain()
    {
        RunSta(() =>
        {
            var png = "data:image/png;base64," + Convert.ToBase64String(ImageCodec.Png(BitmapSource.Create(2, 2, 96, 96, PixelFormats.Bgra32, null, new byte[16], 8)));
            var member = new ChatTarget("bot-x", false);
            ConversationEntry Entry(bool working, string avatar) => new(member, "ア", "", DateTimeOffset.Now, new Bot { Id = "bot-x", Name = "ア", DisplayName = "ア", Avatar = avatar }, null, Working: working);
            var tile = new AvatarTile { Entry = Entry(false, png) };
            Await(tile.LoadTask);
            var image = (Image)((Grid)tile.Child).Children.OfType<Image>().Single();
            Assert.NotNull(image.Source);
            tile.Entry = Entry(true, png);   // the same member and image, a new entry object
            Assert.NotNull(image.Source);   // never blank while it is read again
            Await(tile.LoadTask); Assert.NotNull(image.Source);
            tile.Entry = new ConversationEntry(new ChatTarget("bot-y", false), "イ", "", DateTimeOffset.Now, null, null);
            Assert.Null(image.Source);   // another member does not show this member's picture
        });
    }

    private static void Await(Task task) { var until = DateTime.UtcNow.AddSeconds(5); while (!task.IsCompleted) { if (DateTime.UtcNow > until) throw new TimeoutException(); var frame = new DispatcherFrame(); Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() => frame.Continue = false)); Dispatcher.PushFrame(frame); Thread.Sleep(1); } task.GetAwaiter().GetResult(); }
    private static void RunSta(Action action) { Exception? failure = null; var thread = new Thread(() => { try { SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(Dispatcher.CurrentDispatcher)); action(); } catch (Exception error) { failure = error; } finally { Dispatcher.CurrentDispatcher.InvokeShutdown(); } }); thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join(); if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw(); }
}
