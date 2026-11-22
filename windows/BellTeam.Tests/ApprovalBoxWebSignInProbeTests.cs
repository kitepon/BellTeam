using System.IO;
using BellTeam.App;
using Kitepon.LoginBilling.Desktop;

namespace BellTeam.Tests;

// Pre-check of the real second sign-in without a person: the second instance runs websignin/start against each origin in PC_E2E_ABX_PROBE (comma separated) and stops when it is handed the provider address (no browser).
// It prints nothing secret: only the host and path of the address. Without the variable this test does nothing.
public class ApprovalBoxWebSignInProbeTests
{
    [Fact]
    public async Task EachApprovalBoxOriginHandsTheSecondInstanceAProviderAddress()
    {
        var origins = Environment.GetEnvironmentVariable("PC_E2E_ABX_PROBE");
        if (origins is null) return;
        var lines = new List<string>(); var failures = new List<string>();
        foreach (var origin in origins.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            Uri? seen = null;
            try { await new ApprovalBoxAccount(origin, new MemoryPassStore()).SignInAsync("google", CancellationToken.None, uri => { seen = uri; throw new OperationCanceledException("probe: the browser is not opened"); }); }
            catch (OperationCanceledException) { }
            catch (LoginBillingException error) { lines.Add(origin + " -> " + error.Code + " " + error.Detail); }
            if (seen is null) failures.Add(origin + " gave no provider address: " + string.Join("; ", lines)); else lines.Add(origin + " -> " + seen.Host + seen.AbsolutePath);
        }
        File.WriteAllLines(Path.Combine(Path.GetTempPath(), "abx-probe.txt"), lines);
        Assert.True(failures.Count == 0, string.Join(" | ", failures));
    }
}
