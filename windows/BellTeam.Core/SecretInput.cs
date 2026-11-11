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
    public static string? ReferenceProblem(string reference) => reference.Trim().StartsWith("op://", StringComparison.Ordinal) ? null : "1Passwordの参照（op://で始まる）を入力してください。";
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
    public static string CountLine(int shown, string search, string noun) => shown > 0 ? $"{shown}件から選んでください" : $"「{search.Trim()}」に合う{noun}がありません";
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
    public string Noun => Multiline ? "鍵" : "パスワード";
    public bool OnePasswordOffered => Request.OnePasswordOffered;
    // An SSH key or sudo card with 1Password connected picks an existing item by name; other cards type a reference.
    public bool Picker => (Multiline || Sudo) && OnePasswordOffered && Keys != KeyListState.Unsupported;
    public bool ChoicesShown => OnePasswordOffered && !((Multiline || Sudo) && Keys == KeyListState.Unsupported);
    // Both choices say where the value comes from; only the note says whether it is kept (Owner 2026-11-11).
    public string OnePasswordChoice => Picker ? "1Passwordから選ぶ" : "1Passwordから読み出す";
    public string InputChoice => Multiline ? "ここに貼り付ける" : "ここに入力する";
    // Mac SecretInputSheet: the login password reads 「パスワードを渡す」, another one-time value 「渡して続ける」.
    public string SubmitLabel => Request.IsLoginPassword ? "パスワードを渡す" : Request.UsedOnce ? "渡して続ける" : "登録して続ける";
    public bool Ready(string value) => UseOnePassword ? Reference.Trim().Length != 0 : value.Length != 0;

    public string Note
    {
        get
        {
            // The server words the login card per terminal OS (このMac／このPC／このLinux); the constant is only for a server that sends no message.
            if (Request.IsLoginPassword) return Request.Message.Length != 0 ? Request.Message : SecretRequest.LoginPasswordText;
            if (Request.IsOneTime) return SecretRequest.OneTimeText;
            if (UseOnePassword) return Picker ? $"選んだ{Noun}は、使うときに1Passwordから読み出します。{Noun}は会話に送られません。" : "参照は会話に送信されません。値は1Passwordから読み出します。";
            if (Sudo) return "sudoのパスワードを入力してください。1Passwordを使っている場合は、設定の「1Password連携」を済ませると、ここで一覧から選べます。値は会話に送信されず、BellTeamの利用者領域へ保存します。";
            return Multiline
                ? "秘密鍵（「-----BEGIN OPENSSH PRIVATE KEY-----」で始まる文字）をそのまま貼ってください。1Passwordを使っている場合は、設定の「1Password連携」を済ませると、ここで鍵を一覧から選べます。値は会話に送信されません。"
                : "値は会話に送信されません。BellTeamの利用者領域へ保存します。";
        }
    }
    // Shown under the note when the server has no list (older body).
    public string? UnsupportedLine => (Multiline || Sudo) && OnePasswordOffered && Keys == KeyListState.Unsupported
        ? Multiline ? "この版のサーバーには1Passwordの鍵の一覧がありません。鍵を貼り付けて保存してください。" : "この版のサーバーには1Passwordのパスワードの一覧がありません。パスワードを入力して保存してください。" : null;
    public string EmptyLine => Multiline ? "1Passwordで読めるSSH鍵がありません。" : "1Passwordで読めるパスワードがありません。";
    public string FailedLine => $"1Passwordの{Noun}一覧を読めませんでした。";
    public string LoadingLine => $"1Passwordの{Noun}を読み込んでいます…";

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
