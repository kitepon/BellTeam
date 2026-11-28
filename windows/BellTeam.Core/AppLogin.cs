namespace BellTeam.Core;

// The session token the server issued (app-sessions.md section 4), kept per server address; each app supplies its own safe place (Linux: a 0600 file, Android: Keystore-backed, Windows: DPAPI).
public interface ISessionTokenStore
{
    string? Load(Uri origin);
    void Save(Uri origin, string token);
    void Clear(Uri origin);
}
