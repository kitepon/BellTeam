using System.Text.Json;
using BellTeam.Linux;

namespace BellTeam.Linux.Tests;

// client-v0.5.md 6.2: every client's test reads the contract's fixture file, not a copy.
public sealed class ApprovalOriginRuleTests
{
    private static string Fixtures()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var path = Path.Combine(dir.FullName, "docs", "architecture", "modules", "approval-box-extension", "contract", "fixtures", "origin-cases.json");
            if (File.Exists(path)) return path;
        }
        throw new FileNotFoundException("origin-cases.json");
    }

    public static IEnumerable<object[]> Cases() => JsonDocument.Parse(File.ReadAllText(Fixtures())).RootElement.GetProperty("cases").EnumerateObject().Select(c => new object[] { c.Name });

    [Theory, MemberData(nameof(Cases))]
    public void TheFixtureCaseGivesTheExpectedOrigin(string name)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(Fixtures())); var one = doc.RootElement.GetProperty("cases").GetProperty(name);
        var roster = one.GetProperty("roster").EnumerateArray().Select(m => (m.GetProperty("id").GetString()!, m.GetProperty("name").GetString()!)).ToList();
        var (origin, requester) = ApprovalOriginRule.Of(one.GetProperty("source"), roster);
        var expect = one.GetProperty("expect");
        Assert.Equal(expect.GetProperty("kind").GetString(), origin.Kind); Assert.Equal(expect.GetProperty("basis").GetString(), origin.Basis);
        if (expect.TryGetProperty("client", out var client)) Assert.Equal(client.GetString(), origin.Client);
        var who = expect.GetProperty("requester");
        if (who.ValueKind == JsonValueKind.Null) Assert.Null(requester);
        else { Assert.Equal(who.GetProperty("botId").GetString(), requester!.BotId); Assert.Equal(who.GetProperty("name").GetString(), requester.Name); }
    }
}
