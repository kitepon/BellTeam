using System.Globalization;
using System.Net;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace BellTeam.Core;

// Settings 「端末」 (docs/architecture/modules/terminals/README.md, the Mac's apple/terminals.md and Core/Terminals.swift).
// Every field the server added after the first version is optional when reading.

// terminals "Windows and Linux terminals": the registry's `os`. Terminal.Os stays the raw string, so a value this app does not know
// is shown as sent; every text defaults to macOS wording.
public static class TerminalOS
{
    public const string Macos = "macos";
    public const string Windows = "windows";
    public const string Linux = "linux";
    public static readonly string[] All = [Macos, Windows, Linux];
    public static string Label(string os) => os switch { Macos => "macOS", Windows => "Windows", Linux => "Linux", _ => os };
    // The terminal as the noun of a sentence.
    public static string Machine(string os) => os switch { Macos => "Mac", Windows => "Windows PC", Linux => CoreStrings.Terminals_Machine_1, _ => CoreStrings.SettingsStatus_Title_4 };
    // The one step that lets BellTeam reach the terminal over SSH (terminals CONNECTION_REFUSED action, per OS).
    public static string SshStep(string os) => os switch
    {
        Windows => CoreStrings.Terminals_SshStep_1,
        Linux => CoreStrings.Terminals_SshStep_2,
        _ => CoreStrings.Terminals_SshStep_3
    };
    // Windows has no sudo key (terminals: a sudoKeyRef on a windows record is refused).
    public static bool UsesSudoKey(string os) => os != Windows;
}

public enum TerminalKeyKind { Ssh, Sudo }
public static class TerminalKeyKinds
{
    public static string Title(this TerminalKeyKind kind) => kind == TerminalKeyKind.Ssh ? CoreStrings.Terminals_Title_1 : CoreStrings.Terminals_Title_2;
    public static string Wire(this TerminalKeyKind kind) => kind == TerminalKeyKind.Ssh ? "ssh" : "sudo";
}

public enum TerminalKeyStatus { Unsupported, Missing, Pending, Configured }

// One key row (apple/terminals.md AT07/AT08).
public sealed record TerminalKeyState(TerminalKeyStatus Status, bool Configured = false, string? Source = null)
{
    public static readonly TerminalKeyState Unsupported = new(TerminalKeyStatus.Unsupported), Missing = new(TerminalKeyStatus.Missing);
    public static string SourceLabel(string source) => source == "terminal-native" ? CoreStrings.Terminals_SourceLabel_1 : CoreStrings.Terminals_SourceLabel_2;
    public string Text => Status switch
    {
        TerminalKeyStatus.Unsupported => CoreStrings.Terminals_Text_1,
        TerminalKeyStatus.Missing => CoreStrings.PlanningModels_StatusText_4,
        TerminalKeyStatus.Pending => CoreStrings.Terminals_Text_3,
        _ => CoreStrings.SettingsStatus_Terminals_8
    };
    // A configured key stays in use until a pending one binds, so its source is shown in both states.
    public string? SourceText => Status is TerminalKeyStatus.Configured or TerminalKeyStatus.Pending ? Source : null;
    public string SetTitle => Status == TerminalKeyStatus.Configured || Status == TerminalKeyStatus.Pending && Configured ? CoreStrings.Terminals_SetTitle_1 : CoreStrings.Terminals_SetTitle_2;
    public bool Removable => Status is TerminalKeyStatus.Configured or TerminalKeyStatus.Pending;
}

// C8: the last Claude Code upkeep outcome on that terminal (server memory; null until a launch ran it).
public sealed record TerminalMaintenance(string? ObservedAt, string? Before, string? After, string? Outcome)
{
    public string Text => Outcome switch
    {
        "current" => CoreStrings.Terminals_Text_6((After is null ? "" : CoreStrings.AppLogin_RefusedText_4(After))),
        "updated" => CoreStrings.Terminals_Text_8(((Before ?? After) is null ? "" : CoreStrings.Terminals_Text_7(Before ?? "-", After ?? "-"))),
        "failed" => CoreStrings.Terminals_Text_9,
        _ => CoreStrings.Terminals_Text_10
    };
}

// terminals #858: the last key-authorization outcome (server memory only). Absent fields read as null.
public sealed record KeyAuthorization(string? RequestId, string? Outcome, string? ObservedAt);

