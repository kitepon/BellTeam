using System.Runtime.InteropServices;

namespace BellTeam.PeerChannel;

// P/Invoke of libdatachannel v0.24.6 (rtc/rtc.h, the C API; tag commit 6b1e2e620f1e37f0eafeee702eaea0043cb305fd). Only what the peer-channel/1 data channel needs.
// The native library is datachannel.dll built by windows/native/build-libdatachannel.ps1 (MSVC, OpenSSL static, no media, no websocket); it sits beside BellTeam.PeerChannel.dll.
internal static class Native
{
    private const string Library = "datachannel";

    internal enum State { New = 0, Connecting = 1, Connected = 2, Disconnected = 3, Failed = 4, Closed = 5 }

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] internal delegate void DescriptionCallback(int pc, IntPtr sdp, IntPtr type, IntPtr user);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] internal delegate void CandidateCallback(int pc, IntPtr candidate, IntPtr mid, IntPtr user);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] internal delegate void StateCallback(int pc, State state, IntPtr user);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] internal delegate void DataChannelCallback(int pc, int dc, IntPtr user);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] internal delegate void OpenCallback(int id, IntPtr user);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] internal delegate void ClosedCallback(int id, IntPtr user);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] internal delegate void MessageCallback(int id, IntPtr message, int size, IntPtr user);

    // rtcConfiguration: field order and types follow rtc.h exactly.
    [StructLayout(LayoutKind.Sequential)]
    internal struct Configuration
    {
        public IntPtr IceServers; public int IceServersCount; public IntPtr ProxyServer; public IntPtr BindAddress;
        public int CertificateType; public int IceTransportPolicy;
        [MarshalAs(UnmanagedType.U1)] public bool EnableIceTcp; [MarshalAs(UnmanagedType.U1)] public bool EnableIceUdpMux; [MarshalAs(UnmanagedType.U1)] public bool DisableAutoNegotiation; [MarshalAs(UnmanagedType.U1)] public bool ForceMediaTransport;
        public ushort PortRangeBegin; public ushort PortRangeEnd; public int Mtu; public int MaxMessageSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct Reliability
    {
        [MarshalAs(UnmanagedType.U1)] public bool Unordered; [MarshalAs(UnmanagedType.U1)] public bool Unreliable; public uint MaxPacketLifeTime; public uint MaxRetransmits;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct DataChannelInit
    {
        public Reliability Reliability; public IntPtr Protocol; [MarshalAs(UnmanagedType.U1)] public bool Negotiated; [MarshalAs(UnmanagedType.U1)] public bool ManualStream; public ushort Stream;
    }

    [DllImport(Library)] internal static extern int rtcCreatePeerConnection(ref Configuration config);
    [DllImport(Library)] internal static extern int rtcClosePeerConnection(int pc);
    [DllImport(Library)] internal static extern int rtcDeletePeerConnection(int pc);
    [DllImport(Library)] internal static extern int rtcSetLocalDescriptionCallback(int pc, DescriptionCallback cb);
    [DllImport(Library)] internal static extern int rtcSetLocalCandidateCallback(int pc, CandidateCallback cb);
    [DllImport(Library)] internal static extern int rtcSetStateChangeCallback(int pc, StateCallback cb);
    [DllImport(Library)] internal static extern int rtcSetDataChannelCallback(int pc, DataChannelCallback cb);
    [DllImport(Library)] internal static extern int rtcSetLocalDescription(int pc, [MarshalAs(UnmanagedType.LPUTF8Str)] string? type);
    [DllImport(Library)] internal static extern int rtcSetRemoteDescription(int pc, [MarshalAs(UnmanagedType.LPUTF8Str)] string sdp, [MarshalAs(UnmanagedType.LPUTF8Str)] string type);
    [DllImport(Library)] internal static extern int rtcAddRemoteCandidate(int pc, [MarshalAs(UnmanagedType.LPUTF8Str)] string candidate, [MarshalAs(UnmanagedType.LPUTF8Str)] string mid);
    [DllImport(Library)] internal static extern int rtcCreateDataChannelEx(int pc, [MarshalAs(UnmanagedType.LPUTF8Str)] string label, ref DataChannelInit init);
    [DllImport(Library)] internal static extern int rtcSetOpenCallback(int id, OpenCallback cb);
    [DllImport(Library)] internal static extern int rtcSetClosedCallback(int id, ClosedCallback cb);
    [DllImport(Library)] internal static extern int rtcSetMessageCallback(int id, MessageCallback cb);
    [DllImport(Library)] internal static extern int rtcSendMessage(int id, byte[] data, int size);
    [DllImport(Library)] internal static extern int rtcClose(int id);
    [DllImport(Library)] internal static extern int rtcDelete(int id);
    [DllImport(Library)] internal static extern void rtcCleanup();
}
