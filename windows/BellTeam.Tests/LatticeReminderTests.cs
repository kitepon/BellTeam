using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Threading;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;

// 工程表の設定 (docs/architecture/modules/lattice/screen-spec.md "工程表の設定"): the reminder switch's one read, one PUT, readback and recovery, then the gear and sheet in the window.
public sealed class LatticeReminderTests
{
    private static readonly Func<TimeSpan, CancellationToken, Task> Forever = (_, token) => Task.Delay(Timeout.Infinite, token);

    private static LatticeReminderModel Open(LatticeFixture fixture, string project = "lattice", Func<TimeSpan, CancellationToken, Task>? delay = null)
    {
        var model = new LatticeReminderModel(new BellApi(new Uri("http://localhost/"), fixture), project, CancellationToken.None, delay ?? Forever);
        model.Refresh();
        return model;
    }

    [Fact]
    public void TheSavedValueIsReadOnceAndOneChangeSendsOneBodyWithEnabledOnly() => RunSta(() =>
    {
        var fixture = new LatticeFixture("chart"); using var model = Open(fixture);
        Until(() => model.Ready);
        Assert.False(model.Confirmed); Assert.Equal("", model.Status); Assert.Empty(fixture.ReminderWrites);
        Await(model.SetAsync(true));
        Assert.True(model.Confirmed); Assert.True(model.Ready); Assert.False(model.SaveFailed);
        Assert.Equal(["{\"enabled\":true}"], fixture.ReminderWrites);
        Await(model.SetAsync(true));   // the confirmed value again: nothing is sent
        Assert.Single(fixture.ReminderWrites);
    });

    [Fact]
    public void AFailedSaveSaysSoAndReadsTheServerValueWithoutSendingAgain() => RunSta(() =>
    {
        var fixture = new LatticeFixture("reminders-save-fails"); using var model = Open(fixture);
        Until(() => model.Ready);
        Await(model.SetAsync(true));
        Assert.True(model.SaveFailed); Assert.Single(fixture.ReminderWrites);
        Assert.True(model.Confirmed);   // the server kept it: the read after the failed answer shows the truth
        Assert.True(model.Ready);
    });

    [Fact]
    public void AnOlderServerAndAMissingChartEachSayWhatHappenedAndAskNoMore() => RunSta(() =>
    {
        using var old = Open(new LatticeFixture("reminders-old"));
        Until(() => old.Status == LatticeReminderModel.OldServer);
        Assert.False(old.CanRetry); Assert.False(old.Ready); Assert.False(old.Missing); Assert.Null(old.Confirmed);
        using var missing = Open(new LatticeFixture("chart"), "nowhere");
        Until(() => missing.Missing);
        Assert.Equal(LatticeChart.NotFound, missing.Status); Assert.False(missing.Ready);
    });

    [Fact]
    public void ATransientReadFailureKeepsRetryingAndReadAgainEndsTheWait() => RunSta(() =>
    {
        var fixture = new LatticeFixture("reminders-read-fails"); using var model = Open(fixture);
        Until(() => model.CanRetry);
        Assert.Contains("再試行します", model.Status); Assert.False(model.Ready); Assert.Null(model.Confirmed);
        model.Refresh();
        Until(() => model.Ready);
        Assert.False(model.Confirmed); Assert.False(model.CanRetry);
    });

    [Fact]
    public void TheGearOpensTheSheetInEveryViewAndTheSwitchSavesOnceThenCloseGoesBack() => RunSta(() =>
    {
        var fixture = new LatticeFixture("chart");
        using var workspace = new Workspace(origin => new BellApi(origin, fixture));
        Await(workspace.ConnectAsync("http://localhost", listen: false));
        var window = new LatticeWindow(workspace, _ => Task.CompletedTask) { Rendering = true };
        window.Sync(); Until(() => window.ListSettled);
        window.OpenChart("lattice"); var chart = window.Chart!;
        Until(() => chart.Feed.Snapshot is not null);
        T Find<T>(string id) where T : FrameworkElement => LogicalTree.Find<T>(window.Content).Single(item => System.Windows.Automation.AutomationProperties.GetAutomationId(item) == id);
        foreach (var view in new[] { "tree", "lanes", "history" })
        {
            chart.SetView(view);
            var gear = Find<Button>("lattice-settings");
            Assert.Equal("工程表の設定", System.Windows.Automation.AutomationProperties.GetName(gear));
            gear.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            Assert.NotNull(chart.Reminders);
            Until(() => chart.Reminders!.Model.Ready);
            Assert.Equal("1分ごとの催促", System.Windows.Automation.AutomationProperties.GetName(Find<ToggleButton>("lattice-reminder-switch")));
            Find<Button>("lattice-reminder-close").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            Assert.Null(chart.Reminders);
        }
        Assert.Empty(fixture.ReminderWrites);
        chart.OpenReminders(); Until(() => chart.Reminders!.Model.Ready);
        var toggle = Find<ToggleButton>("lattice-reminder-switch");
        Assert.False(toggle.IsChecked); Assert.True(toggle.IsEnabled);
        toggle.IsChecked = true; toggle.RaiseEvent(new RoutedEventArgs(ButtonBase.ClickEvent));
        Until(() => chart.Reminders!.Model.Ready);
        Assert.Equal(["{\"enabled\":true}"], fixture.ReminderWrites);
        Assert.True(Find<ToggleButton>("lattice-reminder-switch").IsChecked);
        // The window's Esc closes the sheet before anything else; the chart stays.
        Assert.True(chart.CloseReminders()); Assert.False(chart.CloseReminders());
        chart.OpenReminders(); var sheet = chart.Reminders;
        chart.Stop(); Assert.Null(chart.Reminders);   // the sheet goes with the chart
        window.Close();
    });

    private static void Pump() { var frame = new DispatcherFrame(); Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() => frame.Continue = false)); Dispatcher.PushFrame(frame); }
    private static void Await(Task task) { Until(() => task.IsCompleted); task.GetAwaiter().GetResult(); }
    private static void Until(Func<bool> done) { var until = DateTime.UtcNow.AddSeconds(10); while (!done()) { if (DateTime.UtcNow > until) throw new TimeoutException(); Pump(); Thread.Sleep(1); } }
    private static void RunSta(Action action)
    {
        Exception? failure = null;
        var thread = new Thread(() => { try { SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(Dispatcher.CurrentDispatcher)); action(); } catch (Exception error) { failure = error; } finally { Dispatcher.CurrentDispatcher.InvokeShutdown(); } });
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
        if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }
}