[JsonConverter(typeof(TerminalReader))]
public sealed record Terminal
{
    public required string TerminalId { get; init; }
    public string Host { get; init; } = "";
    public string User { get; init; } = "";
    public int Port { get; init; } = 22;
    public string Os { get; init; } = TerminalOS.Macos;
    public string AccountOwner { get; init; } = "owner";
    public bool SshKeyConfigured { get; init; }
    public bool SudoKeyConfigured { get; init; }
    public bool HostTrusted { get; init; }
    public TerminalMaintenance? Maintenance { get; init; }
    // terminals #811: `terminal-native` | `secret` | null. Never a handle, value or op:// reference.
    public string? KeySource { get; init; }
    public string? SudoKeySource { get; init; }
    public bool SshKeyPending { get; init; }
    public bool SudoKeyPending { get; init; }
    // terminals #858: true from POST keys/ssh/authorize until the outcome is recorded.
    public bool KeyAuthorizationPending { get; init; }
    public KeyAuthorization? KeyAuthorization { get; init; }
    // An older BellTeam's projection has no pending fields and no keys route.
    public bool KeysRouteAvailable { get; init; }

    public string Address => $"{User}@{Host}:{Port}";
    public string OsLabel => TerminalOS.Label(Os);
    public string OwnerLabel => AccountOwner == "terminal-owner" ? CoreStrings.Terminals_OwnerLabel_1 : CoreStrings.Terminals_OwnerLabel_2;

    public TerminalKeyState Key(TerminalKeyKind kind)
    {
        if (!KeysRouteAvailable) return TerminalKeyState.Unsupported;
        var ssh = kind == TerminalKeyKind.Ssh;
        var configured = ssh ? SshKeyConfigured : SudoKeyConfigured;
        var source = (ssh ? KeySource : SudoKeySource) is { } text ? TerminalKeyState.SourceLabel(text) : null;
        if (ssh ? SshKeyPending : SudoKeyPending) return new(TerminalKeyStatus.Pending, configured, configured ? source : null);
        return configured ? new(TerminalKeyStatus.Configured, true, source) : TerminalKeyState.Missing;
    }
}

// The Mac reads absent and null as the default, a wrong type as a failed read, and takes hostTrust, maintenance and keyAuthorization leniently
// (an odd shape is "none"). The caller turns the JsonException into the usual unreadable-answer message.
public sealed class TerminalReader : JsonConverter<Terminal>
{
    public override Terminal Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        using var document = JsonDocument.ParseValue(ref reader);
        var e = document.RootElement;
        if (e.ValueKind != JsonValueKind.Object) throw new JsonException(CoreStrings.Terminals_Read_1);
        var ssh = Flag(e, "sshKeyPending");
        return new Terminal
        {
            TerminalId = Text(e, "terminalId") ?? throw new JsonException(CoreStrings.Terminals_Read_2),
            Host = Text(e, "host") ?? "", User = Text(e, "user") ?? "", Port = Port(e), Os = Text(e, "os") ?? TerminalOS.Macos, AccountOwner = Text(e, "accountOwner") ?? "owner",
            SshKeyConfigured = Flag(e, "sshKeyConfigured") ?? false, SudoKeyConfigured = Flag(e, "sudoKeyConfigured") ?? false,
            HostTrusted = e.TryGetProperty("hostTrust", out var trust) && trust.ValueKind == JsonValueKind.Object,
            Maintenance = Lenient(e, "maintenance", ["observedAt", "before", "after", "outcome"], v => new TerminalMaintenance(v[0], v[1], v[2], v[3])),
            KeySource = Text(e, "keySource"), SudoKeySource = Text(e, "sudoKeySource"),
            SshKeyPending = ssh ?? false, SudoKeyPending = Flag(e, "sudoKeyPending") ?? false, KeysRouteAvailable = ssh is not null,
            KeyAuthorizationPending = Flag(e, "keyAuthorizationPending") ?? false,
            KeyAuthorization = Lenient(e, "keyAuthorization", ["requestId", "outcome", "observedAt"], v => new KeyAuthorization(v[0], v[1], v[2]))
        };
    }
    public override void Write(Utf8JsonWriter writer, Terminal value, JsonSerializerOptions options) => throw new NotSupportedException();

    private static string? Text(JsonElement e, string name)
        => !e.TryGetProperty(name, out var value) || value.ValueKind == JsonValueKind.Null ? null : value.ValueKind == JsonValueKind.String ? value.GetString() : throw new JsonException(CoreStrings.Terminals_Text_11(name));
    private static bool? Flag(JsonElement e, string name)
        => !e.TryGetProperty(name, out var value) || value.ValueKind == JsonValueKind.Null ? null : value.ValueKind is JsonValueKind.True or JsonValueKind.False ? value.GetBoolean() : throw new JsonException(CoreStrings.Terminals_Flag_1(name));
    private static int Port(JsonElement e)
        => !e.TryGetProperty("port", out var value) || value.ValueKind == JsonValueKind.Null ? 22 : value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var port) ? port : throw new JsonException(CoreStrings.Terminals_Port_1);
    private static T? Lenient<T>(JsonElement e, string name, string[] fields, Func<string?[], T> build) where T : class
    {
        if (!e.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Object) return null;
        var values = new string?[fields.Length];
        for (var index = 0; index < fields.Length; index++)
        {
            if (!value.TryGetProperty(fields[index], out var field) || field.ValueKind == JsonValueKind.Null) continue;
            if (field.ValueKind != JsonValueKind.String) return null;
            values[index] = field.GetString();
        }
        return build(values);
    }
}

