using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;
public sealed class QualityReviewTests
{
    [Fact]
    public void UnshownWindowHasNoRestoreBoundsToPersist() => Sta(() =>
    {
        var window = new Window(); var bounds = window.RestoreBounds;
        Assert.True(bounds.IsEmpty);
        Assert.Throws<ArgumentException>(() => JsonSerializer.Serialize(new WindowPlacement(bounds.Left,bounds.Top,bounds.Width,bounds.Height,false),BellApi.Json)); window.Close();
    });
    [Theory]
    [InlineData(1, "画像")]
    [InlineData(3, "画像3枚")]
    public void ImageWithoutUrlStillHasReadableLabel(int count, string expected) => Sta(() =>
    {
        using var workspace = new Workspace(); var card = new MessageCard { Workspace = workspace, Message = new() { Id = "image", At = DateTimeOffset.Now, Image = true, ImageCount = count } };
        var label = LogicalTree.Find<TextBlock>(card.Content).Single(item => item.Text == expected); var placeholder = Assert.IsType<StackPanel>(label.Parent);
        Assert.Equal(Visibility.Visible, placeholder.Visibility);
        card.Message = card.Message with { Image = false }; Assert.Equal(Visibility.Collapsed, placeholder.Visibility);
    });
    private static void Sta(Action action) { Exception? failure = null; var thread = new Thread(() => { try { action(); } catch (Exception error) { failure = error; } finally { Dispatcher.CurrentDispatcher.InvokeShutdown(); } }); thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join(); if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw(); }
}
