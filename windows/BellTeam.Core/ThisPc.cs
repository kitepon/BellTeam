using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace BellTeam.Core;

// W-MAC 16c: S1 「このPCを追加」 and S2 「このPCを確かめる」, the Windows version of the Mac's ThisMac.swift (terminals README "Windows app on that PC").
// Local facts only; nothing secret. Every read of this PC goes through IThisPc so a test never touches the real network or file system.

public sealed record PcInterface(string Name, string Address, bool IsIPv6, bool HasGateway);

public enum OpenSshState { On, Off, Unknown }

public interface IThisPc
{
    // Every up interface address (loopback and link-local included, for ownership checks).
    IReadOnlyList<PcInterface> Interfaces();
    string MachineName { get; }
    // The local account name OpenSSH logs in with, and the domain Windows reports for it (this machine's name for a local or Microsoft account).
    string UserName { get; }
    string UserDomain { get; }
    // TCP to 127.0.0.1:port.
    Task<OpenSshState> OpenSshAsync(int port, CancellationToken token);
    // The text of the sshd ed25519 host public key file.
    Task<string> ReadHostKeyAsync(CancellationToken token);
}

public sealed class ThisPcSystem : IThisPc
{
    public const string HostKeyPath = @"C:\ProgramData\ssh\ssh_host_ed25519_key.pub";
    // shortcut: Windows reports a refused loopback connect only after about 2 s (it retries the SYN), so 2 s would read a refusal as "unknown"; 5 s is the least that is safe.
    private static readonly TimeSpan OpenSshLimit = TimeSpan.FromSeconds(5);

    // shortcut: an unreadable adapter list reads as no addresses (as the Mac's getifaddrs); the form then says the address could not be read.
    public IReadOnlyList<PcInterface> Interfaces()
    {
        try
        {
            return NetworkInterface.GetAllNetworkInterfaces().Where(adapter => adapter.OperationalStatus == OperationalStatus.Up).SelectMany(adapter =>
            {
                var properties = adapter.GetIPProperties();
                var gateway = properties.GatewayAddresses.Any(item => item.Address.AddressFamily == AddressFamily.InterNetwork && !item.Address.Equals(IPAddress.Any));
                return properties.UnicastAddresses.Where(item => item.Address.AddressFamily is AddressFamily.InterNetwork or AddressFamily.InterNetworkV6)
                    .Select(item => new PcInterface(adapter.Name, item.Address.ToString(), item.Address.AddressFamily == AddressFamily.InterNetworkV6, gateway));
            }).ToList();
        }
        catch (NetworkInformationException) { return []; }
    }
    public string MachineName => Environment.MachineName;
    public string UserName => Environment.UserName;
    public string UserDomain => Environment.UserDomainName;

    public async Task<OpenSshState> OpenSshAsync(int port, CancellationToken token)
    {
        using var client = new TcpClient(AddressFamily.InterNetwork);
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(token); limit.CancelAfter(OpenSshLimit);
        try { await client.ConnectAsync(IPAddress.Loopback, port, limit.Token); return OpenSshState.On; }
        catch (SocketException error) when (error.SocketErrorCode == SocketError.ConnectionRefused) { return OpenSshState.Off; }
        catch (SocketException) { return OpenSshState.Unknown; }
        catch (OperationCanceledException) when (!token.IsCancellationRequested) { return OpenSshState.Unknown; }
    }

    public Task<string> ReadHostKeyAsync(CancellationToken token) => File.ReadAllTextAsync(HostKeyPath, token);
}

public static class ThisPcFacts
{
    public const string OptionalFeaturesUri = "ms-settings:optionalfeatures";
    public const string OpenSshOffText = "OpenSSH サーバーがオンになっていません。";
    // The server's CONNECTION_REFUSED step for a Windows terminal: add the feature, start the service.
    public const string OpenSshOffStep = "Windowsの「設定 > システム > オプション機能」でOpenSSH サーバーを追加し、サービスの「OpenSSH SSH Server」を開始してください。";
    public const string OpenSshUnknownText = "OpenSSH サーバーがオンかどうかを確かめられませんでした。";
    public const string AddressMissingText = "このPCのIPv4アドレスを読み取れませんでした。ホストを入れてください。";
    public const string DomainUserText = "このPCはドメインのアカウントでログインしています。ユーザーは、SSHでログインする名前を入れてください。";

    // The first usable IPv4 address (not loopback, not link-local), the adapter that has a default gateway first: a Hyper-V or WSL adapter has none.
    public static string? PrimaryIPv4(IEnumerable<PcInterface> interfaces)
    {
        var usable = interfaces.Where(item => !item.IsIPv6 && !item.Address.StartsWith("127.", StringComparison.Ordinal) && !item.Address.StartsWith("169.254.", StringComparison.Ordinal)).ToList();
        return (usable.FirstOrDefault(item => item.HasGateway) ?? usable.FirstOrDefault())?.Address;
    }

    // The local account name, also on a Microsoft-account PC. A domain account (the domain is not this machine) is never prefilled as DOMAIN\user: the field stays empty.
    public static string SshUser(IThisPc pc) => string.Equals(pc.UserDomain, pc.MachineName, StringComparison.OrdinalIgnoreCase) ? pc.UserName : "";