public sealed record TerminalsResponse { public required Terminal[] Terminals { get; init; } }
public sealed record TerminalKeyRequestResponse { public required SecretRequest SecretRequest { get; init; } }

public sealed record TerminalCheck
{
    public required string TerminalId { get; init; }
    public string? ObservedAt { get; init; }
    public required bool Reachable { get; init; }
    public string? Reason { get; init; }
    public string? Action { get; init; }

    public enum ProblemKind { Unreachable, Refused, AuthFailed, Credential, HostKey, NotFound, Other }

    public ProblemKind? Problem
    {
        get
        {
            if (Reachable) return null;
            var reason = Reason ?? "";
            return reason switch
            {
                "CONNECTION_REFUSED" => ProblemKind.Refused,
                "AUTH_FAILED" => ProblemKind.AuthFailed,
                "TERMINAL_UNAVAILABLE" or "UNREACHABLE" or "CONNECTION_LOST" => ProblemKind.Unreachable,
                _ when reason.StartsWith("REMOTE_AITERM_", StringComparison.Ordinal) => ProblemKind.Unreachable,
                "CREDENTIAL_UNAVAILABLE" or "SSH_KEY_UNSET" => ProblemKind.Credential,
                _ when reason.StartsWith("CREDENTIAL_", StringComparison.Ordinal) => ProblemKind.Credential,
                "TARGET_MISMATCH" => ProblemKind.HostKey,
                _ when reason.StartsWith("HOST_TRUST_", StringComparison.Ordinal) || reason.StartsWith("HOST_KEY_", StringComparison.Ordinal) => ProblemKind.HostKey,
                "TERMINAL_NOT_FOUND" => ProblemKind.NotFound,
                _ => ProblemKind.Other
            };
        }
    }

    public string Summary => Reachable ? CoreStrings.Terminals_Summary_1 : CoreStrings.Terminals_Summary_2;

    // Reasons are evidence, not diagnoses (terminals README step 4): the sentence names the likely fix. The server's own Japanese action
    // text wins when the body carries it; older bodies get the same meaning from here.
    public string? Explanation(string os = TerminalOS.Macos)
    {
        var machine = TerminalOS.Machine(os);
        return Problem switch
        {
            null => null,
            ProblemKind.Refused => ActionText ?? (os == TerminalOS.Macos ? CoreStrings.Terminals_Explanation_1 : CoreStrings.Terminals_Explanation_2(machine, TerminalOS.SshStep(os))),
            ProblemKind.AuthFailed => ActionText ?? CoreStrings.Terminals_Explanation_3(machine),
            ProblemKind.Unreachable => Reason == "UNREACHABLE"
                ? CoreStrings.Terminals_Explanation_4(machine, machine)
                : CoreStrings.Terminals_Explanation_5,
            ProblemKind.Credential => CoreStrings.Terminals_Explanation_6,
            ProblemKind.HostKey => CoreStrings.Terminals_Explanation_7,
            ProblemKind.NotFound => CoreStrings.Terminals_Explanation_8,
            _ => CoreStrings.Terminals_Explanation_9
        };
    }
    private string? ActionText => string.IsNullOrWhiteSpace(Action) ? null : Action.Trim();

    // The server's action as a second line, only for reasons whose sentence above does not already carry it.
    public string? ExtraAction => Problem is ProblemKind.Refused or ProblemKind.AuthFailed ? null : ActionText;
    // 「この<OS>にこの鍵を入れる」 is offered when the key is rejected as not yet on the terminal.
    public bool OffersAuthorize => Problem == ProblemKind.AuthFailed;
    // A fingerprint only when the server's action text carries one; the response has no fingerprint field.
    public string? ReportedFingerprint => Action is null ? null : Regex.Match(Action, "SHA256:[A-Za-z0-9+/]{43}") is { Success: true } match ? match.Value : null;
}

internal static class TerminalPattern
{
    // The whole text matches (a trailing newline is not "the end", unlike $).
    public static bool Whole(string text, string pattern, RegexOptions options = RegexOptions.None) => Regex.IsMatch(text, @"\A(?:" + pattern + @")\z", options);
}

