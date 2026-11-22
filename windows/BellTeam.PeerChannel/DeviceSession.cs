using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;

namespace BellTeam.PeerChannel;

// A device's own keys: the signing key signs frames and envelopes, the sealing key opens the envelopes sent to it. Held by the app (DPAPI-backed on Windows), never by the server.
public sealed record DeviceIdentity(ECDsa SignKey, byte[] SigPub, byte[] SealPrivate, byte[] SealPublic)
{
    public byte[] KeyId => Keys.KeyId(SigPub);

    private static byte[] Point(ECParameters p) => [4, .. p.Q.X!, .. p.Q.Y!];

    public static DeviceIdentity Generate()
    {
        var sign = ECDsa.Create(ECCurve.NamedCurves.nistP256); var s = sign.ExportParameters(true);
        using var seal = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256); var h = seal.ExportParameters(true);
        return new DeviceIdentity(sign, Point(s), h.D!, Point(h));
    }

    // The plain key bytes (signing scalar, signing point, sealing scalar, sealing point), for the app's OS store; never written as they are.
    public byte[] Export() => [.. SignKey.ExportParameters(true).D!, .. SigPub, .. SealPrivate, .. SealPublic];

    public static DeviceIdentity Import(byte[] bytes)
    {
        if (bytes.Length != 32 + 65 + 32 + 65) throw new ArgumentException("not a device key record");
        var sigPub = bytes[32..97];
        return new DeviceIdentity(Keys.FromScalar(bytes[..32], sigPub), sigPub, bytes[97..129], bytes[129..]);
    }
}

// The connector this session dials, as its registry entry names it (base64url keys).
public sealed record ConnectorPeer(string KeyId, string SigPub, string SealPub, string ConnectionId);

public sealed record Wait(string WaitId, string ConnectionId);

public sealed record DeviceHello(long RegistryVersion, string RegistryHash, string Label, string[] Product);

public sealed record Received(string T, JsonDocument Body, byte[] Bytes, Frame Frame, IReadOnlyList<(BlobMeta Meta, byte[] Bytes)>? Blobs = null);

// The offerer side of 7.3: open the socket, join, dial a wait, exchange hello, then frames. Every native callback and socket message is posted to one loop, so state needs no locks. A port of ts/src/testing/device.ts as a product part.
public sealed class DeviceSession : IAsyncDisposable
{
    private readonly ServerAccess server; private readonly DeviceIdentity me; private readonly ConnectorPeer connector; private readonly DeviceHello hello; private readonly Func<string, byte[]?>? deviceKeys;
    private readonly HttpClient http = new();
    private readonly Channel<Action> loop = Channel.CreateUnbounded<Action>(new UnboundedChannelOptions { SingleReader = true });
    private readonly Task loopTask;
    private readonly CancellationTokenSource life = new();
    private readonly byte[] sid = RandomNumberGenerator.GetBytes(16);
    private SignalSocket? socket; private PeerConnection? pc; private DataChannelHandle? dc; private FrameChannel? frames;
    private Wait? wait; private ulong seq; private string localFp = "", remoteFp = "";
    private readonly HashSet<ulong> seen = [];
    private readonly BlobReceiver blobs = new();
    private readonly List<(Received Received, List<BlobMeta> Need, List<(BlobMeta, byte[])> Got)> pending = [];
    private readonly List<Received> inbox = [];
    private readonly List<(string T, TaskCompletionSource<Received> Source)> waiters = [];
    private readonly Queue<JsonDocument> signals = new();
    private readonly List<TaskCompletionSource<JsonDocument>> signalWaiters = [];
    private Task signalChain = Task.CompletedTask;
    private bool ended;

    public event Action<string>? Error; // a short code for the app to show; the session stays usable where it can
    public event Action<string>? Trace; // what happened, for the failure reason the app shows and for tests

    // Frames land in the inbox for NextAsync unless the app sets Delivered, which then takes every verified frame (and the session keeps no inbox).
    public event Action<Received>? Delivered;
    // The session is over (data channel closed, socket closed, pass ended); said once, with a short reason.
    public event Action<string>? Ended;
    private int endedOnce;
    private void End(string reason) { if (Interlocked.Exchange(ref endedOnce, 1) == 0) Ended?.Invoke(reason); }

