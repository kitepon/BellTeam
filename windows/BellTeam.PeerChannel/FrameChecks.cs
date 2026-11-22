using System.Text;
using System.Text.Json;

namespace BellTeam.PeerChannel;

public enum AnswerCode { NotVerified, UnknownRequest, StaleVersion, AlreadyDecided, Replayed, ClockSkew, Invalid }
public enum RequestState { Open, Answered, Cancelled, Expired }

public sealed record OutboxRequest(RequestState State, long Rv, IReadOnlyList<byte[]> BodyHashes);

// The connector's view of one session when it judges a device frame (8.3). Delegates stand for the connector's registry copy and outbox.
public sealed record AnswerContext(byte[] Sid, byte[] PeerId, byte[] PeerSigPub, Func<string, bool> IsActiveDevice, Func<string, bool> Replayed, Func<string, OutboxRequest?> Request, long Now, Func<JsonElement, bool> Validate);

public sealed record ResultContext(byte[] Sid, byte[] ConnectorSigPub, Func<string, byte[]?> DeviceSigPub);

// The answer/hold/result/ack/registry-frame checks of contract 8.2-8.3 (a port of the second half of ts/src/frame.ts). Bodies are parsed only after the signature.
public static class FrameChecks
{
    public const long WindowMs = 10 * 60_000;

    private static JsonDocument? Parse(byte[] bytes)
    {
        try { return JsonDocument.Parse(new UTF8Encoding(false, true).GetString(bytes)); }
        catch (Exception error) when (error is JsonException or ArgumentException) { return null; }
    }
    private static string? Text(JsonElement e, string name) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    private static bool Number(JsonElement e, string name, out double value) { value = 0; return e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.TryGetDouble(out value); }

    // 8.3 at the connector, rows in the order of 0.4.7; the first that fails gives the code.
    public static (JsonDocument? Body, AnswerCode? Code) CheckAnswer(Frame f, AnswerContext c)
    {
        if (f.T != "answer" || !f.Verify(c.Sid, c.PeerSigPub)) return (null, AnswerCode.NotVerified);
        var doc = Parse(f.B);
        if (doc is null || Text(doc.RootElement, "rid") is not { } rid || Text(doc.RootElement, "id") is not { } id || Text(doc.RootElement, "request_hash") is not { } requestHash) { doc?.Dispose(); return (null, AnswerCode.Invalid); }
        var a = doc.RootElement;
        AnswerCode? code = Judge(a, rid, id, requestHash, c, hold: false);
        if (code is not null) { doc.Dispose(); return (null, code); }
        return (doc, null);
    }

    public static (JsonDocument? Body, AnswerCode? Code) CheckHold(Frame f, AnswerContext c)
    {
        if (f.T != "hold" || !f.Verify(c.Sid, c.PeerSigPub)) return (null, AnswerCode.NotVerified);
        var doc = Parse(f.B);
        if (doc is null || Text(doc.RootElement, "rid") is not { } rid || Text(doc.RootElement, "id") is not { } id || !doc.RootElement.TryGetProperty("held", out var held)
            || held.ValueKind is not (JsonValueKind.True or JsonValueKind.False) || !doc.RootElement.TryGetProperty("rv", out var rv) || !rv.TryGetInt64(out _)) { doc?.Dispose(); return (null, AnswerCode.Invalid); }
        var code = Judge(doc.RootElement, rid, id, null, c, hold: true);
        if (code is not null) { doc.Dispose(); return (null, code); }
        return (doc, null);
    }