public static class HostKeyFingerprint
{
    // Same form the server checks (core.mjs fingerprintPattern).
    public static string? Problem(string value)
    {
        var text = value.Trim();
        if (text.Length == 0) return CoreStrings.Terminals_Problem_1;
        return TerminalPattern.Whole(text, "SHA256:[A-Za-z0-9+/]{43}") ? null : CoreStrings.Terminals_Problem_2;
    }
}

public enum TerminalField { TerminalId, Host, User, Port }

// The fields the registry accepts from a person. Keys are never part of it.
public sealed class TerminalDraft
{
    public string TerminalId = "", Host = "", User = "", Port = "22";
    // Sent back as read, so an edit never turns a Windows or Linux terminal into macOS.
    public string Os = TerminalOS.Macos;
    public string AccountOwner = "owner";
    public TerminalDraft() { }
    public TerminalDraft(Terminal terminal) { TerminalId = terminal.TerminalId; Host = terminal.Host; User = terminal.User; Port = terminal.Port.ToString(CultureInfo.InvariantCulture); Os = terminal.Os; AccountOwner = terminal.AccountOwner; }

    // registry.mjs validate(): same patterns, plain Japanese.
    public Dictionary<TerminalField, string> Problems(bool isNew)
    {
        var result = new Dictionary<TerminalField, string>();
        if (isNew && !TerminalPattern.Whole(TerminalId, "[a-z0-9][a-z0-9-]{0,62}")) result[TerminalField.TerminalId] = CoreStrings.Terminals_Problems_1;
        if (!ValidHost(Host)) result[TerminalField.Host] = CoreStrings.Terminals_Problems_2;
        if (!TerminalPattern.Whole(User, "[a-z_][a-z0-9_.-]*[$]?", RegexOptions.IgnoreCase)) result[TerminalField.User] = CoreStrings.Terminals_Problems_3;
        if (PortNumber(Port) is null) result[TerminalField.Port] = CoreStrings.Terminals_Problems_4;
        return result;
    }

    public static int? PortNumber(string text) => TerminalPattern.Whole(text, "[0-9]{1,5}") && int.Parse(text, CultureInfo.InvariantCulture) is >= 1 and <= 65535 and var value ? value : null;

    // IPv4 and DNS names share the server's name pattern; IPv6 is checked loosely and left to the server's isIP.
    public static bool ValidHost(string host)
        => host.Contains(':') ? TerminalPattern.Whole(host, "[0-9A-Fa-f:.]+") : host.Length <= 253 && TerminalPattern.Whole(host, "[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", RegexOptions.IgnoreCase);

    // The body of PUT /api/terminals/:id.
    public object Body => new { host = Host, user = User, port = PortNumber(Port) ?? 0, os = Os, accountOwner = AccountOwner };
}

// Step 4 (terminals README S4): 「この<OS>にこの鍵を入れる」. The login password goes only into the terminal.login card; this only words what the server reports.
public sealed record AuthorizeNote(string Text, bool Retry = false);
public abstract record AuthorizeState
{
    // The card was submitted; the terminal is read until keyAuthorizationPending is false. ReadFailed: the last read failed and is retried.
    public sealed record Waiting(string RequestId, bool ReadFailed) : AuthorizeState;
    public sealed record Shown(AuthorizeNote Note) : AuthorizeState;
    // The button asks again (a new request replaces the old one).
    public bool Retry => this is Shown { Note.Retry: true };
}

public static class TerminalAuthorize
{
    public static string WaitingText(string os = TerminalOS.Macos) => CoreStrings.Terminals_WaitingText_1(TerminalOS.Machine(os));
    public static string ReadFailedText  => CoreStrings.Terminals_ReadFailedText_1;

    // null = the key is on the terminal (AUTHORIZED / ALREADY_AUTHORIZED): the check runs by itself.
    public static AuthorizeNote? Note(string? outcome, string os = TerminalOS.Macos)
    {
        var m = TerminalOS.Machine(os);
        return (outcome ?? "") switch
        {
            "AUTHORIZED" or "ALREADY_AUTHORIZED" => null,
            "PASSWORD_REJECTED" => new(CoreStrings.Terminals_Note_1, true),
            "PASSWORD_AUTH_DISABLED" => new(CoreStrings.Terminals_Note_2(m, m)),
            "AUTHORIZATION_UNCONFIRMED" => new(CoreStrings.Terminals_Note_3, true),
            "TERMINAL_CHANGED" => new(CoreStrings.Terminals_Note_4, true),
            "TERMINAL_UNAVAILABLE" => new(CoreStrings.Terminals_Note_5(m, m), true),
            "CREDENTIAL_UNAVAILABLE" => new(CoreStrings.Terminals_Note_6),
            _ => new(CoreStrings.Terminals_Note_7(m), true)
        };
    }