    // deviceKeys resolves the signing key of any device of the registry (a result can carry another device's answer); without it only this device's own key is known.
    public DeviceSession(ServerAccess server, DeviceIdentity me, ConnectorPeer connector, DeviceHello hello, Func<string, byte[]?>? deviceKeys = null)
    {
        this.server = server; this.me = me; this.connector = connector; this.hello = hello; this.deviceKeys = deviceKeys;
        loopTask = Task.Run(async () => { await foreach (var action in loop.Reader.ReadAllAsync()) { try { action(); } catch (Exception error) { Error?.Invoke("loop:" + error.GetType().Name); } } });
    }

    private void Post(Action action) => loop.Writer.TryWrite(action);

    // Runs f on the session loop (where the channel is touched) and returns its value.
    public Task<T> OnLoop<T>(Func<T> f)
    {
        var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        Post(() => { try { tcs.SetResult(f()); } catch (Exception e) { tcs.SetException(e); } });
        return tcs.Task;
    }
    public byte[] Sid => sid;

    public async Task OpenAsync(CancellationToken ct)
    {
        socket = await SignalSocket.OpenAsync(server, ct);
        var opened = socket;
        opened.Closed += () => { if (opened.CloseCode == SignalSocket.PassEnded) Post(() => Error?.Invoke("pass_ended")); End(opened.CloseCode == SignalSocket.PassEnded ? "pass_ended" : "socket_closed"); };
        socket.Message += doc => Post(() =>
        {
            var type = doc.RootElement.GetProperty("type").GetString();
            if (type == "signal" && !doc.RootElement.TryGetProperty("verify_id", out _)) { _ = OnSignal(doc); return; }
            if (signalWaiters.Count > 0) { var w = signalWaiters[0]; signalWaiters.RemoveAt(0); w.SetResult(doc); } else signals.Enqueue(doc);
        });
    }

    private Task<JsonDocument> NextSignal()
    {
        var tcs = new TaskCompletionSource<JsonDocument>(TaskCreationOptions.RunContinuationsAsynchronously);
        Post(() => { if (signals.Count > 0) tcs.SetResult(signals.Dequeue()); else signalWaiters.Add(tcs); });
        return tcs.Task;
    }

    public async Task<IReadOnlyList<Wait>> JoinAsync(CancellationToken ct)
    {
        await socket!.SendAsync("{\"type\":\"join\"}", ct);
        while (true)
        {
            using var m = await NextSignal().WaitAsync(ct);
            if (m.RootElement.GetProperty("type").GetString() == "waits")
                return m.RootElement.GetProperty("waits").EnumerateArray().Select(w => new Wait(w.GetProperty("wait_id").GetString()!, w.GetProperty("connection_id").GetString()!)).ToList();
        }
    }

    // Dials the connector of a wait: offer, candidates, then the data channel and hello.
    public async Task DialAsync(Wait target, CancellationToken ct)
    {
        wait = target;
        var turn = await SignalHttp.FetchTurnAsync(http, server, ct);
        var peer = pc = new PeerConnection(await IceServers.SelectAsync(turn));
        peer.StateChanged += state => Trace?.Invoke("pc state " + state);
        peer.LocalDescription += (sdp, type) => Post(() => { localFp = Sdp.Fingerprint(sdp) ?? ""; Signal(type == "offer" ? "offer" : "answer", "\"sdp\":" + JsonSerializer.Serialize(sdp)); });
        peer.LocalCandidate += candidate => Post(() => Signal("candidate", "\"candidate\":" + JsonSerializer.Serialize(candidate)));
        var channel = dc = peer.CreateDataChannel(Sdp.ChannelLabel);
        channel.Closed += () => { Trace?.Invoke("data channel closed"); End("channel_closed"); };
        channel.Opened += () => Post(() =>
        {
            Trace?.Invoke("data channel open");
            frames = new FrameChannel(channel);
            frames.FrameReceived += (f, bytes) => Post(() => OnFrame(f, bytes));
            frames.BlobReceived += bytes => Post(() => OnBlob(bytes));
            frames.Limit += () => Post(() => { Error?.Invoke("limit"); });
            Send("hello", Json(("id", Id()), ("at", Now()), ("sid", Bytes.B64Url(sid)), ("self_fp", localFp), ("peer_fp", remoteFp), ("key_id", Bytes.B64Url(me.KeyId)),
                ("registry_version", hello.RegistryVersion), ("registry_hash", hello.RegistryHash), ("label", hello.Label), ("product", hello.Product)));
        });
        peer.SetLocalDescription();
    }

