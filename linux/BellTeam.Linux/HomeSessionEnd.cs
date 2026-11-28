using BellTeam.Core;

namespace BellTeam.Linux;

// Sign-out of a home server (app-sessions.md section 4; Windows MainWindow.EndHomeSessionAsync is the pattern): the app ends its own session (DELETE /api/home/sessions/{id}, the row the server marks current) and forgets the token.
// Linux and Android share it. Everything is bound to the connection that was current when it began: its planning client, its lifetime and its address. A switch or a reconnect while a read is pending
// cancels that lifetime, so the old sign-out neither acts through the new workspace nor touches the new connection's token. Nothing escapes: the callers are async-void callbacks.
// Returns true while that connection is still the current one, so the caller may go on to its own sign-out; false means a switch already replaced it and the caller must leave the new connection alone.
internal static class HomeSessionEnd
{
    public static async Task<bool> EndAsync(LinuxWorkspace model, ISessionTokenStore tokens)
    {
        if (!model.SessionLoginRequired || !model.Connected) return true;
        var life = model.ConnectionToken; var planning = model.Planning;
        var origin = Uri.TryCreate(model.Server, UriKind.Absolute, out var address) ? ServerOrigin.Parse(address.AbsoluteUri) : null;
        var held = origin is null ? null : tokens.Load(origin);
        try
        {
            var own = (await planning.HomeSessionsAsync(life)).FirstOrDefault(session => session.Current);
            if (own is not null) await planning.EndHomeSessionAsync(own.Id, life);
        }
        catch (OperationCanceledException) { }   // the connection was replaced or signed out meanwhile: the token below is still ours to forget
        catch (Exception error) { if (!life.IsCancellationRequested) model.ReportActionError(error.Message); }
        finally { if (origin is not null && held is not null && tokens.Load(origin) == held) tokens.Clear(origin); }   // only the token this sign-out began with: a newer login at the same address keeps its own
        return !life.IsCancellationRequested;
    }
}