    // POST keys/ssh/authorize refusals that have wording; anything else is shown through TerminalErrorText.Message.
    public static AuthorizeNote? Refusal(Exception error, string os = TerminalOS.Macos)
    {
        if (error is not BellApiException { Status: { } status }) return null;
        var m = TerminalOS.Machine(os);
        var code = TerminalErrorText.Code(error);
        return ((int)status, code) switch
        {
            (409, "HOST_TRUST_MISSING") => new(CoreStrings.Terminals_Refusal_1(m)),
            (409, "SSH_KEY_UNSET") => new(CoreStrings.Terminals_Refusal_2),
            (503, "CREDENTIAL_UNAVAILABLE") => new(CoreStrings.Terminals_Refusal_3, true),
            (404, not "TERMINAL_NOT_FOUND") => new(CoreStrings.Terminals_Refusal_4(m)),
            _ => null
        };
    }
}

public static class TerminalErrorText
{
    // The server's machine-readable error (BellApiException.Code).
    public static string? Code(Exception error) => (error as BellApiException)?.Code;

    // 404/405 on the list: this BellTeam has no terminals route (older body), as Web. A 503 TERMINALS_UNAVAILABLE is a failure.
    public static bool IsUnsupported(Exception error) => error is BellApiException { Status: HttpStatusCode.NotFound or HttpStatusCode.MethodNotAllowed };

    // A keys route that answers 404 without TERMINAL_NOT_FOUND is a BellTeam without it (older body).
    public static bool IsKeysUnsupported(Exception error) => error is BellApiException { Status: HttpStatusCode.NotFound } && Code(error) != "TERMINAL_NOT_FOUND";

    // A folders route that answers 404 (no TERMINAL_NOT_FOUND) or 405 is a BellTeam without the picker (older body).
    public static bool IsFoldersUnsupported(Exception error) => error is BellApiException { Status: HttpStatusCode.MethodNotAllowed } || error is BellApiException { Status: HttpStatusCode.NotFound } && Code(error) != "TERMINAL_NOT_FOUND";

    // The member save's input refusals (members C1), worded for the terminal's OS.
    public static string? Member(string code, string os = TerminalOS.Macos) => code switch
    {
        "BOT_TERMINAL_ID_INVALID" => CoreStrings.Terminals_Member_1,
        "BOT_PROJECT_ROOT_INVALID" when os == TerminalOS.Windows => CoreStrings.Terminals_Member_2,
        "BOT_PROJECT_ROOT_INVALID" => CoreStrings.Terminals_Member_3,
        "BOT_REMOTE_BINDING_INVALID" => CoreStrings.Terminals_Member_4,
        _ => null
    };

    // The server's message for INVALID_TERMINAL starts with the field name (registry.mjs); it is never echoed to the screen.
    public static string Message(Exception error)
    {
        if (error is BellApiException api)
        {
            switch (api.Code)
            {
                case "INVALID_TERMINAL":
                    return (api.Message.StartsWith("BellTeam: ", StringComparison.Ordinal) ? api.Message[10..] : api.Message).Split(' ')[0] switch
                    {
                        "host" => CoreStrings.Terminals_Message_1,
                        "user" => CoreStrings.Terminals_Message_2,
                        "port" => CoreStrings.Terminals_Message_3,
                        "terminalId" => CoreStrings.Terminals_Message_4,
                        "accountOwner" => CoreStrings.Terminals_Message_5,
                        _ => CoreStrings.Terminals_Message_6
                    };
                case "TERMINAL_NOT_FOUND": return CoreStrings.Terminals_Explanation_8;
                case "TERMINAL_EXISTS": return CoreStrings.Terminals_Message_8;
                case "HOST_KEY_FINGERPRINT_MISMATCH": return CoreStrings.Terminals_Message_9;
                case "INVALID_TERMINAL_STORE": return CoreStrings.Terminals_Message_10;
                case "TERMINALS_UNAVAILABLE": return CoreStrings.Terminals_Message_11;
                case "KEY_IN_REQUEST_REFUSED": return CoreStrings.Terminals_Message_12;
                case "INVALID_KEY_KIND": return CoreStrings.Terminals_Message_13;
                case "CREDENTIAL_UNAVAILABLE": return CoreStrings.Terminals_Message_14;
                case "TERMINAL_UNAVAILABLE": return CoreStrings.Terminals_Message_15;
                case "TERMINAL_CHANGED": return CoreStrings.Terminals_Message_16;
            }
        }
        return BellApiException.IsResultUnconfirmed(error) ? CoreStrings.ManagementModels_Failure_1(error.Message) : error.Message;
    }
}