    private static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    private static string Id() => Bytes.B64Url(RandomNumberGenerator.GetBytes(16));
    private static string Json(params (string Key, object? Value)[] fields) => "{" + string.Join(",", fields.Select(f => JsonSerializer.Serialize(f.Key) + ":" + JsonSerializer.Serialize(f.Value))) + "}";

    // Seals one signaling envelope; the sequence number is taken here, in call order, and the sends are chained so they leave in that order.
    private void Signal(string kind, string field)
    {
        var number = seq++; var plain = "{\"kind\":\"" + kind + "\"," + field + ",\"ts\":" + Now() + "}";
        var target = wait!;
        signalChain = signalChain.ContinueWith(async _ =>
        {
            var e = Envelope.Seal(me.SignKey, me.KeyId, Bytes.FromB64Url(connector.KeyId), Bytes.FromB64Url(connector.SealPub), sid, number, plain);
            await socket!.SendAsync("{\"type\":\"signal\",\"wait_id\":\"" + target.WaitId + "\",\"to\":" + JsonSerializer.Serialize(target.ConnectionId) + ",\"env\":" + e.ToJson() + "}", life.Token);
        }, TaskScheduler.Default).Unwrap();
    }

    private sealed class Receiver(DeviceSession s) : IEnvelopeReceiver
    {
        public byte[] Me => s.me.KeyId; public byte[] SealPrivate => s.me.SealPrivate; public byte[] SealPublic => s.me.SealPublic; public long Now => DeviceSession.Now();
        public byte[]? SenderSigPub(byte[] from) => Bytes.B64Url(from) == s.connector.KeyId ? Bytes.FromB64Url(s.connector.SigPub) : null;
        public bool SeqUsed(byte[] from, byte[] sid, ulong seq) => s.seen.Contains(seq);
        public void RecordSeq(byte[] from, byte[] sid, ulong seq) => s.seen.Add(seq);
    }

    private async Task OnSignal(JsonDocument m)
    {
        using var _ = m;
        Envelope envelope;
        try { envelope = Envelope.FromJson(m.RootElement.GetProperty("env")); } catch (Exception e) when (e is KeyNotFoundException or FormatException or InvalidOperationException) { return; }
        await Task.Yield();
        var (plain, drop) = EnvelopeOpener.Open(envelope, new Receiver(this));
        if (drop is not null || ended) { plain?.Dispose(); return; }
        Post(() =>
        {
            using (plain)
            {
                var p = plain!.RootElement; var kind = p.GetProperty("kind").GetString();
                if (kind == "answer" && p.TryGetProperty("sdp", out var sdp)) { remoteFp = Sdp.Fingerprint(sdp.GetString()!) ?? ""; pc!.SetRemoteDescription(sdp.GetString()!, "answer"); }
                if (kind == "candidate" && p.TryGetProperty("candidate", out var c)) pc!.AddRemoteCandidate(c.GetString()!, Sdp.Mid(pc.LocalSdp));
            }
        });
    }

    public Frame Send(string type, string bodyJson)
    {
        var frame = Frame.Sign(me.SignKey, type, sid, Encoding.UTF8.GetBytes(bodyJson));
        frames!.Send(frame);
        return frame;
    }

    private void OnFrame(Frame f, byte[] bytes)
    {
        Trace?.Invoke("frame " + f.T);
        if (!f.Verify(sid, Bytes.FromB64Url(connector.SigPub))) return;
        var received = new Received(f.T, JsonDocument.Parse(f.B), bytes, f);
        var metas = f.T is "request" or "amend" && received.Body.RootElement.TryGetProperty("blobs", out var list) ? BlobMeta.CheckList(list) : [];
        if (metas is { Count: > 0 }) { blobs.Expect(metas, DateTimeOffset.UtcNow); pending.Add((received, metas.ToList(), [])); return; }
        Deliver(received);
    }

