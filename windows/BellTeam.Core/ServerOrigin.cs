using System.Net;
using System.Net.Sockets;

namespace BellTeam.Core;

// OSのURL型へ変換する境界。受け付ける接続先はShared/ServerOrigin.swiftと同じ。
public static class ServerOrigin
{
    public static Uri Parse(string address)
    {
        if (!Uri.TryCreate(address.Trim(), UriKind.Absolute, out var uri)
            || string.IsNullOrEmpty(uri.Host) || uri.UserInfo.Length != 0
            || uri.Query.Length != 0 || uri.Fragment.Length != 0 || uri.AbsolutePath != "/"
            || !(uri.Scheme == "https" || uri.Scheme == "http" && IsLocalHost(uri.Host)))
            throw new ArgumentException("HTTPS、またはlocalhost・LANのHTTP接続先URLを入力してください。パス・認証情報・クエリー・フラグメントは指定できません。");
        return new Uri(uri.GetLeftPart(UriPartial.Authority) + "/");
    }

    public static bool IsLocalHost(string supplied)
    {
        var host = supplied.Trim('[', ']').ToLowerInvariant();
        if (host == "localhost" || host.EndsWith(".local", StringComparison.Ordinal)) return true;
        if (IPAddress.TryParse(host, out var ip))
        {
            var bytes = ip.GetAddressBytes();
            if (ip.AddressFamily == AddressFamily.InterNetworkV6)
                return ip.Equals(IPAddress.IPv6Loopback) || (bytes[0] & 0xfe) == 0xfc
                    || bytes[0] == 0xfe && (bytes[1] & 0xc0) == 0x80;
            return bytes[0] is 10 or 127 || bytes[0] == 192 && bytes[1] == 168
                || bytes[0] == 172 && bytes[1] is >= 16 and <= 31 || bytes[0] == 169 && bytes[1] == 254;
        }
        return !host.Contains('.') && !host.Contains(':') && !host.All(char.IsDigit);
    }
}
