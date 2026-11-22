using System.IO;
using BellTeam.App;
using BellTeam.PeerChannel;

namespace BellTeam.Tests;

public class DeviceApprovalsHistoryTests
{
    [Fact]
    public void TheHistoryFileIsSealedAndComesBackAndAFileThatDoesNotUnsealIsNoHistory()
    {
        var dir = Path.Combine(Path.GetTempPath(), "bt-hist-" + Guid.NewGuid().ToString("N")); var path = Path.Combine(dir, "h.bin");
        try
        {
            var book = new DecisionBook();
            book.Apply("request", System.Text.Json.JsonDocument.Parse("{\"rid\":\"r1\",\"rv\":1,\"schema\":\"approval-box/decision@1\",\"content\":{\"decision_id\":\"K-1\",\"title\":\"秘密の題\",\"options\":[]}}").RootElement, [1, 2], 5);
            DeviceApprovals.SaveHistoryFile(path, book);
            Assert.DoesNotContain("秘密の題", System.Text.Encoding.UTF8.GetString(File.ReadAllBytes(path)));
            Assert.Equal("秘密の題", DeviceApprovals.LoadHistory(path).Find("r1")!.Title);
            File.WriteAllBytes(path, [1, 2, 3]);
            Assert.Empty(DeviceApprovals.LoadHistory(path).All);
        }
        finally { if (Directory.Exists(dir)) Directory.Delete(dir, true); }
    }
}
