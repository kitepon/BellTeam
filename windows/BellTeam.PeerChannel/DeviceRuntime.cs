using System.Text.Json;

namespace BellTeam.PeerChannel;

public enum RuntimeStatus { Stopped, Connecting, Live, Retrying, NeedsAdmission, SignedOut, NotEntitled }
public sealed record RuntimeState(RuntimeStatus Status, string? Reason = null);
// What the connector said to an answer or hold: "ok", "refused:<code>", or "unknown" (no ack within the wait; the frame is never sent again by itself).
public sealed record SendOutcome(string Ack);
public sealed class NoSessionException() : InvalidOperationException("no_session");
// The Access seam throws this when the person is not signed in to Approval Box (no pass in its own store): the state is SignedOut, left by Refresh after a sign-in.
public sealed class SignedOutException() : InvalidOperationException("signed_out");

// Keeps this device connected to the connectors that wait for it and feeds the DecisionBook (design peer-channel-v0.2 section 7). Everything about the registry (trust, genesis, admission) is the caller's: it hands over the holder.
public sealed class DeviceRuntime : IAsyncDisposable
{
    public sealed record Setup(DeviceIdentity Me, string Label, Func<CancellationToken, Task<ServerAccess>> Access, Func<ServerAccess, CancellationToken, Task<Holder?>> Registry, DecisionBook Book,
        Func<TimeSpan, CancellationToken, Task>? Delay = null, Func<double>? Random = null);

    private sealed class Live(string waitId) { public string WaitId = waitId; public DeviceSession? Session; public volatile bool GotFrame; public readonly TaskCompletionSource Hello = new(TaskCreationOptions.RunContinuationsAsynchronously); }

    public static readonly TimeSpan HelloWait = TimeSpan.FromSeconds(30), AckWait = TimeSpan.FromSeconds(20);
    private readonly Setup s;
    private readonly object gate = new();
    private readonly Dictionary<string, Live> owner = []; // rid -> the session that delivered it
    private readonly Dictionary<string, string> acked = []; // frame id -> ack result that arrived before anyone waited
    private readonly Dictionary<string, TaskCompletionSource<string>> ackWaiters = [];
    private readonly HashSet<string> dialing = [];
    private CancellationTokenSource? run; private Task loop = Task.CompletedTask;
    private TaskCompletionSource kick = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public RuntimeState State { get; private set; } = new(RuntimeStatus.Stopped);
    public DecisionBook Book => s.Book;
    public event Action? StateChanged;
    public event Action<string>? Trace;

    public DeviceRuntime(Setup setup) => s = setup;

    public void Start() { if (run is not null) return; var source = run = new CancellationTokenSource(); loop = RunAsync(source.Token); }
    // Manual retry: the waiting attempt runs now (never a second loop). Also how a stopped state (NeedsAdmission, SignedOut) is left.
    public void Refresh() { lock (gate) { var old = kick; kick = new(TaskCreationOptions.RunContinuationsAsynchronously); old.TrySetResult(); } }

    private void Set(RuntimeStatus status, string? reason = null) { State = new(status, reason); StateChanged?.Invoke(); }
    // The wait before the next try: 1, 2, 4 ... 30 s, +-20%, never a cap on the number of tries.
    public static TimeSpan Backoff(int attempt, Func<double>? random = null) => TimeSpan.FromMilliseconds(Math.Min(30000, Math.Min(30000, 1000 * Math.Pow(2, Math.Max(0, attempt))) * (0.8 + 0.4 * (random ?? Random.Shared.NextDouble)())));

    private async Task Pause(TimeSpan? delay, CancellationToken ct)
    {
        Task now; lock (gate) now = kick.Task;
        var timer = delay is { } d ? (s.Delay ?? Task.Delay)(d, ct) : Task.Delay(Timeout.Infinite, ct);
        await Task.WhenAny(now, timer); ct.ThrowIfCancellationRequested();
    }

