using System.ComponentModel;
using System.Net.Http;
using System.Reflection;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Threading;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;
public sealed class QualityReviewTests
{
    [Theory]
    [InlineData(1, "画像")]
    [InlineData(3, "画像3枚")]
    public void ImageWithoutUrlStillHasReadableLabel(int count, string expected) => Sta(() =>
    {
        using var workspace = new Workspace(); var card = new MessageCard { Workspace = workspace, Message = new() { Id = "image", At = DateTimeOffset.Now, Image = true, ImageCount = count } };
        var row = Assert.IsType<StackPanel>(card.Content); var contents = Assert.IsType<StackPanel>(row.Children.OfType<Border>().Single().Child);
        Assert.Contains(expected, contents.Children.OfType<TextBlock>().Select(item => item.Text));
        card.Message = card.Message with { Image = false }; Assert.DoesNotContain(contents.Children.OfType<TextBlock>(), item => item.Text == expected && item.Visibility == Visibility.Visible);
    });
    private static void Sta(Action action) { Exception? failure = null; var thread = new Thread(() => { try { action(); } catch (Exception error) { failure = error; } finally { Dispatcher.CurrentDispatcher.InvokeShutdown(); } }); thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join(); if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw(); }
}
