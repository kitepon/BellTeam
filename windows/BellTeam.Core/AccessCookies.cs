using System.Net;

namespace BellTeam.Core;

public static class AccessCookies
{
    public static void Replace(CookieContainer destination, Uri origin, IEnumerable<Cookie> cookies)
    {
        foreach (Cookie previous in destination.GetCookies(origin)) if (previous.Name == "CF_Authorization") previous.Expired = true;
        foreach (var cookie in cookies)
        {
            var domain = cookie.Domain.TrimStart('.');
            if (cookie.Name != "CF_Authorization" || cookie.Expired || !(origin.Host.Equals(domain, StringComparison.OrdinalIgnoreCase) || origin.Host.EndsWith("." + domain, StringComparison.OrdinalIgnoreCase))) continue;
            destination.Add(origin, new Cookie(cookie.Name, cookie.Value, cookie.Path, origin.Host) { Secure = cookie.Secure, HttpOnly = cookie.HttpOnly, Expires = cookie.Expires });
        }
    }
}
