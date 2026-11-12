using System.Net.Sockets;
using System.Runtime.InteropServices;

namespace BellTeam.Linux;

// One window per user: the first instance listens on a Unix domain socket; a second launch connects, sends a byte and exits.
internal sealed class SingleInstance : IDisposable
{
    [DllImport("libc", EntryPoint = "getuid")] private static extern uint GetUid();
    private readonly Socket? listener;
    private readonly string path;
    private readonly CancellationTokenSource stop = new();
    public bool IsPrimary { get; }

    // $XDG_RUNTIME_DIR is already private to the user; without it the uid keeps users apart under /tmp.
    internal static string SocketPath(string? runtimeDirectory, uint uid) => string.IsNullOrEmpty(runtimeDirectory) ? $"/tmp/bellteam-{uid}.sock" : Path.Combine(runtimeDirectory, "bellteam.sock");

    public SingleInstance(Action activate) : this(SocketPath(Environment.GetEnvironmentVariable("XDG_RUNTIME_DIR"), GetUid()), activate) { }
    public SingleInstance(string path, Action activate)
    {
        this.path = path;
        for (var attempt = 0; attempt < 2; attempt++)
        {
            var candidate = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
            try { candidate.Bind(new UnixDomainSocketEndPoint(path)); candidate.Listen(4); listener = candidate; IsPrimary = true; break; }
            catch (SocketException) when (attempt == 0)
            {
                candidate.Dispose();
                // The path is taken: a live first instance answers; a connection refused means a stale file of a crashed one, which is removed once.
                try { Signal(path); return; }
                catch (SocketException) { File.Delete(path); }
            }
        }
        if (listener is null) throw new IOException("1利用者1窓の接続を作れませんでした: " + path);
        // Linux only: the connect permission of the socket is the user's alone (the guard is for the platform analyzer).
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        _ = ListenAsync(activate);
    }
    private static void Signal(string path)
    {
        using var client = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        client.Connect(new UnixDomainSocketEndPoint(path));
        client.Send([1]);
    }
    private async Task ListenAsync(Action activate)
    {
        while (!stop.IsCancellationRequested)
        {
            Socket client;
            try { client = await listener!.AcceptAsync(stop.Token); }
            catch (OperationCanceledException) when (stop.IsCancellationRequested) { return; }
            catch (ObjectDisposedException) { return; }
            catch (SocketException error) { Console.Error.WriteLine("既存の窓を開く接続に失敗しました。" + error.Message); return; }
            using (client)
            {
                try { if (await client.ReceiveAsync(new byte[1], stop.Token) != 0) activate(); }
                catch (OperationCanceledException) when (stop.IsCancellationRequested) { return; }
                // A client that vanished before its byte only loses its own raise request.
                catch (SocketException) { }
            }
        }
    }
    public void Dispose()
    {
        stop.Cancel(); listener?.Dispose(); stop.Dispose();
        if (IsPrimary) File.Delete(path);
    }
}
