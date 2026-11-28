using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace BellTeam.PeerChannel;

// Client side of /pc/v1 (docs/signaling.md of peer-channel): the signaling socket and the mirror / TURN calls. A port of ts/src/signal-client.ts.
// Url = http(s)://host:port; Headers carry the pass (Authorization: Bearer ...). No retry here: the owner of the session reconnects with backoff (contract 13).
public sealed record ServerAccess(Uri Url, IReadOnlyDictionary<string, string> Headers);

public sealed record TurnCredentials(string[] Urls, string Username, string Credential, int Ttl);

// A refused /pc/v1/turn: 403 carries the product's not_entitled code in "error" (docs/signaling.md 3), 429 rate_limited, 503 turn_unavailable.
public sealed class TurnRefusedException(int status, string code) : HttpRequestException("turn " + status + " " + code)
{
    public int Status { get; } = status;
    public string Code { get; } = code;
}

public static class SignalHttp
{
    private static HttpRequestMessage Request(ServerAccess a, HttpMethod method, string path, HttpContent? body = null)
    {
        var request = new HttpRequestMessage(method, new Uri(a.Url, path)) { Content = body };
        foreach (var (name, value) in a.Headers) request.Headers.TryAddWithoutValidation(name, value);
        return request;
    }

    public static async Task<IReadOnlyList<SignedSnapshot>> FetchMirrorAsync(HttpClient http, ServerAccess a, CancellationToken ct)
    {
        using var response = await http.SendAsync(Request(a, HttpMethod.Get, "/pc/v1/registry"), ct);
        if ((int)response.StatusCode == 401) throw new SignedOutException("pass_ended"); // a 401 from any /pc/v1 call is the same as 4401
        if (!response.IsSuccessStatusCode) throw new HttpRequestException("mirror " + (int)response.StatusCode);
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
        return doc.RootElement.GetProperty("slots").EnumerateArray()
            .Select(s => new SignedSnapshot(Bytes.FromB64Url(s.GetProperty("body").GetString()!), Bytes.FromB64Url(s.GetProperty("signer").GetString()!), Bytes.FromB64Url(s.GetProperty("sig").GetString()!))).ToList();
    }

    // The error code of a refused upload (registry_stale, mirror_full, ...) or null when it was accepted.
    public static async Task<string?> PutMirrorAsync(HttpClient http, ServerAccess a, SignedSnapshot s, CancellationToken ct)
    {
        var json = "{\"body\":\"" + Bytes.B64Url(s.Body) + "\",\"signer\":\"" + Bytes.B64Url(s.Signer) + "\",\"sig\":\"" + Bytes.B64Url(s.Sig) + "\"}";
        using var response = await http.SendAsync(Request(a, HttpMethod.Put, "/pc/v1/registry", new StringContent(json, Encoding.UTF8, "application/json")), ct);
        if ((int)response.StatusCode == 401) throw new SignedOutException("pass_ended");
        if (response.IsSuccessStatusCode) return null;
        try { using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct)); return doc.RootElement.GetProperty("error").GetString(); }
        catch (Exception error) when (error is JsonException or KeyNotFoundException) { return ((int)response.StatusCode).ToString(); }
    }

    public static async Task<TurnCredentials> FetchTurnAsync(HttpClient http, ServerAccess a, CancellationToken ct)
    {
        using var response = await http.SendAsync(Request(a, HttpMethod.Post, "/pc/v1/turn"), ct);
        if ((int)response.StatusCode == 401) throw new SignedOutException("pass_ended");
        if (!response.IsSuccessStatusCode)
        {
            var code = "";
            try { code = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct)).RootElement.GetProperty("error").GetString() ?? ""; }
            catch (Exception error) when (error is JsonException or KeyNotFoundException or InvalidOperationException) { }
            throw new TurnRefusedException((int)response.StatusCode, code);
        }
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct)); var r = doc.RootElement;
        return new TurnCredentials(r.GetProperty("urls").EnumerateArray().Select(u => u.GetString()!).ToArray(), r.GetProperty("username").GetString()!, r.GetProperty("credential").GetString()!, r.GetProperty("ttl").GetInt32());
    }
}

// One signaling socket. Messages are the JSON objects of docs/signaling.md, one per text frame, at most 8 KiB; binary frames are ignored.
public sealed class SignalSocket : IAsyncDisposable
{
    public const int MaxMessageBytes = 8 * 1024;
    public const int AccountDeleted = 4410; // the person's Approval Box account was deleted: signed out, this instance's pass and device keys are cleared (Delta/Nayuta, signin design)
    public const int PassEnded = 4401; // the server ended the device's pass: the owner treats it as signed out, not as a network drop
    public int? CloseCode => (int?)socket.CloseStatus;
    private readonly ClientWebSocket socket;
    private readonly CancellationTokenSource life = new();
    private Task? reader;
    public event Action<JsonDocument>? Message;
    public event Action? Closed;

    private SignalSocket(ClientWebSocket socket) => this.socket = socket;

    public static async Task<SignalSocket> OpenAsync(ServerAccess a, CancellationToken ct)
    {
        var ws = new ClientWebSocket();
        foreach (var (name, value) in a.Headers) ws.Options.SetRequestHeader(name, value);
        var builder = new UriBuilder(new Uri(a.Url, "/pc/v1/signal")) { Scheme = a.Url.Scheme == "https" ? "wss" : "ws" };
        await ws.ConnectAsync(builder.Uri, ct);
        var s = new SignalSocket(ws);
        return s;
    }

    // The read loop starts only here, after the owner attached Message and Closed: a frame or close that arrives first would otherwise be dropped.
    public void Start() => reader ??= ReadLoop();

    private async Task ReadLoop()
    {
        var buffer = new byte[MaxMessageBytes + 1024];
        try
        {
            while (socket.State == WebSocketState.Open && !life.IsCancellationRequested)
            {
                var length = 0; ValueWebSocketReceiveResult result;
                do
                {
                    result = await socket.ReceiveAsync(buffer.AsMemory(length), life.Token);
                    length += result.Count;
                } while (!result.EndOfMessage && length < buffer.Length);
                if (result.MessageType == WebSocketMessageType.Close || !result.EndOfMessage) break; // a message over the 8 KiB limit ends the socket
                if (result.MessageType != WebSocketMessageType.Text) continue;
                JsonDocument doc;
                try { doc = JsonDocument.Parse(buffer.AsMemory(0, length)); } catch (JsonException) { continue; }
                Message?.Invoke(doc);
            }
        }
        catch (Exception) { /* a failed socket closes; the owner reconnects with backoff (13) */ }
        finally { Closed?.Invoke(); }
    }

    public async Task SendAsync(string json, CancellationToken ct)
    {
        if (socket.State == WebSocketState.Open) await socket.SendAsync(Encoding.UTF8.GetBytes(json), WebSocketMessageType.Text, true, ct);
    }

    public async ValueTask DisposeAsync()
    {
        life.Cancel();
        try { if (socket.State == WebSocketState.Open) await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, CancellationToken.None); } catch (WebSocketException) { }
        if (reader is not null) await reader;
        socket.Dispose(); life.Dispose();
    }
}
