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

    // Phase "admit" (a520 step 4, the whole round): a registry made by the lab approver (dev:approve paired a connector) exists. This device shows its admission (the typed code goes to ABX_INTEROP_CODE_FILE),
    // a person runs `npm run dev:admit -- <code>` (peer-channel-adoption.md section 8 step 6), the device becomes Live, a request filed through the connector reaches it, and it answers the first option itself.
    private async Task AdmitAndAnswerAsync(LinuxApprovalBoxDevice device, List<string> states)
    {
        for (var wait = 0; wait < 300 && device.Device.State.Status != RuntimeStatus.NeedsAdmission; wait++) await Task.Delay(100);
        Assert.Equal(RuntimeStatus.NeedsAdmission, device.Device.State.Status);
        var admission = device.Device.NewAdmission();
        File.WriteAllText(Environment.GetEnvironmentVariable("ABX_INTEROP_CODE_FILE") ?? Path.Combine(Path.GetTempPath(), "abx-interop-code.txt"), admission.TypedCode);
        output.WriteLine($"{DateTimeOffset.Now:HH:mm:ss} waiting for dev:admit, code {admission.TypedCode}");
        using var window = new CancellationTokenSource(TimeSpan.FromMinutes(4));
        await device.Device.AdmitAsync(admission, window.Token);
        output.WriteLine($"{DateTimeOffset.Now:HH:mm:ss} admitted");
        for (var wait = 0; wait < 300 && device.Device.State.Status != RuntimeStatus.Live; wait++) await Task.Delay(100);
        output.WriteLine("states: " + string.Join(" > ", states));
        Assert.Equal(RuntimeStatus.Live, device.Device.State.Status);
        DecisionEntry? request = null;
        for (var wait = 0; wait < 1800 && request is null; wait++) { request = device.Device.Book.All.FirstOrDefault(e => e.IsOpen); await Task.Delay(100); }
        Assert.NotNull(request);
        output.WriteLine($"{DateTimeOffset.Now:HH:mm:ss} request {request!.DecisionId} \"{request.Title}\" options {string.Join("/", request.Options.Select(o => o.Id))}");
        var outcome = await device.Device.AnswerAsync(request.DecisionId, request.Options[0].Id, null);
        output.WriteLine($"{DateTimeOffset.Now:HH:mm:ss} answer ack {outcome.Ack}");
        Assert.Equal("ok", outcome.Ack);
        for (var wait = 0; wait < 100 && device.Device.Book.FindByDecision(request.DecisionId)?.Status != DecisionStatus.Answered; wait++) await Task.Delay(100);
        Assert.Equal(DecisionStatus.Answered, device.Device.Book.FindByDecision(request.DecisionId)!.Status);
    }

    [Fact]
    public async Task TheLinuxDeviceTalksToApprovalBoxLocalDevServer()
    {
        if (Url is null) return;
        var dir = Path.Combine(Path.GetTempPath(), "abx-interop-" + Guid.NewGuid().ToString("N"));
        var account = new LinuxApprovalBoxAccount(Url, new MemoryPassStore());
        await using var device = new LinuxApprovalBoxDevice(dir, account, () => [], true);
        var states = new List<string>();
        device.Device.Runtime.StateChanged += () => { var s = device.Device.State; lock (states) states.Add($"{s.Status}:{s.Reason}"); output.WriteLine($"{DateTimeOffset.Now:HH:mm:ss} state {s.Status} {s.Reason}"); };
        using var http = new HttpClient();
        await account.SignInAsync("apple", CancellationToken.None, uri => Open(http, uri));
        Assert.True(account.SignedIn);
        output.WriteLine("signed in to the foreign instance; pass header available: " + (await account.AccessAsync(CancellationToken.None)).Headers.ContainsKey("authorization"));
        device.Device.Start();
        var want = Phase == "first" ? RuntimeStatus.Live : RuntimeStatus.NeedsAdmission;
        if (Phase == "admit") { await AdmitAndAnswerAsync(device, states); try { Directory.Delete(dir, true); } catch (IOException) { } return; }
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
