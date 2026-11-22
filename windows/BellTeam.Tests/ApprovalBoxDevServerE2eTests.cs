using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using BellTeam.App;
using BellTeam.PeerChannel;
using Kitepon.LoginBilling.Desktop;

namespace BellTeam.Tests;

// The second sign-in and the first registry against approval-box's own dev server (npm run dev:server in kitepon/approval-box packages/server; 127.0.0.1 only, fake providers).
// PC_E2E_ABX_URL=http://127.0.0.1:8788 turns it on; without it this test does nothing.
public class ApprovalBoxDevServerE2eTests
{
    [Fact]
    public async Task TheSecondSignInGetsAPassTheServerAcceptsAndTheFirstDeviceMakesItsGenesis()
    {
        var url = Environment.GetEnvironmentVariable("PC_E2E_ABX_URL");
        if (url is null) return;
        var dir = Path.Combine(Path.GetTempPath(), "bt-abx-" + Guid.NewGuid().ToString("N"));
        try
        {
            var account = new ApprovalBoxAccount(url, new MemoryPassStore());
            Assert.False(account.SignedIn);
            using var browser = new HttpClient();
            await account.SignInAsync("google", CancellationToken.None, async provider =>
            {
                using var answer = await browser.PostAsync(new Uri(new Uri(url), "/dev/websignin"), new StringContent(JsonSerializer.Serialize(new { providerUrl = provider.ToString() }), Encoding.UTF8, "application/json"));
                var text = await answer.Content.ReadAsStringAsync();
                Assert.True(answer.IsSuccessStatusCode, "dev/websignin: " + text);
                using var doc = JsonDocument.Parse(text);
                using var back = await browser.GetAsync(doc.RootElement.GetProperty("location").GetString());   // the browser following the callback to the library's loopback listener
            });
            Assert.True(account.SignedIn);
            var access = await account.AccessAsync(CancellationToken.None);
            Assert.StartsWith("Bearer ", access.Headers["authorization"]);
            var k = await account.AccountAsync(CancellationToken.None);
            Assert.False(string.IsNullOrEmpty(k));

            await using var device = new DeviceApprovals(dir, account.AccessAsync, account.AccountAsync, "windows e2e");
            var seen = new List<string>(); device.Runtime.StateChanged += () => seen.Add(device.State.Status + ":" + device.State.Reason); device.Runtime.Trace += seen.Add;
            device.Start();
            for (var i = 0; i < 200 && device.State.Status != RuntimeStatus.Live; i++) await Task.Delay(50);
            Assert.True(device.State.Status == RuntimeStatus.Live, string.Join(" | ", seen));
            Assert.True(File.Exists(Path.Combine(dir, "peer-channel-registry.json")));      // the genesis head was kept
        }
        finally { if (Directory.Exists(dir)) try { Directory.Delete(dir, true); } catch (IOException) { } }
    }
}
