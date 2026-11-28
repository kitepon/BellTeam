using BellTeam.Core;

namespace BellTeam.Linux;

// Sign-out of a home server (app-sessions.md section 4; Windows MainWindow.EndHomeSessionAsync is the pattern): the app ends its own session (DELETE /api/home/sessions/{id}, the row the server marks current) and forgets the token.
// A refusal is shown; the token is forgotten either way. Linux and Android share it.
internal static class HomeSessionEnd
{
    public static async Task EndAsync(LinuxWorkspace model, ISessionTokenStore tokens)
    {
        if (!model.SessionLoginRequired || !model.Connected) return;
        try
        {
            var own = (await model.Planning.HomeSessionsAsync(model.ConnectionToken)).FirstOrDefault(session => session.Current);
            if (own is not null) await model.Planning.EndHomeSessionAsync(own.Id, model.ConnectionToken);
        }
        catch (Exception error) when (error is not OperationCanceledException) { model.ReportActionError(error.Message); }
        finally { if (Uri.TryCreate(model.Server, UriKind.Absolute, out var origin)) tokens.Clear(ServerOrigin.Parse(origin.AbsoluteUri)); }
    }
}
