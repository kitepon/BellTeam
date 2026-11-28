using System.Net;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace BellTeam.Core;

// The secret input card's rules (docs/secret-input.md, usage secret-credentials.md, Web secret-input.js, Mac SecretInputSheet).
// `inputOptions` and `oneTime` are read leniently: a value of the wrong type reads as absent, so one odd request never breaks the history.
public sealed record SecretInputOptions(string? Preferred, bool OnePasswordAvailable)
{
    // 1Password is the default choice unless the server prefers the stored input.
    public bool OpensWithOnePassword => OnePasswordAvailable && Preferred != "stored";
}
public sealed class SecretInputOptionsReader : LenientObjectReader<SecretInputOptions>
{
    protected override SecretInputOptions From(JsonElement element) => new(Text(element, "preferred"), element.TryGetProperty("onePasswordAvailable", out var value) && value.ValueKind == JsonValueKind.True);
}
public sealed class LenientTrueReader : JsonConverter<bool>
{
    public override bool HandleNull => true;
    public override bool Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        using var document = JsonDocument.ParseValue(ref reader);
        return document.RootElement.ValueKind == JsonValueKind.True;
    }
    public override void Write(Utf8JsonWriter writer, bool value, JsonSerializerOptions options) => throw new NotSupportedException();
}

// What the card sends: {value} or {source:"onepassword", reference}. No ToString on purpose: the value must never reach a log or a message.
public sealed class SecretSubmission
{
    private SecretSubmission(Dictionary<string, string> body) => Body = body;
    public Dictionary<string, string> Body { get; }
    public static SecretSubmission Value(string value) => new(new() { ["value"] = value });
    public static SecretSubmission OnePassword(string reference) => new(new() { ["source"] = "onepassword", ["reference"] = reference.Trim() });
    // Same check as the Web and Mac cards; the server validates the full form.
    public static string? ReferenceProblem(string reference) => reference.Trim().StartsWith("op://", StringComparison.Ordinal) ? null : CoreStrings.SecretInput_ReferenceProblem_1;
}

// GET /api/secret-requests/{id}/onepassword-items -> { items: [{ title, vault, reference }] }. The reference is only submitted, never shown.
public sealed record OnePasswordKey(string Title, string? Vault, string Reference)
{
    // The picker's rows: a sudo picker keeps only references ending in /password (an older body lists SSH keys for every purpose);
    // the search matches the title or the vault, ignoring case.
    public static OnePasswordKey[] Choices(IEnumerable<OnePasswordKey> keys, bool sudo, string search)
    {
        var query = search.Trim();
        return keys.Where(key => (!sudo || key.Reference.EndsWith("/password", StringComparison.Ordinal)) && (query.Length == 0 || $"{key.Title}\n{key.Vault}".Contains(query, StringComparison.OrdinalIgnoreCase))).ToArray();
    }
    // The first line above the rows. noun is 鍵 or パスワード.
    public static string CountLine(int shown, string search, string noun) => shown > 0 ? CoreStrings.SecretInput_CountLine_1(shown) : CoreStrings.SecretInput_CountLine_2(search.Trim(), noun);
}
public sealed record OnePasswordKeysResponse { public OnePasswordKey[] Items { get; init; } = []; }

public sealed class SecretRequestApi(BellApi api)
{
    // null means an older body (HTTP 404): the card falls back to the input field. Any other failure throws.
    public async Task<OnePasswordKey[]?> KeysAsync(string requestId, CancellationToken token = default)
    {
        try { return (await api.GetAsync<OnePasswordKeysResponse>($"/api/secret-requests/{Uri.EscapeDataString(requestId)}/onepassword-items", token)).Items; }
        catch (BellApiException error) when (error.Status == HttpStatusCode.NotFound) { return null; }
    }
}

public enum KeyListState { Loading, Loaded, Failed, Unsupported }

// The state and wording of one open secret input card (Mac SecretInputSheet). The window only draws it.
public sealed class SecretInputModel
{
    private OnePasswordKey[] loaded = [];
    public SecretInputModel(SecretRequest request) { Request = request; UseOnePassword = request.OpensWithOnePassword; }
    public SecretRequest Request { get; }
    public bool UseOnePassword { get; set; }
    public KeyListState Keys { get; private set; } = KeyListState.Loading;
    public string Search { get; private set; } = "";
    // The chosen 1Password item (picker) or the typed op:// reference (reference field).
    public string Reference { get; set; } = "";