public sealed class TerminalsApi(BellApi api)
{
    private static string Path(string id) => "/api/terminals/" + Uri.EscapeDataString(id);
    public async Task<Terminal[]> ListAsync(CancellationToken token = default) => (await api.GetAsync<TerminalsResponse>("/api/terminals", token)).Terminals;
    public Task<Terminal> GetAsync(string id, CancellationToken token = default) => api.GetAsync<Terminal>(Path(id), token);
    // PUT registers or updates (patch semantics on the server).
    public Task<Terminal> PutAsync(string id, object body, CancellationToken token = default) => api.WriteAsync<Terminal>(HttpMethod.Put, Path(id), body, token);
    public Task DeleteAsync(string id, CancellationToken token = default) => api.DeleteAsync(Path(id), token);
    // One transient SSH probe on the server; it never launches a seat.
    public Task<TerminalCheck> CheckAsync(string id, CancellationToken token = default) => api.PostAsync<TerminalCheck>(Path(id) + "/check", new { }, token);
    // 16c S2: the host-key fingerprint read on this PC itself. The body has nothing else (the server refuses any other field).
    public async Task<Terminal> TrustAsync(string id, string fingerprint, CancellationToken token = default) => (await api.PostAsync<TerminalTrustResponse>(Path(id) + "/trust", new { fingerprint }, token)).Terminal;
    // An empty POST; the key itself goes only into the returned secret card (KEY_IN_REQUEST_REFUSED otherwise).
    public async Task<SecretRequest> RequestKeyAsync(string id, TerminalKeyKind kind, CancellationToken token = default) => (await api.PostAsync<TerminalKeyRequestResponse>($"{Path(id)}/keys/{kind.Wire()}", new { }, token)).SecretRequest;
    public Task RemoveKeyAsync(string id, TerminalKeyKind kind, CancellationToken token = default) => api.DeleteAsync($"{Path(id)}/keys/{kind.Wire()}", token);
    // Step 4: an empty POST; the login password goes only into the returned terminal.login card.
    public async Task<SecretRequest> AuthorizeAsync(string id, CancellationToken token = default) => (await api.PostAsync<TerminalKeyRequestResponse>(Path(id) + "/keys/ssh/authorize", new { }, token)).SecretRequest;
    // S6: the folders of a terminal; no path = its user's home. Writes nothing.
    public Task<TerminalFolders> FoldersAsync(string id, string? path, CancellationToken token = default) => api.GetAsync<TerminalFolders>(Path(id) + "/folders" + (path is null ? "" : "?path=" + TerminalFolderPicker.Query(path)), token);
    // S6 「新しいフォルダ」: the existing folder route with `create`. One POST; never resent by the app.
    public Task<TerminalFolderStatus> CreateFolderAsync(string id, string path, CancellationToken token = default) => api.PostAsync<TerminalFolderStatus>(Path(id) + "/folder", new { path, create = true }, token);
}

public enum TerminalListState { NotLoaded, Supported, Unsupported, Failed }

// The registry as this app last read it (apple/terminals.md AT01-AT05). Check results and the wait for a key authorization live only here.
public sealed class TerminalsModel(TerminalsApi api, IThisPc? pc = null)
{
    private int readSequence;
    public TerminalListState State { get; private set; }
    public Terminal[] Terminals { get; private set; } = [];
    public string? FailedMessage { get; private set; }
    // A later read failed while a list is shown: the list stays (last known registry) with this reason.
    public string? ReadError { get; private set; }
    public bool Loading { get; private set; }
    // The folders route answered 404 (not TERMINAL_NOT_FOUND) or 405: the member editor shows the typed path from the start. The next read that works clears it.
    public bool FoldersUnsupported { get; private set; }
    public Dictionary<string, TerminalCheck> Checks { get; } = [];
    public HashSet<string> Checking { get; } = [];
    // The wait for 「この端末にこの鍵を入れる」, or the sentence after it. App memory only.
    public Dictionary<string, AuthorizeState> Authorizations { get; } = [];
    public event Action? Changed;
    public void Notify() => Changed?.Invoke();
    public Terminal? Find(string id) => Terminals.FirstOrDefault(item => item.TerminalId == id);

    // A read that fails keeps what was shown: 404 and 405 on the first read mean an older body, any other failure (503 TERMINALS_UNAVAILABLE included)
    // is a failure, and once a list was read every later failure keeps it with ReadError. Never retried by itself.
    public async Task RefreshAsync(CancellationToken token = default)
    {
        var sequence = ++readSequence; Loading = true; Notify();
        try
        {
            var list = await api.ListAsync(token);
            if (sequence != readSequence) return;
            State = TerminalListState.Supported; Terminals = list; ReadError = null; FailedMessage = null;
            foreach (var terminal in list) _ = AttestOnce(terminal);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception error)
        {
            if (sequence != readSequence) return;
            if (State == TerminalListState.Supported) ReadError = TerminalErrorText.Message(error);
            else if (TerminalErrorText.IsUnsupported(error)) State = TerminalListState.Unsupported;
            else { State = TerminalListState.Failed; FailedMessage = TerminalErrorText.Message(error); }
        }
        finally { if (sequence == readSequence) Loading = false; Notify(); }
    }

