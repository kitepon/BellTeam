using System.Text.Json;

namespace BellTeam.Core;

// Mac FeatureGuide / OnePasswordConnection: how to get the secret, and what the connected token can read.
public sealed record GuideLink(string Label, string Url);
public sealed record FeatureGuide(string[] Steps, GuideLink? Link)
{
    // Only an https link is opened (same rule as the Web Settings guide).
    public (string Label, Uri Url)? OpenableLink => Link is { } link && Uri.TryCreate(link.Url, UriKind.Absolute, out var url) && url.Scheme == Uri.UriSchemeHttps && url.Host.Length != 0 ? (link.Label, url) : null;
}
public sealed record OnePasswordConnection(string[] Vaults, int SshKeys);

public enum OnePasswordState { Connected, Off, Failed }

// The 1Password連携 wording and rules (Mac OnePasswordState / OnePasswordResult, Web showOnePasswordResult).
public static class OnePasswordItem
{
    public const string Id = "onePassword";
    // A guide/connection that is missing or does not have the expected shape is "none": the extras never fail the settings list.
    public static T? Lenient<T>(JsonElement item, string key, Func<T, bool> valid) where T : class
    {
        if (!item.TryGetProperty(key, out var value) || value.ValueKind != JsonValueKind.Object) return null;
        try { return value.Deserialize<T>(BellApi.Json) is { } read && valid(read) ? read : null; } catch (Exception) { return null; }
    }
    public static FeatureGuide? ReadGuide(JsonElement item) => Lenient<FeatureGuide>(item, "guide", guide => guide.Steps is not null && guide.Steps.All(step => step is not null) && (guide.Link is null || (guide.Link.Label is not null && guide.Link.Url is not null)));
    public static OnePasswordConnection? ReadConnection(JsonElement item) => Lenient<OnePasswordConnection>(item, "connection", connection => connection.Vaults is not null && connection.Vaults.All(vault => vault is not null));

    public static OnePasswordState State(FeatureSetting setting) => setting.ApplyFailed ? OnePasswordState.Failed : setting.Status == "enabled" ? OnePasswordState.Connected : OnePasswordState.Off;
    public static string BadgeText(OnePasswordState state) => state switch { OnePasswordState.Connected => "連携中", OnePasswordState.Off => "未連携", _ => "失敗" };
    // The line under a connected header (wording shared with the Web Settings). null when not connected.
    public static string? ConnectionLine(FeatureSetting setting)
    {
        if (State(setting) != OnePasswordState.Connected) return null;
        if (setting.Connection is not { } connection) return "1Passwordにつながっています。";
        var vaults = connection.Vaults.Length == 0 ? "なし" : string.Join("、", connection.Vaults);
        return connection.SshKeys > 0
            ? $"読める保管庫：{vaults}　SSH鍵：{connection.SshKeys}件"
            : $"読める保管庫：{vaults}　SSH鍵が見つかりません。読める保管庫にSSH鍵を入れるか、サービスアカウントに鍵のある保管庫を足してください。";
    }
    // Client check before saving; the server validates the token itself.
    public static string? TokenProblem(string token) => token.Trim().StartsWith("ops_", StringComparison.Ordinal) ? null : "サービスアカウントのトークン（ops_で始まる文字）を貼ってください。";
    // Saving with an empty field is allowed only to toggle an already configured token.
    public static string? SaveProblem(bool enabled, string pasted, bool configured) => enabled && (pasted.Trim().Length != 0 || !configured) ? TokenProblem(pasted) : null;
}

public enum OnePasswordResultKind { None, Checking, Connected, Failed, Off }
// The result line above the primary button. Only a PATCH response speaks a result; a later settings read may show or hide a failure but never overwrites the line while a check runs.
public sealed record OnePasswordResult(OnePasswordResultKind Kind, string Detail = "")
{
    public static readonly OnePasswordResult None = new(OnePasswordResultKind.None), Checking = new(OnePasswordResultKind.Checking), Off = new(OnePasswordResultKind.Off);
    public string Text => Kind switch
    {
        OnePasswordResultKind.Checking => "1Passwordにつないで確かめています…",
        OnePasswordResultKind.Connected => "連携できました。" + Detail,
        OnePasswordResultKind.Failed => "連携できませんでした。" + Detail,
        OnePasswordResultKind.Off => "連携を解除しました。",
        _ => ""
    };
    // The PATCH response's setting. Unlike the header line, no connection means no detail here (same as Web).
    public static OnePasswordResult Saved(FeatureSetting setting) => OnePasswordItem.State(setting) switch
    {
        OnePasswordState.Failed => new(OnePasswordResultKind.Failed, setting.ErrorMessage),
        OnePasswordState.Connected => new(OnePasswordResultKind.Connected, setting.Connection is null ? "" : OnePasswordItem.ConnectionLine(setting) ?? ""),
        _ => Off
    };
    // A settings read (or opening the page): a failure is shown, a shown failure that cleared is hidden, the rest stays.
    public OnePasswordResult Refreshed(FeatureSetting setting)
    {
        if (Kind == OnePasswordResultKind.Checking) return this;
        if (OnePasswordItem.State(setting) == OnePasswordState.Failed) return Saved(setting);
        return Kind == OnePasswordResultKind.Failed ? None : this;
    }
}