    // An OpenSSH private key is multiline; a password box would drop its newlines.
    public bool Multiline => Request.Purpose == "terminal.ssh";
    public bool Sudo => Request.Purpose == "terminal.sudo";
    public string Noun => Multiline ? CoreStrings.SecretInput_Noun_1 : CoreStrings.SecretInput_Noun_2;
    public bool OnePasswordOffered => Request.OnePasswordOffered;
    // An SSH key or sudo card with 1Password connected picks an existing item by name; other cards type a reference.
    public bool Picker => (Multiline || Sudo) && OnePasswordOffered && Keys != KeyListState.Unsupported;
    public bool ChoicesShown => OnePasswordOffered && !((Multiline || Sudo) && Keys == KeyListState.Unsupported);
    // Both choices say where the value comes from; only the note says whether it is kept (Owner 2026-11-11).
    public string OnePasswordChoice => Picker ? CoreStrings.SecretInput_OnePasswordChoice_1 : CoreStrings.SecretInput_OnePasswordChoice_2;
    public string InputChoice => Multiline ? CoreStrings.SecretInput_InputChoice_1 : CoreStrings.SecretInput_InputChoice_2;
    // Mac SecretInputSheet: the login password reads 「パスワードを渡す」, another one-time value 「渡して続ける」.
    public string SubmitLabel => Request.IsLoginPassword ? CoreStrings.SecretInput_SubmitLabel_1 : Request.UsedOnce ? CoreStrings.SecretInput_SubmitLabel_2 : CoreStrings.SecretInput_SubmitLabel_3;
    public bool Ready(string value) => UseOnePassword ? Reference.Trim().Length != 0 : value.Length != 0;

    public string Note
    {
        get
        {
            // The server words the login card per terminal OS (このMac／このPC／このLinux); the constant is only for a server that sends no message.
            if (Request.IsLoginPassword) return Request.Message.Length != 0 ? Request.Message : SecretRequest.LoginPasswordText;
            if (Request.IsOneTime) return SecretRequest.OneTimeText;
            if (UseOnePassword) return Picker ? CoreStrings.SecretInput_Note_1(Noun, Noun) : CoreStrings.SecretInput_Note_2;
            if (Sudo) return CoreStrings.SecretInput_Note_3;
            return Multiline
                ? CoreStrings.SecretInput_Note_4
                : CoreStrings.SecretInput_Note_5;
        }
    }
    // Shown under the note when the server has no list (older body).
    public string? UnsupportedLine => (Multiline || Sudo) && OnePasswordOffered && Keys == KeyListState.Unsupported
        ? Multiline ? CoreStrings.SecretInput_UnsupportedLine_1 : CoreStrings.SecretInput_UnsupportedLine_2 : null;
    public string EmptyLine => Multiline ? CoreStrings.SecretInput_EmptyLine_1 : CoreStrings.SecretInput_EmptyLine_2;
    public string FailedLine => CoreStrings.SecretInput_FailedLine_1(Noun);
    public string LoadingLine => CoreStrings.SecretInput_LoadingLine_1(Noun);

    public OnePasswordKey[] Shown => OnePasswordKey.Choices(loaded, Sudo, Search);
    public string CountLine => OnePasswordKey.CountLine(Shown.Length, Search, Noun);
    public bool HasKeys => Keys == KeyListState.Loaded && loaded.Length != 0;

    public void Loading() => Keys = KeyListState.Loading;
    public void KeysLoaded(OnePasswordKey[]? keys)
    {
        if (keys is null) { Keys = KeyListState.Unsupported; UseOnePassword = false; return; }
        loaded = OnePasswordKey.Choices(keys, Sudo, ""); Keys = KeyListState.Loaded;
    }
    public void KeysFailed() => Keys = KeyListState.Failed;
    // A selection the search no longer shows is cleared, as on the Web card. The search text is not secret and is never sent.
    public void SetSearch(string search)
    {
        Search = search;
        if (Reference.Length != 0 && !Shown.Any(key => key.Reference == Reference)) Reference = "";
    }
}