    // Throws for the screen to show; the list follows the response. Not resent.
    public async Task<Terminal> SaveAsync(string id, TerminalDraft draft, CancellationToken token = default) => Replace(await api.PutAsync(id, draft.Body, token));
    public async Task<Terminal> ConfirmHostKeyAsync(string id, string fingerprint, CancellationToken token = default) => Replace(await api.PutAsync(id, new { confirmHostKey = fingerprint.Trim() }, token));

    private Terminal Replace(Terminal terminal, bool clearsCheck = true)
    {
        var saved = terminal;
        var list = Terminals.ToList();
        var index = list.FindIndex(item => item.TerminalId == saved.TerminalId);
        if (index >= 0) { saved = saved with { Maintenance = saved.Maintenance ?? list[index].Maintenance }; list[index] = saved; } else list.Add(saved);
        State = TerminalListState.Supported; Terminals = list.ToArray();
        // The target or trust changed; an older observation no longer describes it. A plain read of the same terminal keeps it.
        if (clearsCheck)
        {
            Checks.Remove(saved.TerminalId);
            if (Authorizations.TryGetValue(saved.TerminalId, out var state) && state is AuthorizeState.Shown) Authorizations.Remove(saved.TerminalId);
        }
        Notify();
        return saved;
    }

    public async Task RemoveAsync(string id, CancellationToken token = default)
    {
        await api.DeleteAsync(id, token);
        Terminals = Terminals.Where(item => item.TerminalId != id).ToArray(); Checks.Remove(id); Authorizations.Remove(id); TrustNotes.Remove(id); Attested.Remove(id); Notify();
    }

    // The server stores the new request (the projection says pending) and answers the card to open.
    public async Task<SecretRequest> RequestKeyAsync(string id, TerminalKeyKind kind, CancellationToken token = default)
    {
        var request = await api.RequestKeyAsync(id, kind, token);
        await RefreshAsync(token);
        return request;
    }
    // The server unbinds the key (or cancels a pending card) and clears it; the list is read again.
    public async Task RemoveKeyAsync(string id, TerminalKeyKind kind, CancellationToken token = default) { await api.RemoveKeyAsync(id, kind, token); await RefreshAsync(token); }

    // ---- 16c S2: this PC attests its own host key (App memory only) ----
    public IThisPc? Pc => pc;
    public HashSet<string> Attesting { get; } = [];
    // The line to show per terminal after an attempt, and the terminals already tried (automatically) since this connection.
    public Dictionary<string, TrustNote> TrustNotes { get; } = [];
    public HashSet<string> Attested { get; } = [];
    private Task attestations = Task.CompletedTask;
    // Completes when every attestation started so far has ended.
    public Task AttestationsDone => attestations;
    public bool OwnsHost(Terminal terminal) => pc is not null && ThisPcFacts.Owns(terminal.Host, pc);

    // The two automatic triggers (right after a new terminal was saved, and a list read): an untrusted terminal whose host is this PC is attested once per connection.
    public Task AttestOnce(Terminal terminal)
    {
        if (terminal.HostTrusted || !OwnsHost(terminal) || !Attested.Add(terminal.TerminalId)) return Task.CompletedTask;
        var run = AttestAsync(terminal.TerminalId);
        attestations = Task.WhenAll(attestations, run);
        return run;
    }

