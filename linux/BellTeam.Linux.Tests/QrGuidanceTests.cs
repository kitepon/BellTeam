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

    // login-billing 1.60: the library's join code stands in the QR block, selectable, with a copy button; none given, none shown.
    [Fact]
    public Task TheJoinCodeIsBesideTheQrOnlyWhenTheLibraryGaveOne() => Ui.Run(() =>
    {
        const string link = "https://login-billing.kitepon.dev/join/dev.kitepon.bellbot#lbq4:test";
        static List<string?> Texts(Avalonia.Controls.Control root) { root.UpdateLayout(); return [.. Avalonia.VisualTree.VisualExtensions.GetVisualDescendants(root).OfType<TextBlock>().Select(text => text.Text)]; }
        var card = new LinuxAccountCard(CancellationToken.None);
        var with = card.QrBlock(link, "https://login-billing.kitepon.dev/join/dev.kitepon.bellbot#lbj1:code");
        Assert.Contains("https://login-billing.kitepon.dev/join/dev.kitepon.bellbot#lbj1:code", Texts(with));
        Assert.Contains(BellTeam.Core.LocalFormText.CodeHint, Texts(with));
        Assert.Contains(Avalonia.VisualTree.VisualExtensions.GetVisualDescendants(with).OfType<Button>(), button => (string?)button.Content == BellTeam.Core.LocalFormText.CodeCopy);
        Assert.DoesNotContain(BellTeam.Core.LocalFormText.CodeHint, Texts(card.QrBlock(link)));
        return Task.CompletedTask;
    });

    // The first run (the Owner 2026-11-24, Approval Box's first screen is the model): the name, the one line, the sign-in sentence, then the two buttons; the QR screen runs title, QR, validity, sentence, やめる.
    [Fact]
    public Task TheFirstScreenShowsTheProcess() => Ui.Run(() =>
    {
        var first = new LinuxAccountCard(CancellationToken.None, firstScreen: true);
        var texts = first.Children.OfType<TextBlock>().Select(text => text.Text).ToList();
        Assert.Equal([BellTeam.Core.LocalFormText.AppName, BellTeam.Core.LocalFormText.Purpose], texts);
        var inner = (StackPanel)((Border)first.Children.Last()).Child!;
        Assert.Equal(BellTeam.Core.LocalFormText.FirstSignInChildOnly, ((TextBlock)inner.Children[0]).Text);
        Assert.Equal([BellTeam.Core.SignInText.Apple, BellTeam.Core.SignInText.Google], inner.Children.OfType<Button>().Select(button => (string)button.Content!).ToList());

        var screen = (StackPanel)new LinuxAccountCard(CancellationToken.None, firstScreen: true, "https://login-billing.kitepon.dev/join/dev.kitepon.bellbot#lbq4:test").Children.Single();
        var parts = screen.Children.Select(child => child switch { TextBlock text => text.Text, QrView => "qr", Button => "button", _ => "row" }).ToList();
        Assert.Equal([BellTeam.Core.LocalFormText.WaitingTitle, "qr", "row", BellTeam.Core.LocalFormText.Qr, "row", "button"], parts);   // the second "row": the render scene's sample join code
        return Task.CompletedTask;
    });

    [Fact]
    public Task TheSignInSentenceIsBeforeTheButtons() => Ui.Run(() =>
    {
        var card = new LinuxAccountCard(CancellationToken.None);
        var texts = card.Children.OfType<TextBlock>().Select(text => text.Text).ToList();
        var at = texts.IndexOf(BellTeam.Core.LocalFormText.FirstSignInChildOnly);
        Assert.True(at >= 0);
        Assert.True(card.Children.ToList().FindIndex(child => child is Button) > card.Children.ToList().FindIndex(child => child is TextBlock text && text.Text == texts[at]));
        return Task.CompletedTask;
    });
}
