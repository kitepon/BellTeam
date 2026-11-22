using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

namespace BellTeam.PeerChannel;

// WebRTC data channel pieces of contract 7.3 and 8.1 on libdatachannel (see Native.cs). A port of ts/src/webrtc.ts.
public static partial class Sdp
{
    public const string ChannelLabel = "peer-channel/1";

    [GeneratedRegex(@"^a=fingerprint:sha-256 ([0-9A-Fa-f:]{95})\s*$", RegexOptions.Multiline)]
    private static partial Regex FingerprintLine();
    [GeneratedRegex(@"^a=mid:(\S+)", RegexOptions.Multiline)]
    private static partial Regex MidLine();

    // The SDP's a=fingerprint:sha-256 value as lowercase hex without colons (64 chars), the form hello carries.
    public static string? Fingerprint(string sdp) => FingerprintLine().Match(sdp) is { Success: true } m ? m.Groups[1].Value.Replace(":", "").ToLowerInvariant() : null;

    // First media id of an SDP; candidates in the envelope carry no mid (6.4), and a data-channel-only SDP has one.
    public static string Mid(string sdp) => MidLine().Match(sdp) is { Success: true } m ? m.Groups[1].Value : "0";
}

// One peer connection with a fresh DTLS certificate (libdatachannel makes one per connection). Callbacks arrive on libdatachannel's threads; the owner posts them to its own loop.
internal sealed class PeerConnection : IDisposable
{
    private readonly int pc;
    private readonly List<object> pinned = []; // the native side keeps raw pointers to these delegates
    private readonly List<IntPtr> iceStrings = [];
    private IntPtr iceArray;
    public event Action<string, string>? LocalDescription;   // sdp, type
    public event Action<string>? LocalCandidate;
    public event Action<Native.State>? StateChanged;
    public string LocalSdp { get; private set; } = "";

    private static string Text(IntPtr pointer) => Marshal.PtrToStringUTF8(pointer) ?? "";

    // TURN/STUN of the server's answer as libdatachannel URLs: turn:user:pass@host:port?transport=...; user and password are percent-encoded.
    private static IEnumerable<string> IceUrls(TurnCredentials? turn) => (turn?.Urls ?? []).Select(u =>
        u.StartsWith("stun:", StringComparison.Ordinal) ? u : u.Replace(":", ":" + Uri.EscapeDataString(turn!.Username) + ":" + Uri.EscapeDataString(turn.Credential) + "@", StringComparison.Ordinal).Replace("::", ":"));

    public PeerConnection(TurnCredentials? turn)
    {
        var urls = IceUrls(turn).ToArray();
        var config = new Native.Configuration();
        if (urls.Length > 0)
        {
            iceArray = Marshal.AllocHGlobal(IntPtr.Size * urls.Length);
            for (var i = 0; i < urls.Length; i++) { var s = Marshal.StringToCoTaskMemUTF8(urls[i]); iceStrings.Add(s); Marshal.WriteIntPtr(iceArray, i * IntPtr.Size, s); }
            config.IceServers = iceArray; config.IceServersCount = urls.Length;
        }
        pc = Native.rtcCreatePeerConnection(ref config);
        if (pc < 0) throw new InvalidOperationException("rtcCreatePeerConnection failed: " + pc);
        Native.DescriptionCallback description = (_, sdp, type, _) => { LocalSdp = Text(sdp); LocalDescription?.Invoke(LocalSdp, Text(type)); };
        Native.CandidateCallback candidate = (_, cand, _, _) => LocalCandidate?.Invoke(Text(cand));
        Native.StateCallback state = (_, s, _) => StateChanged?.Invoke(s);
        pinned.AddRange([description, candidate, state]);
        Native.rtcSetLocalDescriptionCallback(pc, description); Native.rtcSetLocalCandidateCallback(pc, candidate); Native.rtcSetStateChangeCallback(pc, state);
    }

    public DataChannelHandle CreateDataChannel(string label)
    {
        var init = new Native.DataChannelInit(); // ordered and reliable by default
        var id = Native.rtcCreateDataChannelEx(pc, label, ref init);
        if (id < 0) throw new InvalidOperationException("rtcCreateDataChannelEx failed: " + id);
        return new DataChannelHandle(id);
    }

    public void SetLocalDescription() => Native.rtcSetLocalDescription(pc, null);
    public void SetRemoteDescription(string sdp, string type) => Native.rtcSetRemoteDescription(pc, sdp, type);
    public void AddRemoteCandidate(string candidate, string mid) => Native.rtcAddRemoteCandidate(pc, candidate, mid);

