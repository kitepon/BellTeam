using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using BellTeam.Core;

namespace BellTeam.App;

// The press of 「最新版を入れる」 and the read that follows it (harness-cli.md): POST once, then GET every few seconds while the server says busy (or still checking).
// A failed read is shown and read again with a capped back-off; it never ends the wait. The press is idempotent on the server (a press while busy answers the same object).
internal sealed class HarnessInstallRunner(HarnessAuthenticationApi api, string harness, HarnessCliInstall? initial, CancellationToken token, TimeSpan? interval = null)
{
    private static readonly TimeSpan Longest = TimeSpan.FromSeconds(30);
    private readonly TimeSpan every = interval ?? TimeSpan.FromSeconds(3);
    private bool running;
    public HarnessCliInstall? Install { get; private set; } = initial;
    public string? Error { get; private set; }
    public bool Running => running;
    // Mac flow.pressing: the POST is in flight; the press says so until the server answers.
    public bool Pressing { get; private set; }
    public string PressLabel => Pressing ? "始めています…" : Install?.ButtonLabel ?? HarnessCliInstall.DefaultLabel;
    public event Action? Changed;
    public Task PressAsync() => RunAsync(post: true);
    // A press is queued or an installer runs (read again until it ends), or the first probe is still running.
    internal static bool Waiting(HarnessCliInstall install) => install.Busy || install.State == "checking";
    public Task FollowAsync() => Install is { } known && Waiting(known) ? RunAsync(post: false) : Task.CompletedTask;
    private void Apply(HarnessCliInstallResponse next)
    {
        if (next.Harness != harness) throw new BellApiException("別のAIの導入状態が返されました。");
        Install = next.Install; Error = null; Changed?.Invoke();
    }
    private async Task RunAsync(bool post)
    {
        if (running) return;
        running = true; Pressing = post; Error = null; Changed?.Invoke();
        try
        {
            if (post) { var first = await api.InstallAsync(harness, token); Pressing = false; Apply(first); }
            var wait = every;
            while (Install is { } now && Waiting(now) && !token.IsCancellationRequested)
            {
                await Task.Delay(wait, token);
                try { Apply(await api.InstallStatusAsync(harness, token)); wait = every; }
                catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
                catch (Exception error) { Error = error.Message; Changed?.Invoke(); wait = wait * 2 > Longest ? Longest : wait * 2; }
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
        catch (Exception error) { Error = error.Message; }
        finally { running = false; Pressing = false; if (!token.IsCancellationRequested) Changed?.Invoke(); }
    }
}

// Mac CLIInstallSection: the server's sentence is orange for an AI that cannot run (or after a failed install), the press is primary then and quiet otherwise, and a spinner shows while the server installs.
internal static class InstallLook
{
    public static Brush Sentence(HarnessCliInstall? install) => install is { Warns: true } ? SettingsUi.Orange : SettingsUi.Muted;
    public static void Style(Button press, HarnessInstallRunner runner)
    {
        var cannot = runner.Install is { CannotRun: true };
        press.Content = runner.PressLabel; press.Background = cannot ? SettingsUi.Violet : SettingsUi.Fill; press.Foreground = cannot ? Brushes.White : SettingsUi.Ink; press.IsEnabled = !runner.Running;
    }
    public static Spinner Spinner(Thickness margin) => new() { Stroke = SettingsUi.Violet, Margin = margin, HorizontalAlignment = HorizontalAlignment.Left, Visibility = Visibility.Collapsed };
    public static Visibility Spinning(HarnessCliInstall? install) => install is { Busy: true } ? Visibility.Visible : Visibility.Collapsed;
}
