using Avalonia.Controls;

namespace BellTeam.Linux;

// login-billing 1.50 (11.12): BellTeam's own QR sentence stands word for word directly under the QR, before the waiting line; the sign-in sentence stands before the Apple / Google buttons.
public sealed class QrGuidanceTests
{
    [Fact]
    public Task TheLibrarysSentenceIsDirectlyUnderTheQr() => Ui.Run(() =>
    {
        var block = new LinuxAccountCard(CancellationToken.None).QrBlock("https://login-billing.kitepon.dev/join/dev.kitepon.bellbot#lbq4:test");
        var column = (StackPanel)((Border)block).Child!;
        var at = column.Children.ToList().FindIndex(child => child is QrView);
        Assert.True(at > 0);
        Assert.Equal(BellTeam.Core.LocalFormText.Qr, ((TextBlock)column.Children[at + 1]).Text);
        return Task.CompletedTask;
    });

    [Fact]
    public Task TheSignInSentenceIsBeforeTheButtons() => Ui.Run(() =>
    {
        var card = new LinuxAccountCard(CancellationToken.None);
        var texts = card.Children.OfType<TextBlock>().Select(text => text.Text).ToList();
        var at = texts.IndexOf(BellTeam.Core.LocalFormText.FirstSignIn);
        Assert.True(at >= 0);
        Assert.True(card.Children.ToList().FindIndex(child => child is Button) > card.Children.ToList().FindIndex(child => child is TextBlock text && text.Text == texts[at]));
        return Task.CompletedTask;
    });
}