    public void Dispose()
    {
        Native.rtcClosePeerConnection(pc); Native.rtcDeletePeerConnection(pc);
        foreach (var s in iceStrings) Marshal.FreeCoTaskMem(s);
        if (iceArray != IntPtr.Zero) Marshal.FreeHGlobal(iceArray);
        GC.KeepAlive(pinned);
    }
}

internal sealed class DataChannelHandle
{
    private readonly int id;
    private readonly List<object> pinned = [];
    public event Action? Opened;
    public event Action? Closed;
    public event Action<string>? Text;     // a text message (a frame or a chunk)
    public event Action<byte[]>? Binary;   // a binary message (a blob piece)

    internal DataChannelHandle(int id)
    {
        this.id = id;
        Native.OpenCallback open = (_, _) => Opened?.Invoke();
        Native.ClosedCallback closed = (_, _) => Closed?.Invoke();
        // size < 0: a null-terminated string; otherwise size binary bytes.
        Native.MessageCallback message = (_, data, size, _) =>
        {
            if (size < 0) Text?.Invoke(Marshal.PtrToStringUTF8(data) ?? "");
            else { var bytes = new byte[size]; Marshal.Copy(data, bytes, 0, size); Binary?.Invoke(bytes); }
        };
        pinned.AddRange([open, closed, message]);
        Native.rtcSetOpenCallback(id, open); Native.rtcSetClosedCallback(id, closed); Native.rtcSetMessageCallback(id, message);
    }

    // Attaches the callbacks of a channel the remote side opened.
    internal static DataChannelHandle Of(int id) => new(id);

    public void SendText(string text) { var bytes = Encoding.UTF8.GetBytes(text + "\0"); Native.rtcSendMessage(id, bytes, -1); }
    public void SendBinary(byte[] bytes) => Native.rtcSendMessage(id, bytes, bytes.Length);
    public void Close() { Native.rtcClose(id); Native.rtcDelete(id); GC.KeepAlive(pinned); }
}

// Frames over one ordered reliable data channel: chunks over 16 KiB (8.1), reassembly, and the 50 frames/s limit (8.7). A breach or an unreadable message calls Limit (the session closes with bye: limit).
internal sealed class FrameChannel
{
    public const int FramesPerSecond = 50;
    private readonly DataChannelHandle channel;
    private readonly Reassembler reassembler = new();
    private readonly Func<DateTimeOffset> now;
    private DateTimeOffset windowStart = DateTimeOffset.MinValue; private int count;
    public event Action<Frame, byte[]>? FrameReceived;
    public event Action<byte[]>? BlobReceived;
    public event Action? Limit;

    public FrameChannel(DataChannelHandle channel, Func<DateTimeOffset>? now = null)
    {
        this.channel = channel; this.now = now ?? (() => DateTimeOffset.UtcNow);
        channel.Binary += bytes => BlobReceived?.Invoke(bytes);
        channel.Text += OnText;
    }

    private void OnText(string text)
    {
        var t = now();
        if (t - windowStart >= TimeSpan.FromSeconds(1)) { windowStart = t; count = 0; }
        if (++count > FramesPerSecond) { Limit?.Invoke(); return; }
        byte[] bytes;
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(text);
            if (doc.RootElement.ValueKind == System.Text.Json.JsonValueKind.Object && doc.RootElement.TryGetProperty("mid", out var mid) && mid.ValueKind == System.Text.Json.JsonValueKind.String)
            {
                var chunk = new Chunk(mid.GetString()!, doc.RootElement.GetProperty("seq").GetInt64(), doc.RootElement.GetProperty("last").GetBoolean(), doc.RootElement.GetProperty("d").GetString()!);
                var outcome = reassembler.Accept(chunk, t, out var whole);
                if (outcome == Reassembler.Outcome.Incomplete) return;
                if (outcome == Reassembler.Outcome.Dropped) { Limit?.Invoke(); return; }
                bytes = whole!;
            }
            else bytes = Encoding.UTF8.GetBytes(text);
        }
        catch (Exception error) when (error is System.Text.Json.JsonException or KeyNotFoundException or InvalidOperationException) { Limit?.Invoke(); return; }
        if (Chunk.ParseFrame(bytes) is not { } frame) { Limit?.Invoke(); return; }
        FrameReceived?.Invoke(frame, bytes);
    }

    public void Send(Frame frame)
    {
        foreach (var message in Chunk.ToMessages(frame.Serialize(), System.Security.Cryptography.RandomNumberGenerator.GetBytes(16))) channel.SendText(Encoding.UTF8.GetString(message));
    }

    // A blob's binary messages, after the frame that names it.
    public void SendBlob(byte[] bytes) { foreach (var message in BlobMeta.Messages(bytes)) channel.SendBinary(message); }
}