    // Read this PC's host key and send only the fingerprint; the server trusts it only when its own scan is equal. Every outcome becomes a line
    // (TrustNotes) and nothing is thrown. TERMINAL_CHANGED is sent once more, as the Mac's attestThisMac does (the same fingerprint is harmless twice).
    public async Task AttestAsync(string id, CancellationToken token = default)
    {
        if (pc is null || !Attesting.Add(id)) return;
        TrustNotes.Remove(id); Notify();
        try
        {
            string fingerprint;
            try { fingerprint = HostKeyFile.Fingerprint(await pc.ReadHostKeyAsync(token)); }
            catch (Exception error) when (!token.IsCancellationRequested) { TrustNotes[id] = ThisPcTrust.Local(error); return; }
            for (var attempt = 0; ; attempt++)
            {
                try { Replace(await api.TrustAsync(id, fingerprint, token)); break; }
                catch (BellApiException error) when (error.RequiresLogin) { break; }
                catch (Exception error) when (attempt == 0 && !token.IsCancellationRequested && TerminalErrorText.Code(error) == "TERMINAL_CHANGED") { }
                catch (Exception error) when (!token.IsCancellationRequested) { if (ThisPcTrust.Server(error) is { } note) TrustNotes[id] = note; break; }
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        finally { Attesting.Remove(id); Notify(); }
    }

    // One transient SSH probe on the server; it never launches a seat. Concurrent presses share the one in flight.
    public async Task CheckAsync(string id, CancellationToken token = default)
    {
        if (!Checking.Add(id)) return;
        Notify();
        try
        {
            Checks[id] = await api.CheckAsync(id, token);
            // The server adopts a first host key during the check; read the list so the adopted trust shows.
            if (Find(id)?.HostTrusted == false) await RefreshAsync(token);
        }
        finally { Checking.Remove(id); Notify(); }
    }

    public async Task<TerminalFolders> FoldersAsync(string id, string? path, CancellationToken token = default)
    {
        try
        {
            var result = await api.FoldersAsync(id, path, token);
            if (FoldersUnsupported) { FoldersUnsupported = false; Notify(); }
            return result;
        }
        catch (Exception error) when (TerminalErrorText.IsFoldersUnsupported(error)) { if (!FoldersUnsupported) { FoldersUnsupported = true; Notify(); } throw; }
    }
    public Task<TerminalFolderStatus> CreateFolderAsync(string id, string path, CancellationToken token = default) => api.CreateFolderAsync(id, path, token);

    // A note about a new check is stale; the check itself replaces it.
    public void ClearNote(string id) { if (Authorizations.TryGetValue(id, out var state) && state is AuthorizeState.Shown) { Authorizations.Remove(id); Notify(); } }

    // Step 4: null = refused with wording (no trust yet, no key, older body): the sentence is in Authorizations. Not resent.
    public async Task<SecretRequest?> RequestKeyAuthorizationAsync(string id, CancellationToken token = default)
    {
        Authorizations.Remove(id); Notify();
        try { return await api.AuthorizeAsync(id, token); }
        catch (Exception error)
        {
            if (TerminalAuthorize.Refusal(error, Find(id)?.Os ?? TerminalOS.Macos) is { } note) { Authorizations[id] = new AuthorizeState.Shown(note); Notify(); return null; }
            throw;
        }
    }

    // After the card was submitted: read the terminal until keyAuthorizationPending is false and the outcome is this request's. There is no cap and
    // no give-up; a failed read is retried on the next tick. It ends with the outcome, a newer request for this terminal (the observed one is
    // replaced), or the token being cancelled. A kept key runs the check by itself, once.
    public async Task AwaitKeyAuthorizationAsync(string id, string requestId, TimeSpan? interval = null, CancellationToken token = default)
    {
        bool Observing() => !token.IsCancellationRequested && Authorizations.TryGetValue(id, out var state) && state is AuthorizeState.Waiting waiting && waiting.RequestId == requestId;
        Authorizations[id] = new AuthorizeState.Waiting(requestId, false); Notify();
        string? outcome = null; var first = true;
        while (outcome is null)
        {
            if (!first) { try { await Task.Delay(interval ?? TimeSpan.FromSeconds(1), token); } catch (OperationCanceledException) { } }
            first = false;
            if (!Observing()) return;
            try
            {
                var terminal = await api.GetAsync(id, token);
                if (!Observing()) return;
                Replace(terminal, clearsCheck: false);
                Authorizations[id] = new AuthorizeState.Waiting(requestId, false);
                if (!terminal.KeyAuthorizationPending && terminal.KeyAuthorization?.RequestId == requestId) outcome = terminal.KeyAuthorization.Outcome ?? "";
                Notify();
            }
            catch (Exception error)
            {
                // A cancelled token ends the wait; a timeout of one read is a failed read like any other and is retried.
                if (!Observing()) return;
                if (error is BellApiException { RequiresLogin: true }) { Authorizations.Remove(id); Notify(); return; }
                if (TerminalErrorText.Code(error) == "TERMINAL_NOT_FOUND") { Authorizations[id] = new AuthorizeState.Shown(new(TerminalErrorText.Message(error))); Notify(); return; }
                Authorizations[id] = new AuthorizeState.Waiting(requestId, true); Notify();
            }
        }
        var os = Find(id)?.Os ?? TerminalOS.Macos;
        if (TerminalAuthorize.Note(outcome, os) is { } note) { Authorizations[id] = new AuthorizeState.Shown(note); Notify(); return; }
        Authorizations.Remove(id); Checks.Remove(id); Notify();
        try { await CheckAsync(id, token); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (BellApiException error) when (error.RequiresLogin) { }
        catch (Exception) { Authorizations[id] = new AuthorizeState.Shown(new(CoreStrings.Terminals_AwaitKeyAuthorizationAsync_1(TerminalOS.Machine(os)))); Notify(); }
    }
}
