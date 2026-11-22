using Avalonia.Controls;
using Avalonia.VisualTree;
using BellTeam.Core;

namespace BellTeam.Linux;

// a485 7f: the handoff block both Android and Linux draw. It shows the QR, the code, the check number and one way out; it has no purchase.
public sealed class AccountPartsTests
{
    [Fact]
    public Task TheHandoffBlockShowsTheQrTheCodeAndTheCheckNumberAndCancelCallsBack() => Ui.Run(async () =>
    {
        var cancelled = 0;
        var block = AccountParts.HandoffBlock("bellteam://login?x=1", "ABCD-EFGH", "42", () => cancelled++);
        var texts = block.GetVisualDescendants().OfType<TextBlock>().Select(t => t.Text ?? "").ToArray();
        Assert.Contains("ABCD-EFGH", texts); Assert.Contains("42", texts); Assert.Contains(StoreAccountText.HandoffTitle, texts);
        Assert.Single(block.GetVisualDescendants().OfType<QrView>());
        var stop = block.GetVisualDescendants().OfType<Button>().Single();
        Assert.Equal(StoreAccountText.HandoffCancel, stop.Content as string);
        stop.RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Button.ClickEvent));
        Assert.Equal(1, cancelled);
        await Task.CompletedTask;
    });
}
