using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using BellTeam.Core;

namespace BellTeam.Linux;

// a451: one AI's install message (the server's words, shown as given) and the 「最新版を入れる」 button; the same press installs and updates.
// The server decides every state; this view only presses and reads (harness-cli.md). While the server says busy it reads again with a capped backoff and never stops on a count.
public sealed class HarnessInstallPanel : StackPanel
{
    private static readonly TimeSpan Every = TimeSpan.FromSeconds(3), Longest = TimeSpan.FromSeconds(30);
    private readonly HarnessAuthenticationApi api;
    private readonly string harness, name;
    private readonly CancellationToken lifetime;
    private readonly TextBlock message = SettingsUi.Text("", 13, SettingsUi.Muted), problem = SettingsUi.Text("", 12, SettingsUi.Red, null, new Thickness(0, 4, 0, 0));
    private readonly Button press = SettingsUi.Capsule(HarnessCliInstall.DefaultLabel, SettingsUi.Violet, Brushes.White, 8, 13, new Thickness(12, 6));
    private bool pressing, polling, stopped;
    public HarnessCliInstall Install { get; private set; }
    // Raised whenever the server's answer changed what is shown; the owner of the row decides what a change in readiness means.
    public event Action<HarnessCliInstall>? Changed;
    internal Button Press => press;
    internal string MessageText => message.Text ?? "";
    internal string ProblemText => problem.Text ?? "";

    public HarnessInstallPanel(HarnessAuthenticationApi api, string harness, string name, HarnessCliInstall install, CancellationToken lifetime)
    {
        this.api = api; this.harness = harness; this.name = name; this.lifetime = lifetime; Install = install;
        press.HorizontalAlignment = HorizontalAlignment.Left; press.Margin = new Thickness(0, 8, 0, 0);
        press.Click += async (_, _) => await PressAsync();
        Children.Add(message); Children.Add(press); Children.Add(problem); problem.IsVisible = false;
        Show(); if (Wants) _ = PollAsync();
    }
    // The server's busy flag, or an install of an absent CLI still running, keeps the reading going.
    private bool Wants => !stopped && !lifetime.IsCancellationRequested && (Install.Busy || Install.State == "installing");
    // A page that redraws puts the same panel under its new parent.
    public void MoveTo(Panel parent) { (Parent as Panel)?.Children.Remove(this); parent.Children.Add(this); }
    // The row that replaced this panel calls it, so its reading ends.
    public void Stop() => stopped = true;

    private void Show()
    {
        message.Text = Install.Message; message.Foreground = Install.NeedsAttention ? SettingsUi.Orange : SettingsUi.Muted;
        press.Content = Install.ButtonLabel; AutomationProperties.SetName(press, name + " " + Install.ButtonLabel);
        press.IsVisible = Install.CanPress; press.IsEnabled = !pressing;
    }
    private void Apply(HarnessCliInstall next) { var changed = next != Install; Install = next; Show(); if (changed) Changed?.Invoke(next); }
    private void Say(string? text) { problem.Text = text ?? ""; problem.IsVisible = !string.IsNullOrEmpty(text); }

    private async Task PressAsync()
    {
        if (pressing) return;
        pressing = true; Say(null); Show();
        try { Apply((await api.InstallAsync(harness, lifetime)).Install); }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { return; }
        // The press may have started the installer: say why, then read what the server has (the press is never resent).
        catch (Exception error) { Say(error.Message); try { Apply((await api.InstallStatusAsync(harness, lifetime)).Install); } catch (Exception) { /* the next press or reading shows the state */ } }
        finally { pressing = false; if (!lifetime.IsCancellationRequested) Show(); }
        if (Wants) _ = PollAsync();
    }

    private async Task PollAsync()
    {
        if (polling) return;
        polling = true; var wait = Every;
        try
        {
            while (Wants)
            {
                await Task.Delay(wait, lifetime);
                try { Apply((await api.InstallStatusAsync(harness, lifetime)).Install); Say(null); wait = Every; }
                catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { return; }
                catch (Exception error) { Say("状態を読めませんでした。読み直します。" + error.Message); wait = TimeSpan.FromTicks(Math.Min(Longest.Ticks, wait.Ticks * 2)); }
            }
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        finally { polling = false; }
    }
}
