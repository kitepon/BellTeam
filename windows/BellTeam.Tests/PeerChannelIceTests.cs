using System.Net;
using BellTeam.PeerChannel;

namespace BellTeam.Tests;

// Contract 11: the first STUN, the first two UDP TURN URLs, IPv4 first (libjuice dials only the first address of a name).
public class PeerChannelIceTests
{
    private static Task<IPAddress[]> Resolve(string host) => Task.FromResult(host switch
    {
        "dual.example" => new[] { IPAddress.Parse("2001:db8::1"), IPAddress.Parse("192.0.2.1") },
        "v6only.example" => [IPAddress.Parse("2001:db8::2")],
        "gone.example" => [],
        _ => [IPAddress.Parse("192.0.2.9")],
    });

    [Fact]
    public async Task KeepsTheFirstStunAndTheFirstTwoUdpTurnEachOnIpv4()
    {
        var turn = new TurnCredentials(["stun:dual.example:3478", "stun:other.example", "turn:dual.example:3478?transport=udp", "turn:b.example:443?transport=tcp", "turn:v6only.example", "turn:c.example:443?transport=udp", "turn:gone.example"], "u:1", "p/w", 60);
        Assert.Equal<string>(["stun:192.0.2.1:3478", "turn:u%3A1:p%2Fw@192.0.2.1:3478?transport=udp", "turn:u%3A1:p%2Fw@[2001:db8::2]:3478?transport=udp"], await IceServers.SelectAsync(turn, Resolve));
    }

    [Fact]
    public async Task AnIpLiteralStaysAndANameThatDoesNotResolveIsLeftOut()
    {
        var turn = new TurnCredentials(["turn:gone.example:3478", "turn:198.51.100.5:443?transport=udp"], "u", "p", 60);
        Assert.Equal<string>(["turn:u:p@198.51.100.5:443?transport=udp"], await IceServers.SelectAsync(turn, Resolve));
        Assert.Empty(await IceServers.SelectAsync(null, Resolve));
    }
}
