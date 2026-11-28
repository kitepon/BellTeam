using System.Net;

namespace BellTeam.Core;

// app-sessions.md sections 2 and 4 (reading 3): a server that mounts the login-billing home part answers GET /api/home/session; the app enters it with a code from the server console (POST /api/home/login/console),
// keeps the opaque session token it gets back, and sends it as Authorization: Bearer. The operator sign-in (nonce/prove) is not used: BellTeam runs no operator. Same spec as Apple's ServerLogin.swift.
public sealed record HomeProbe
{
    public const string CapabilityName = "login-billing-home/1";
    public string Capability { get; init; } = "";
    public bool Bound { get; init; }
    public bool Enforced { get; init; }
}
// The token comes once, in this answer; an app that loses it asks for a new code.
public sealed record HomeLoginAnswer { public string? Token { get; init; } public string? SessionId { get; init; } }

public sealed class HomeLoginApi(BellApi api)
{
    // Only a 404 (a server without the home part), a refusal that Cloudflare Access gives, and an answer that is not the home part's mean "not a home server" (null);
    // a failed connection or a 503 is the caller's failure.
    public static async Task<HomeProbe?> ProbeAsync(BellApi api, CancellationToken token = default)
    {
        try { return await api.GetAsync<HomeProbe>("/api/home/session", token) is { Capability: HomeProbe.CapabilityName } probe ? probe : null; }
        catch (BellApiException error) when (error.Status == HttpStatusCode.NotFound || error.RequiresLogin || (error.Status is null && error.Code is null)) { return null; }
    }

    // A console code is one use; the caller never resends it by itself (a failed attempt asks for a new code).
    public async Task<HomeLoginAnswer> ConsoleAsync(string code, CancellationToken token = default)
    {
        var answer = await api.PostAsync<HomeLoginAnswer>("/api/home/login/console", new { code = code.Trim() }, token);
        return string.IsNullOrEmpty(answer.Token) ? throw new BellApiException(HomeLoginText.NoResult) : answer;
    }
}

public static class HomeLoginText
{
    public static string NoResult => CoreStrings.HomeLoginText_NoResult_1;
    public static string CodeInvalid => CoreStrings.HomeLoginText_CodeInvalid_1;
    public static string Of(Exception error) => error is BellApiException { Code: { } code } ? code switch
    {
        "SETUP_CODE_REQUIRED" => SignInText.SetupCodeRequired,
        "LOGIN_CODE_INVALID" => CodeInvalid,
        "LOGIN_INPUT_INVALID" => CoreStrings.HomeLoginText_InputInvalid_1,
        "LOGIN_RATE_LIMITED" => CoreStrings.HomeLoginText_RateLimited_1,
        "SESSION_STORE_UNAVAILABLE" => SignInText.ServerNotReady,
        "AUDIENCE_UNKNOWN" => SignInText.AddressNotRegistered,
        "NOT_OWNER_ACCOUNT" => SignInText.NotOwner,
        _ => CoreStrings.HomeLoginText_Refused_1((int?)((BellApiException)error).Status ?? 0),
    } : error is BellApiException { Status: { } status } ? CoreStrings.HomeLoginText_Refused_1((int)status) : error.Message;
}