    private static AnswerCode? Judge(JsonElement a, string rid, string id, string? requestHash, AnswerContext c, bool hold)
    {
        // Row 1: the signature was checked with the session key, so the body must name that key, and it must still be active.
        var keyId = Text(a, "device_key_id");
        if (keyId != Bytes.B64Url(c.PeerId) || !c.IsActiveDevice(keyId!)) return AnswerCode.NotVerified;
        if (c.Replayed(id)) return AnswerCode.Replayed;
        var r = c.Request(rid);
        if (r?.State == RequestState.Answered) return AnswerCode.AlreadyDecided;
        if (r is null || r.State != RequestState.Open) return AnswerCode.UnknownRequest;
        if (!hold)
        {
            byte[] hash;
            try { hash = Bytes.FromB64Url(requestHash!); } catch (FormatException) { return AnswerCode.Invalid; }
            if (!Number(a, "rv", out var rv) || rv != r.Rv || !r.BodyHashes.Any(h => h.AsSpan().SequenceEqual(hash))) return AnswerCode.StaleVersion;
        }
        else if (!Number(a, "rv", out var rv) || rv != r.Rv) return AnswerCode.StaleVersion;
        if (!Number(a, "at", out var at) || Math.Abs(c.Now - at) > WindowMs) return AnswerCode.ClockSkew;
        if (!hold && !c.Validate(a)) return AnswerCode.Invalid;
        return null;
    }

    public enum ResultCode { NotVerified, Invalid, AnswerNotVerified }

    // On the device: the result is signed by the connector, and its answer by the deciding device over answer_sid (N4).
    public static (JsonDocument? Body, JsonDocument? Answer, ResultCode? Code) CheckResult(Frame f, ResultContext c)
    {
        if (f.T != "result" || !f.Verify(c.Sid, c.ConnectorSigPub)) return (null, null, ResultCode.NotVerified);
        var doc = Parse(f.B);
        if (doc is null || Text(doc.RootElement, "rid") is not { } rid || Text(doc.RootElement, "status") is not { } status || !new[] { "answered", "cancelled", "expired", "closed" }.Contains(status)) { doc?.Dispose(); return (null, null, ResultCode.Invalid); }
        var r = doc.RootElement;
        if (status != "answered") return (doc, null, null);
        if (!r.TryGetProperty("answer_frame", out var answerFrame) || Text(r, "answer_sid") is not { } answerSidText || Text(r, "decided_by") is not { } decidedBy) { doc.Dispose(); return (null, null, ResultCode.Invalid); }
        Frame inner; byte[] answerSid;
        try
        {
            inner = new Frame(Text(answerFrame, "t")!, Bytes.FromB64Url(Text(answerFrame, "b")!), Bytes.FromB64Url(Text(answerFrame, "s")!));
            answerSid = Bytes.FromB64Url(answerSidText);
        }
        catch (Exception error) when (error is FormatException or NullReferenceException) { doc.Dispose(); return (null, null, ResultCode.Invalid); }
        var pub = c.DeviceSigPub(decidedBy);
        if (pub is null || inner.T != "answer" || !inner.Verify(answerSid, pub)) { doc.Dispose(); return (null, null, ResultCode.AnswerNotVerified); }
        var answer = Parse(inner.B);
        if (answer is null || Text(answer.RootElement, "rid") != rid || !Number(answer.RootElement, "rv", out var rv) || !Number(r, "final_rv", out var finalRv) || rv != finalRv || Text(answer.RootElement, "device_key_id") != decidedBy)
        { answer?.Dispose(); doc.Dispose(); return (null, null, ResultCode.AnswerNotVerified); }
        return (doc, answer, null);
    }

    // registry frame (0.4.5): an ordinary signed frame whose body is {id, at, snapshot}; the snapshot is judged by section 4 on its own.
    public static SignedSnapshot? RegistryFrameSnapshot(Frame f, byte[] sid, byte[] peerSigPub)
    {
        if (f.T != "registry" || !f.Verify(sid, peerSigPub)) return null;
        using var doc = Parse(f.B);
        if (doc is null || !doc.RootElement.TryGetProperty("snapshot", out var s)) return null;
        try { return new SignedSnapshot(Bytes.FromB64Url(Text(s, "body")!), Bytes.FromB64Url(Text(s, "signer")!), Bytes.FromB64Url(Text(s, "sig")!)); }
        catch (Exception error) when (error is FormatException or NullReferenceException) { return null; }
    }
}
