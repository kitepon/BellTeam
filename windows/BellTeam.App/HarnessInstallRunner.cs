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
        running = true; Error = null; Changed?.Invoke();
        try
        {
            if (post) Apply(await api.InstallAsync(harness, token));
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
        finally { running = false; if (!token.IsCancellationRequested) Changed?.Invoke(); }
    }
}
