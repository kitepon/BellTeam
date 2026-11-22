using System.Text;
using System.Text.Json;
using BellTeam.PeerChannel;
using Kitepon.LoginBilling.Desktop;
using Xunit.Abstractions;

namespace BellTeam.Linux;

// a520 step 4: the Linux device against approval-box's local dev server (docs/architecture/peer-channel-adoption.md section 8). Never runs by default: ABX_INTEROP_URL=http://127.0.0.1:8788 turns it on.
// Phase "first": a fresh DEV_DATA, this device signs in (web sign-in through the dev server's fake provider) and must reach Live as the first device (genesis, 5.1).
// Phase "later": a registry made by another device exists (dev:approve); this device must say NeedsAdmission and offer a code and a QR (5.3 starter side).
public sealed class ApprovalBoxInteropTests(ITestOutputHelper output)
{
    private static readonly string? Url = Environment.GetEnvironmentVariable("ABX_INTEROP_URL");
    private static readonly string Phase = Environment.GetEnvironmentVariable("ABX_INTEROP_PHASE") ?? "first";

    private static async Task Open(HttpClient http, Uri providerUrl)
    {
        using var made = await http.PostAsync(Url + "/dev/websignin", new StringContent(JsonSerializer.Serialize(new { providerUrl = providerUrl.ToString(), sub = "dev-person" }), Encoding.UTF8, "application/json"));
        var location = JsonDocument.Parse(await made.Content.ReadAsStringAsync()).RootElement.GetProperty("location").GetString()!;
        using var callback = await http.GetAsync(location);
    }

    [Fact]
    public async Task TheLinuxDeviceTalksToApprovalBoxLocalDevServer()
    {
        if (Url is null) return;
        var dir = Path.Combine(Path.GetTempPath(), "abx-interop-" + Guid.NewGuid().ToString("N"));
        var account = new LinuxApprovalBoxAccount(Url, new MemoryPassStore());
        await using var device = new LinuxApprovalBoxDevice(dir, account);
        var states = new List<string>();
        device.Device.Runtime.StateChanged += () => { var s = device.Device.State; lock (states) states.Add($"{s.Status}:{s.Reason}"); output.WriteLine($"{DateTimeOffset.Now:HH:mm:ss} state {s.Status} {s.Reason}"); };
        using var http = new HttpClient();
        await account.SignInAsync("apple", CancellationToken.None, uri => Open(http, uri));
        Assert.True(account.SignedIn);
        output.WriteLine("signed in to the foreign instance; pass header available: " + (await account.AccessAsync(CancellationToken.None)).Headers.ContainsKey("authorization"));
        device.Device.Start();
        var want = Phase == "first" ? RuntimeStatus.Live : RuntimeStatus.NeedsAdmission;
        for (var wait = 0; wait < 300 && device.Device.State.Status != want; wait++) await Task.Delay(100);
        output.WriteLine("states: " + string.Join(" > ", states));
        Assert.Equal(want, device.Device.State.Status);
        if (Phase != "first")
        {
            var admission = device.Device.NewAdmission();
            output.WriteLine($"offer code {admission.TypedCode} qr {admission.QrText.Length} chars expires {admission.ExpiresAt:HH:mm:ss}");
            Assert.False(string.IsNullOrEmpty(admission.TypedCode)); Assert.StartsWith("PC1", admission.QrText);
        }
        try { Directory.Delete(dir, true); } catch (IOException) { }
    }
}
