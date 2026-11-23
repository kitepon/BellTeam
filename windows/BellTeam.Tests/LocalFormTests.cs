using System.Windows;
using System.Windows.Controls;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;

// a540 (contract 1.36 s10): the words of every outcome, the period rule, and the QR screen. The library binding is tested with t10b.
public sealed class LocalFormTests
{
    [Fact]
    public void EveryOutcomeButPaidHasItsOwnSentenceAndPaidSaysTheEnd()
    {
        var sentences = Enum.GetValues<LocalFormOutcome>().Where(o => o != LocalFormOutcome.Paid).Select(LocalFormText.Of).ToArray();
        Assert.Equal(sentences.Length, sentences.Distinct().Count());
        Assert.Contains("プライベート ネットワーク", LocalFormText.Of(LocalFormOutcome.PrivateNetwork)); Assert.DoesNotContain("プライベート", LocalFormText.Of(LocalFormOutcome.SameWifi));
        Assert.Throws<ArgumentOutOfRangeException>(() => LocalFormText.Of(LocalFormOutcome.Paid));
        Assert.Contains("有効期限：2026年12月23日", LocalFormText.Paid(new DateTimeOffset(2026, 12, 23, 12, 0, 0, TimeSpan.Zero)));
    }

    [Fact]
    public void ANewQrIsNeededWhenNoPeriodWasAcceptedOrItHasEnded()
    {
        var now = new DateTimeOffset(2026, 11, 23, 12, 0, 0, TimeSpan.Zero);
        Assert.True(LocalForm.NeedsNewRequest(null, now)); Assert.True(LocalForm.NeedsNewRequest(now, now));
        Assert.False(LocalForm.NeedsNewRequest(now.AddSeconds(1), now));
    }

    [Fact]
    public void TheScreenShowsTheQrWaitsAndOffersANewQrAfterAFailureButNotAfterPayment() => RunSta(() =>
    {
        var asked = 0; var stopped = 0; var view = new LocalRequestView(() => asked++, () => stopped++);
        view.ShowRequest("QR-TEXT");
        Assert.Single(Descendants<QrView>(view)); Assert.Contains(LocalFormText.Lead, Texts(view)); Assert.Contains(LocalFormText.Waiting, Texts(view)); Assert.Contains(LocalFormText.Firewall, Texts(view));
        Click(view, LocalFormText.Cancel); Assert.Equal(1, stopped);
        view.ShowOutcome(LocalFormOutcome.PrivateNetwork);
        Assert.Contains(LocalFormText.Of(LocalFormOutcome.PrivateNetwork), Texts(view)); Assert.Empty(Descendants<QrView>(view));
        Click(view, LocalFormText.NewQr); Assert.Equal(1, asked);
        view.ShowOutcome(LocalFormOutcome.Paid, new DateTimeOffset(2026, 12, 23, 12, 0, 0, TimeSpan.Zero));
        Assert.DoesNotContain(Descendants<Button>(view), b => System.Windows.Automation.AutomationProperties.GetName(b) == LocalFormText.NewQr);
        view.ShowPeriodEnded(); Assert.Contains(LocalFormText.PeriodEnded, Texts(view)); Click(view, LocalFormText.NewQr); Assert.Equal(2, asked);
    });

    private static string[] Texts(DependencyObject root) => Descendants<TextBlock>(root).Select(text => text.Text).ToArray();
    private static void Click(DependencyObject root, string name) => Descendants<Button>(root).Single(button => System.Windows.Automation.AutomationProperties.GetName(button) == name).RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
    private static IEnumerable<T> Descendants<T>(DependencyObject root) where T : DependencyObject { if (root is T found) yield return found; foreach (var child in LogicalTreeHelper.GetChildren(root).OfType<DependencyObject>()) foreach (var item in Descendants<T>(child)) yield return item; }
    private static void RunSta(Action action)
    {
        Exception? error = null; var thread = new Thread(() => { try { action(); } catch (Exception e) { error = e; } }); thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
        if (error is not null) throw new Exception(error.Message, error);
    }
}