    private async Task RunAsync(CancellationToken ct)
    {
        var attempt = 0;
        while (!ct.IsCancellationRequested)
        {
            string reason;
            try
            {
                Set(RuntimeStatus.Connecting);
                var access = await s.Access(ct);
                if (await s.Registry(access, ct) is not { } holder) { Set(RuntimeStatus.NeedsAdmission, "not_verified"); await Pause(null, ct); attempt = 0; continue; }
                using var cycle = CancellationTokenSource.CreateLinkedTokenSource(ct);
                var closed = new TaskCompletionSource<int?>(TaskCreationOptions.RunContinuationsAsynchronously);
                await using var socket = await SignalSocket.OpenAsync(access, ct);
                socket.Closed += () => closed.TrySetResult(socket.CloseCode);
                socket.Message += doc => Watch(doc, holder, access, cycle.Token);
                await socket.SendAsync("{\"type\":\"join\"}", ct);
                Set(RuntimeStatus.Live); attempt = 0;
                var code = await closed.Task.WaitAsync(ct);
                cycle.Cancel();
                if (code == SignalSocket.PassEnded) { Set(RuntimeStatus.SignedOut, "pass_ended"); await Pause(null, ct); attempt = 0; continue; }
                reason = "socket_closed";
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            catch (SignedOutException) { Set(RuntimeStatus.SignedOut, "signed_out"); try { await Pause(null, ct); } catch (OperationCanceledException) { break; } attempt = 0; continue; }
            // An abnormal setting or answer is shown with its reason and tried again later, never a reason to stop (project rule on recoverable failures).
            catch (Exception error) { reason = error.GetType().Name + ": " + error.Message; }
            Set(RuntimeStatus.Retrying, reason);
            try { await Pause(Backoff(attempt++, s.Random), ct); } catch (OperationCanceledException) { break; }
        }
        Set(RuntimeStatus.Stopped);
    }

    private void Watch(JsonDocument doc, Holder holder, ServerAccess access, CancellationToken ct)
    {
        using (doc)
        {
            var root = doc.RootElement; var type = root.GetProperty("type").GetString();
            if (type == "waits") foreach (var w in root.GetProperty("waits").EnumerateArray()) Dial(new(w.GetProperty("wait_id").GetString()!, w.GetProperty("connection_id").GetString()!), holder, access, ct);
            else if (type == "error" && root.TryGetProperty("of", out var of) && of.GetString() == "join" && root.TryGetProperty("code", out var code) && code.GetString() is "no_entitlement" or "not_entitled") Set(RuntimeStatus.NotEntitled, code.GetString());
            else if (type == "wait.available") Dial(new(root.GetProperty("wait_id").GetString()!, root.GetProperty("connection_id").GetString()!), holder, access, ct);
        }
    }

    private void Dial(Wait wait, Holder holder, ServerAccess access, CancellationToken ct)
    {
        lock (gate) if (!dialing.Add(wait.WaitId)) return;
        _ = Task.Run(async () => { try { await SessionAsync(wait, holder, access, ct); } catch (Exception e) when (e is OperationCanceledException || ct.IsCancellationRequested) { } catch (Exception e) { Trace?.Invoke("session " + e.GetType().Name + ": " + e.Message); } finally { lock (gate) dialing.Remove(wait.WaitId); } });
    }

    // One connector's wait. After a session that got frames the wait is dialed again after a backoff; one that never got a hello is dropped (the wait is gone; a new wait.available brings it back).
    private async Task SessionAsync(Wait wait, Holder holder, ServerAccess access, CancellationToken ct)
    {
        var attempt = 0;
        while (!ct.IsCancellationRequested)
        {
            var entry = holder.Active.Values.FirstOrDefault(e => !e.IsDevice && e.ConnectionId == wait.ConnectionId);
            if (entry is null) { Trace?.Invoke("unknown connector " + wait.ConnectionId); return; }
            var live = new Live(wait.WaitId); var ended = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
            var hello = new DeviceHello(holder.Version, Bytes.B64Url(Convert.FromHexString(holder.Heads[0].Hash)), s.Label, [DecisionBook.DecisionSchema]);
            await using var session = new DeviceSession(access, s.Me, new ConnectorPeer(entry.KeyId, entry.SigPub, entry.SealPub, wait.ConnectionId), hello,
                id => holder.Active.TryGetValue(id, out var e) && e.IsDevice ? Bytes.FromB64Url(e.SigPub) : null);
            live.Session = session;
            session.Delivered += r => OnFrame(live, r);
            session.Ended += reason => ended.TrySetResult(reason);
            session.Trace += t => Trace?.Invoke(t);
            session.Error += e => { Trace?.Invoke("error " + e); if (e == "pass_ended") ended.TrySetResult(e); };
            await session.OpenAsync(ct); await session.JoinAsync(ct); await session.DialAsync(wait, ct);
            try { await live.Hello.Task.WaitAsync(HelloWait, ct); } catch (TimeoutException) { Trace?.Invoke("no hello from " + wait.ConnectionId); return; }
            await ended.Task.WaitAsync(ct);
            lock (gate) foreach (var rid in owner.Where(p => p.Value == live).Select(p => p.Key).ToList()) owner.Remove(rid);
            if (!live.GotFrame) return;
            await (s.Delay ?? Task.Delay)(Backoff(attempt++, s.Random), ct);
        }
    }

    private void OnFrame(Live live, Received r)
    {
        live.GotFrame = true;
        try
        {
            if (r.T == "hello") { live.Hello.TrySetResult(); return; }
            if (r.T == "ack") { Acked(r); return; }
            var result = DeviceFrames.Handle(r, s.Book, live.Session!.CheckResult, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            if (r.T is "request" or "amend" && result == "ok" && r.Body.RootElement.TryGetProperty("rid", out var rid)) lock (gate) owner[rid.GetString()!] = live;
            if (result is not null && DeviceFrames.IdOf(r) is { } id) live.Session.Ack(id, result);
        }
        finally { r.Body.Dispose(); }
    }

    private void Acked(Received r)
    {
        var b = r.Body.RootElement;
        if (!b.TryGetProperty("of", out var of) || of.GetString() is not { } id) return;
        var result = b.TryGetProperty("result", out var res) && res.GetString() is { } text ? text : "refused:invalid";
        lock (gate) { if (ackWaiters.Remove(id, out var w)) w.TrySetResult(result); else acked[id] = result; }
    }

    private async Task<SendOutcome> SendAsync(string rid, Func<DeviceSession, Frame> make)
    {
        Live live; lock (gate) { if (!owner.TryGetValue(rid, out live!)) throw new NoSessionException(); }
        var frame = await live.Session!.OnLoop(() => make(live.Session));
        using var body = JsonDocument.Parse(frame.B); var id = body.RootElement.GetProperty("id").GetString()!;
        TaskCompletionSource<string>? waiter = null;
        lock (gate) { if (acked.Remove(id, out var early)) return new(early); ackWaiters[id] = waiter = new(TaskCreationOptions.RunContinuationsAsynchronously); }
        try { return new(await waiter.Task.WaitAsync(AckWait)); }
        catch (TimeoutException) { lock (gate) ackWaiters.Remove(id); return new("unknown"); }
    }

    // Answers the open decision with an option and/or text. Non-idempotent: a timeout is "unknown" and nothing is resent by itself.
    public async Task<SendOutcome> AnswerAsync(string decisionId, string? optionId, string? text)
    {
        var e = s.Book.FindByDecision(decisionId) ?? throw new KeyNotFoundException(decisionId);
        if (!e.IsOpen) throw new InvalidOperationException("closed");
        if ((optionId is null && string.IsNullOrEmpty(text)) || (optionId is not null && !e.Options.Any(o => o.Id == optionId)) || text?.Length > 5000) throw new ArgumentException("answer is not valid for this decision");
        var content = "{" + string.Join(",", new[] { optionId is null ? null : "\"option_id\":" + JsonSerializer.Serialize(optionId), string.IsNullOrEmpty(text) ? null : "\"text\":" + JsonSerializer.Serialize(text) }.Where(x => x is not null)) + "}";
        return await SendAsync(e.Rid, session => session.Answer(e.Rid, e.Rv, e.Body, DecisionBook.AnswerSchema, content));
    }

    public async Task<SendOutcome> HoldAsync(string decisionId, bool held)
    {
        var e = s.Book.FindByDecision(decisionId) ?? throw new KeyNotFoundException(decisionId);
        if (!e.IsOpen) throw new InvalidOperationException("closed");
        var outcome = await SendAsync(e.Rid, session => session.Hold(e.Rid, e.Rv, held));
        if (outcome.Ack == "ok") s.Book.SetHeld(e.Rid, held, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        return outcome;
    }

    public async ValueTask DisposeAsync()
    {
        var source = run; run = null;
        if (source is null) return;
        source.Cancel();
        try { await loop; } catch (OperationCanceledException) { }
        source.Dispose();
    }
}