    // A terminal host that is this PC: an interface address, loopback, localhost or this PC's own machine name. No other name is resolved,
    // so a different PC that merely answers on the network is never taken for this one. The adapters are read only for an IP address.
    public static bool Owns(string host, IThisPc pc)
    {
        var text = host.Trim().ToLowerInvariant();
        if (text.Length == 0) return false;
        if (text.Contains(':') || Regex.IsMatch(text, @"\A[0-9]{1,3}(?:\.[0-9]{1,3}){3}\z"))
        {
            if (Canonical(text) is not { } wanted) return false;
            return wanted is "127.0.0.1" or "::1" || pc.Interfaces().Any(item => Canonical(item.Address) == wanted);
        }
        if (text == "localhost") return true;
        var own = pc.MachineName.ToLowerInvariant();
        return own.Length != 0 && (text == own || text == own + ".local" || own == text + ".local");
    }

    // The same address in one spelling (IPv6 shortening, a %zone dropped); null when it is not an IP address.
    private static string? Canonical(string address) => IPAddress.TryParse(address.Split('%', 2)[0], out var ip) ? ip.ToString() : null;
}

public enum HostKeyFileProblem { NotEd25519, Malformed }
public sealed class HostKeyFileException(HostKeyFileProblem problem, string? keyType = null) : Exception(problem.ToString())
{
    public HostKeyFileProblem Problem { get; } = problem;
    public string? KeyType { get; } = keyType;
}

public static class HostKeyFile
{
    // ssh wire form of an ed25519 public key: string "ssh-ed25519", then string of the 32 key bytes.
    private static readonly byte[] Prefix = [0, 0, 0, 11, .. "ssh-ed25519"u8, 0, 0, 0, 32];

    // `ssh-ed25519 <base64> [comment]` -> SHA256: + the unpadded base64 of the SHA-256 of the decoded blob (what `ssh-keygen -lf` prints).
    public static string Fingerprint(string text)
    {
        var fields = text.Split('\n').Select(line => line.Trim()).FirstOrDefault(line => line.Length != 0)?.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries) ?? [];
        if (fields.Length < 2) throw new HostKeyFileException(HostKeyFileProblem.Malformed);
        if (fields[0] != "ssh-ed25519") throw new HostKeyFileException(HostKeyFileProblem.NotEd25519, fields[0]);
        var blob = new byte[fields[1].Length];
        if (!Convert.TryFromBase64String(fields[1], blob, out var length) || length != Prefix.Length + 32 || !blob.AsSpan(0, Prefix.Length).SequenceEqual(Prefix)) throw new HostKeyFileException(HostKeyFileProblem.Malformed);
        return "SHA256:" + Convert.ToBase64String(SHA256.HashData(blob.AsSpan(0, length))).TrimEnd('=');
    }
}

// What the detail shows about this PC's own attestation. Nothing here is stored on the server.
public sealed record TrustNote(string Text, bool OffersOptionalFeatures = false, bool OffersOtherWays = false);

public sealed record TerminalTrustResponse { public required Terminal Terminal { get; init; } }

public static class ThisPcTrust
{
    private const string Other = "「ほかの方法」で指紋を入れて確かめられます。";

    // This PC could not give its host key: no request goes to the server, and the manual fingerprint stays available.
    public static TrustNote Local(Exception error) => error switch
    {
        FileNotFoundException or DirectoryNotFoundException => new($"このPCのホスト鍵のファイルがありません（{ThisPcSystem.HostKeyPath}）。OpenSSH サーバーを追加して、サービスの「OpenSSH SSH Server」を一度開始してから、もう一度確かめてください。{Other}", OffersOptionalFeatures: true, OffersOtherWays: true),
        UnauthorizedAccessException => new($"このPCのホスト鍵のファイルを読めませんでした（読む権限がありません）。{Other}", OffersOtherWays: true),
        IOException => new($"このPCのホスト鍵のファイルを読めませんでした（開けません）。{Other}", OffersOtherWays: true),
        HostKeyFileException { Problem: HostKeyFileProblem.NotEd25519 } file => new($"このPCのホスト鍵のファイルはed25519の鍵ではありません（{file.KeyType}）。{Other}", OffersOtherWays: true),
        HostKeyFileException => new($"このPCのホスト鍵のファイルの形を読み取れませんでした。信用は何も書いていません。{Other}", OffersOtherWays: true),
        _ => new($"このPCのホスト鍵を読めませんでした。{Other}", OffersOtherWays: true)
    };

    // The server's answer to POST …/trust; null for an older body (404 without TERMINAL_NOT_FOUND): no line at all.
    public static TrustNote? Server(Exception error)
    {
        if (error is BellApiException { Status: { } status })
        {
            switch ((int)status, TerminalErrorText.Code(error))
            {
                case (404, not "TERMINAL_NOT_FOUND"): return null;
                case (409, "HOST_KEY_FINGERPRINT_MISMATCH"): return new("このアドレスで答えているのは、このPCではありません。ホストの入力を確かめてください。信用は何も書いていません。");
                case (409, "TERMINAL_CHANGED"): return new("確かめている間に、端末の接続先が変わりました。もう一度「このPCを確かめる」を押してください。");
                case (503, "TERMINAL_UNAVAILABLE"): return new("いまはBellTeamからこのPCを確かめられません。PCが起きていて同じネットワークにあるか確かめて、あとでもう一度押してください。");
            }
        }
        return new(TerminalErrorText.Message(error));
    }
}