    // A request/amend that names blobs is handed on only when they all arrived complete (0.5.2).
    private void OnBlob(byte[] message)
    {
        if (blobs.Accept(message, out var blobId, out var data) != BlobReceiver.Outcome.Complete) return;
        var item = pending.FirstOrDefault(p => p.Need.Any(m => m.BlobId == blobId));
        if (item.Received is null) return;
        item.Got.Add((item.Need.First(m => m.BlobId == blobId), data!));
        if (item.Got.Count < item.Need.Count) return;
        pending.Remove(item);
        Deliver(item.Received with { Blobs = item.Need.Select(m => item.Got.First(g => g.Item1.BlobId == m.BlobId)).ToList() });
    }

    private void Deliver(Received r)
    {
        if (Delivered is not null) { Delivered(r); return; }
        var i = waiters.FindIndex(w => w.T == r.T);
        if (i >= 0) { var w = waiters[i]; waiters.RemoveAt(i); w.Source.SetResult(r); } else inbox.Add(r);
    }

    // The next frame of this type (frames of other types wait in the inbox).
    public Task<Received> NextAsync(string type, TimeSpan timeout)
    {
        var tcs = new TaskCompletionSource<Received>(TaskCreationOptions.RunContinuationsAsynchronously);
        Post(() => { var i = inbox.FindIndex(r => r.T == type); if (i >= 0) { tcs.SetResult(inbox[i]); inbox.RemoveAt(i); } else waiters.Add((type, tcs)); });
        return tcs.Task.WaitAsync(timeout);
    }

    public void Ack(string of, string result = "ok") => Send("ack", Json(("id", Id()), ("at", Now()), ("of", of), ("result", result)));

    public Frame Answer(Received request, string schema, string contentJson) => Answer(request.Body.RootElement.GetProperty("rid").GetString()!, request.Body.RootElement.GetProperty("rv").GetInt64(), request.Frame.B, schema, contentJson);

    // The answer to the request version whose exact body bytes the person saw (the book keeps them).
    public Frame Answer(string rid, long rv, byte[] requestBody, string schema, string contentJson)
    {
        return Send("answer", "{" + string.Join(",", [
            "\"id\":" + JsonSerializer.Serialize(Id()), "\"at\":" + Now(), "\"rid\":" + JsonSerializer.Serialize(rid), "\"rv\":" + rv,
            "\"request_hash\":" + JsonSerializer.Serialize(Bytes.B64Url(Frame.RequestHash(requestBody))), "\"schema\":" + JsonSerializer.Serialize(schema), "\"content\":" + contentJson, "\"blobs\":[]",
            "\"device_key_id\":" + JsonSerializer.Serialize(Bytes.B64Url(me.KeyId))]) + "}");
    }

    public Frame Hold(Received request, bool held) => Hold(request.Body.RootElement.GetProperty("rid").GetString()!, request.Body.RootElement.GetProperty("rv").GetInt64(), held);

    public Frame Hold(string rid, long rv, bool held)
    {
        return Send("hold", "{\"id\":" + JsonSerializer.Serialize(Id()) + ",\"at\":" + Now() + ",\"rid\":" + JsonSerializer.Serialize(rid) + ",\"rv\":" + rv + ",\"held\":" + (held ? "true" : "false") + ",\"device_key_id\":" + JsonSerializer.Serialize(Bytes.B64Url(me.KeyId)) + "}");
    }

    public (JsonDocument? Body, JsonDocument? Answer, FrameChecks.ResultCode? Code) CheckResult(Received result) =>
        FrameChecks.CheckResult(result.Frame, new ResultContext(sid, Bytes.FromB64Url(connector.SigPub), id => id == Bytes.B64Url(me.KeyId) ? me.SigPub : deviceKeys?.Invoke(id)));

    public string LocalFingerprint => localFp;
    public string RemoteFingerprint => remoteFp;

    public async ValueTask DisposeAsync()
    {
        ended = true; life.Cancel();
        dc?.Close(); pc?.Dispose();
        if (socket is not null) await socket.DisposeAsync();
        loop.Writer.TryComplete(); await loopTask;
        http.Dispose(); life.Dispose();
    }
}
