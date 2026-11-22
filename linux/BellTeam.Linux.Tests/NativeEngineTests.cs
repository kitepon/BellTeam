using System.Runtime.InteropServices;
using Xunit;

namespace BellTeam.Linux.Tests;

public sealed class NativeEngineTests
{
    // The committed libdatachannel.so loads and the C API the device part calls is exported (x64 only: the library is built for x86_64).
    [Fact]
    public void TheCommittedEngineLoadsAndExportsTheDataChannelApi()
    {
        if (RuntimeInformation.ProcessArchitecture != Architecture.X64) return;
        var path = Path.Combine(AppContext.BaseDirectory, "libdatachannel.so");
        Assert.True(NativeLibrary.TryLoad(path, out var handle), "libdatachannel.so did not load: " + path);
        foreach (var name in new[] { "rtcCreatePeerConnection", "rtcSetLocalDescription", "rtcCreateDataChannelEx", "rtcSendMessage", "rtcDeletePeerConnection" })
            Assert.True(NativeLibrary.TryGetExport(handle, name, out _), name + " is not exported");
        NativeLibrary.Free(handle);
    }
}
