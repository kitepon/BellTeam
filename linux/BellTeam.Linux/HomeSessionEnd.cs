using BellTeam.Core;

namespace BellTeam.Linux;

// Sign-out of a home server (app-sessions.md section 4; Windows MainWindow.EndHomeSessionAsync is the pattern): the app ends its own session (DELETE /api/home/sessions/{id}, the row the server marks current) and forgets the token.
// Linux and Android share it. Begin binds, at the moment the user acts and before any await, the connection that is current: its planning client, lifetime, address and held token. EndAsync uses only those, so a switch or a
// reconnect while anything is pending (the push unregister, the session read) cancels that lifetime and the old sign-out neither acts through the new connection nor touches its token. Nothing escapes: the callers are async-void callbacks.
// EndAsync returns true while the bound connection is still the current one, so the caller may go on to its own sign-out; false means a switch already replaced it and the caller leaves the new connection alone.
internal sealed class HomeSessionEnd
{
    private readonly LinuxWorkspace model; private readonly ISessionTokenStore tokens;
    private readonly CancellationToken life; private readonly bool home; private readonly PlanningApi? planning; private readonly Uri? origin; private readonly string? held;

    private HomeSessionEnd(LinuxWorkspace model, ISessionTokenStore tokens)
    {
        this.model = model; this.tokens = tokens; life = model.ConnectionToken;
        if (!model.SessionLoginRequired || !model.Connected) return;
        home = true; planning = model.Planning;
        origin = Uri.TryCreate(model.Server, UriKind.Absolute, out var address) ? ServerOrigin.Parse(address.AbsoluteUri) : null;
        held = origin is null ? null : tokens.Load(origin);
    }

    public static HomeSessionEnd Begin(LinuxWorkspace model, ISessionTokenStore tokens) => new(model, tokens);
    public static Task<bool> EndAsync(LinuxWorkspace model, ISessionTokenStore tokens) => Begin(model, tokens).EndAsync();

    public async Task<bool> EndAsync()
    {
        if (!home) return !life.IsCancellationRequested;
        try
        {
            var own = (await planning!.HomeSessionsAsync(life)).FirstOrDefault(session => session.Current);
            if (own is not null) await planning.EndHomeSessionAsync(own.Id, life);
        }
        catch (OperationCanceledException) { }   // the connection was replaced or signed out meanwhile: the token below is still ours to forget
        catch (Exception error) { if (!life.IsCancellationRequested) model.ReportActionError(error.Message); }
        finally { if (origin is not null && held is not null && tokens.Load(origin) == held) tokens.Clear(origin); }   // only the token this sign-out began with: a newer login at the same address keeps its own
        return !life.IsCancellationRequested;
    }
}
