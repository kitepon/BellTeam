using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using BellTeam.PeerChannel;

namespace BellTeam.Tests;

// The P/Invoke bridge against the datachannel.dll that windows/native/build-libdatachannel.ps1 builds (libdatachannel v0.24.6): two peers in this process connect and a data channel carries a message.
// It fails, not skips, when the DLL has not been built.
public class PeerChannelNativeTests
{
    private static string Text(IntPtr pointer) => Marshal.PtrToStringUTF8(pointer)!;

    [Fact]
    public async Task TwoPeersConnectAndADataChannelCarriesAMessage()
    {
        Assert.True(File.Exists(Path.Combine(AppContext.BaseDirectory, "datachannel.dll")), "datachannel.dll is missing: run windows/native/build-libdatachannel.ps1");
        var opened = new TaskCompletionSource(); var received = new TaskCompletionSource<string>();
        int pcA = 0, pcB = 0;
        var config = new Native.Configuration();
        pcA = Native.rtcCreatePeerConnection(ref config); pcB = Native.rtcCreatePeerConnection(ref config);
        // The delegates are held in locals until the end: the native side keeps raw pointers to them.
        Native.DescriptionCallback descriptionA = (_, sdp, type, _) => Native.rtcSetRemoteDescription(pcB, Text(sdp), Text(type));
        Native.DescriptionCallback descriptionB = (_, sdp, type, _) => Native.rtcSetRemoteDescription(pcA, Text(sdp), Text(type));
        Native.CandidateCallback candidateA = (_, candidate, mid, _) => Native.rtcAddRemoteCandidate(pcB, Text(candidate), Text(mid));
        Native.CandidateCallback candidateB = (_, candidate, mid, _) => Native.rtcAddRemoteCandidate(pcA, Text(candidate), Text(mid));
        Native.MessageCallback message = (_, data, size, _) => { var bytes = new byte[size]; Marshal.Copy(data, bytes, 0, size); received.TrySetResult(Encoding.UTF8.GetString(bytes)); };
        Native.DataChannelCallback incoming = (_, channel, _) => Native.rtcSetMessageCallback(channel, message);
        Native.OpenCallback open = (_, _) => opened.TrySetResult();
        try
        {
            Native.rtcSetLocalDescriptionCallback(pcA, descriptionA); Native.rtcSetLocalDescriptionCallback(pcB, descriptionB);
            Native.rtcSetLocalCandidateCallback(pcA, candidateA); Native.rtcSetLocalCandidateCallback(pcB, candidateB);
            Native.rtcSetDataChannelCallback(pcB, incoming);
            var init = new Native.DataChannelInit();
            var channel = Native.rtcCreateDataChannelEx(pcA, "peer-channel/1", ref init);
            Native.rtcSetOpenCallback(channel, open);
            Native.rtcSetLocalDescription(pcA, null);
            Assert.Same(opened.Task, await Task.WhenAny(opened.Task, Task.Delay(15000)));
            var payload = Encoding.UTF8.GetBytes("hello over libdatachannel v0.24.6");
            Assert.Equal(0, Native.rtcSendMessage(channel, payload, payload.Length));
            Assert.Equal("hello over libdatachannel v0.24.6", await received.Task.WaitAsync(TimeSpan.FromSeconds(10)));
        }
        finally
        {
            Native.rtcDeletePeerConnection(pcA); Native.rtcDeletePeerConnection(pcB);
            GC.KeepAlive(new object[] { descriptionA, descriptionB, candidateA, candidateB, message, incoming, open });
        }
    }
}
