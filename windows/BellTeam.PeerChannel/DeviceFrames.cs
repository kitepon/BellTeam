using System.Text.Json;

namespace BellTeam.PeerChannel;

// What the device does with one verified frame from a connector (contract 8.2, 8.4): keep it in the book and say which ack it gets. Pure apart from the book.
public static class DeviceFrames
{
    // The "of" of an ack: the frame's own id (base64url, in its body).
    public static string? IdOf(Received r) => r.Body.RootElement.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String ? id.GetString() : null;

    // Returns the ack result to send ("ok" or "refused:<code>"), or null when the frame type takes no ack from the device (hello, registry, ack, bye, blob).
    public static string? Handle(Received r, DecisionBook book, Func<Received, (JsonDocument? Body, JsonDocument? Answer, FrameChecks.ResultCode? Code)> checkResult, long now, Action<BlobMeta, byte[]>? keepBlob = null)
    {
        switch (r.T)
        {
            case "request" or "amend":
                if (r.Blobs is { Count: > 0 } blobs) foreach (var (meta, bytes) in blobs) keepBlob?.Invoke(meta, bytes);   // kept before the book names them
                return book.Apply(r.T, r.Body.RootElement, r.Frame.B, now, r.Blobs?.Select(b => b.Meta).ToList());
            case "cancel":
                return book.Apply(r.T, r.Body.RootElement, r.Frame.B, now);
            case "result":
                var (body, answer, code) = checkResult(r);
                try
                {
                    if (code is not null) return code == FrameChecks.ResultCode.Invalid ? "refused:invalid" : "refused:not_verified";
                    var b = body!.RootElement;
                    JsonElement? content = answer is not null && answer.RootElement.TryGetProperty("content", out var c) ? c.Clone() : null;
                    book.Close(b.GetProperty("rid").GetString()!, b.GetProperty("status").GetString()!, content, b.TryGetProperty("decided_by", out var d) && d.ValueKind == JsonValueKind.String ? d.GetString()! : "", now);
                    return "ok";
                }
                finally { body?.Dispose(); answer?.Dispose(); }
            default: return null;
        }
    }
}
