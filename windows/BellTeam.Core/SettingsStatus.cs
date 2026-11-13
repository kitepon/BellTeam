using System.Net;

namespace BellTeam.Core;

// Live state of every settings item as one line and one badge (Mac SettingsStatus.swift, docs/architecture/modules/apple/settings-user-flow.md §3).
// Pure functions from what the screens already loaded; no network and no view code here.

public enum SettingsTone { Gray, Green, Violet, Orange }

public enum SettingsPage { Profile, Ai, Summary, Terminals, Exclusions, OnePassword, Notifications, Rules, Features, Connection, Display, Billing, Update, About, Stop }

public static class SettingsPages
{
    // Category groups in list order; 全体停止 stays alone at the bottom.
    public static readonly IReadOnlyList<SettingsPage[]> Groups =
    [
        [SettingsPage.Ai, SettingsPage.Summary, SettingsPage.Terminals, SettingsPage.Exclusions, SettingsPage.OnePassword, SettingsPage.Notifications, SettingsPage.Features],
        [SettingsPage.Rules],
        [SettingsPage.Connection, SettingsPage.Display],
        [SettingsPage.Billing, SettingsPage.Update, SettingsPage.About],
        [SettingsPage.Stop]
    ];
    public static string Title(this SettingsPage page) => page switch
    {
        SettingsPage.Profile => "プロフィール", SettingsPage.Ai => "AIの認証", SettingsPage.Summary => "仕事の要約を書くAI", SettingsPage.Terminals => "端末", SettingsPage.Exclusions => "稼働中に数えない処理",
        SettingsPage.OnePassword => "1Password", SettingsPage.Notifications => "通知", SettingsPage.Rules => "チームの決まり", SettingsPage.Features => "追加機能",
        SettingsPage.Connection => "接続", SettingsPage.Display => "表示", SettingsPage.Billing => "利用と課金", SettingsPage.Update => "アップデート",
        SettingsPage.About => "このアプリについて", _ => "全体停止"
    };
    // The calm line: shown while the live state is not known yet, or when an older server does not return the item's data.
    public static string Detail(this SettingsPage page) => page switch
    {
        SettingsPage.Profile => "名前・写真・紹介文",
        SettingsPage.Ai => "AIのアカウントを認証し直す",
        SettingsPage.Summary => "メンバー一覧の「今の仕事」を書くAI",
        SettingsPage.Terminals => "メンバーの席を動かすMac・Windows・Linuxと、その鍵",
        SettingsPage.Exclusions => "席で動いていても仕事中に数えない処理",
        SettingsPage.OnePassword => "1Passwordの鍵をメンバーが使えるようにする",
        SettingsPage.Notifications => "メンバーからの連絡をこの端末に届ける",
        SettingsPage.Rules => "チームが守るあなたの決まり",
        SettingsPage.Features => "通知の送信などを使うための設定",
        SettingsPage.Connection => "つないでいるサーバーとログイン方法",
        SettingsPage.Display => "会話を開く時の動き",
        SettingsPage.Billing => "アプリでAIを使うための月額購読",
        SettingsPage.Update => "サーバーの部品を最新にする",
        SettingsPage.About => "アプリの版",
        _ => "全員のAIの動作をまとめて止める"
    };
}

// Where a tap on an 要対応 row, or a push inside the settings, goes. Harness non-null is the login screen of that AI; Slot is "2nd" for Claude second account.
public sealed record SettingsRoute(SettingsPage Page, string? Harness = null, string? Slot = null);

public sealed record SettingsStatus(string Line, string? Badge = null, SettingsTone Tone = SettingsTone.Gray, bool NeedsAttention = false, SettingsRoute? AttentionRoute = null);

// The effort in plain words for the settings screens (an effort the app does not know is shown as sent).
public static class EffortText
{
    public static string Label(string effort) => effort switch { "" => "CLIの既定", "low" => "低", "medium" => "中", "high" => "高", "xhigh" => "最高", _ => effort };
}

// AIの認証の段階 (Mac AuthenticationProgress). The only finished look is Done; /api/accounts `loggedIn` is never used (an expired credential still said true).
public enum AuthenticationStage { Checking, Unknown, WaitingSite, WaitingCode, SendingCode, Confirming, Done, Failed, NeedsLogin }

public sealed record AuthenticationProgress(AuthenticationStage Stage, string? Reason = null)
{
    public static readonly AuthenticationProgress Checking = new(AuthenticationStage.Checking), Unknown = new(AuthenticationStage.Unknown), WaitingSite = new(AuthenticationStage.WaitingSite),
        WaitingCode = new(AuthenticationStage.WaitingCode), SendingCode = new(AuthenticationStage.SendingCode), Confirming = new(AuthenticationStage.Confirming),
        Done = new(AuthenticationStage.Done), NeedsLogin = new(AuthenticationStage.NeedsLogin);
    public static AuthenticationProgress Failed(string? reason) => new(AuthenticationStage.Failed, reason);

    // auth: the GET/POST answer; null is not loaded yet (loaded false) or a failed read. signedOut: the Claude slot has a signedOutAt.
    public static AuthenticationProgress From(AuthenticationState? auth, bool loaded = true, bool signedOut = false, bool sending = false)
    {
        if (sending) return SendingCode;
        if (auth is null) return loaded ? Unknown : Checking;
        return auth.Status switch
        {
            "authenticated" => signedOut ? NeedsLogin : Done,
            "blocked" => NeedsLogin,
            "failed" => Failed(auth.Message),
            "waiting" => auth.AuthUi?.Stage switch
            {
                "paste_code" => WaitingCode,
                "open_url" or "device_code" or "select" => WaitingSite,
                "failed" => Failed(auth.AuthUi.Message ?? auth.Message),
                _ => Confirming
            },
            _ => Unknown // a status this app does not know is never shown as done
        };
    }

    public bool InProgress => Stage is AuthenticationStage.WaitingSite or AuthenticationStage.WaitingCode or AuthenticationStage.Confirming;

    public string Badge => Stage switch
    {
        AuthenticationStage.Checking or AuthenticationStage.Confirming or AuthenticationStage.SendingCode => "確認中",
        AuthenticationStage.Unknown => "確認できません",
        AuthenticationStage.WaitingSite => "認証の途中",
        AuthenticationStage.WaitingCode => "コード待ち",
        AuthenticationStage.Done => "認証済み",
        AuthenticationStage.Failed => "失敗",
        _ => "ログインが必要"
    };

    public SettingsTone Tone => Stage switch
    {
        AuthenticationStage.Done => SettingsTone.Green,
        AuthenticationStage.WaitingSite or AuthenticationStage.WaitingCode or AuthenticationStage.Confirming or AuthenticationStage.SendingCode => SettingsTone.Violet,
        AuthenticationStage.Failed or AuthenticationStage.NeedsLogin or AuthenticationStage.Unknown => SettingsTone.Orange,
        _ => SettingsTone.Gray
    };

    // The row main button: only for stages that need the user. Done, checking and unreadable show none (opening the row reads again).
    public string? Action => Stage switch
    {
        AuthenticationStage.Failed => "認証し直す",
        AuthenticationStage.NeedsLogin => "認証する",
        AuthenticationStage.WaitingSite or AuthenticationStage.WaitingCode => "続ける",
        _ => null
    };

    public string Detail => Stage switch
    {
        AuthenticationStage.Checking => "公式の状態を確認しています。",
        AuthenticationStage.Unknown => "状態を確認できませんでした。「状態を更新」で読み直してください。",
        AuthenticationStage.WaitingSite => "まだ終わっていません。「公式サイトを開く」から公式サイトで認証してください。",
        AuthenticationStage.WaitingCode => "まだ終わっていません。公式サイトに表示された認証コードを下に貼り付けて「認証コードを送る」を押してください。",
        AuthenticationStage.SendingCode => "認証コードを送っています。",
        AuthenticationStage.Confirming => "公式の応答を待っています。終わるまでこの画面で待ってください。",
        AuthenticationStage.Done => "認証済みです。",
        AuthenticationStage.Failed => "認証できませんでした。理由：" + (string.IsNullOrEmpty(Reason) ? "理由は返されませんでした。" : Reason),
        _ => "ログインし直してください。「認証する」から公式サイトで認証します。"
    };
}

// How the settings home read /api/accounts. Only 404 means an older server (Claude is one login);
// any other failure (5xx, network, a body it cannot decode) is unreadable and must show 確認できません, never 「すべて認証済み」.
public enum ClaudeAccountsRead { Listed, OldServer, Unreadable }

public static class ClaudeAccountsReads
{
    public static ClaudeAccountsRead Failure(Exception error) => error is BellApiException { Status: HttpStatusCode.NotFound } ? ClaudeAccountsRead.OldServer : ClaudeAccountsRead.Unreadable;
    // The row the home adds when the account list could not be read; it opens the AIの認証 page.
    public static readonly AIAuthEntry UnreadableEntry = new("claude", "Claudeのアカウント", null, AuthenticationProgress.Unknown);
}

// One AI login the home reads: every harness, and Claude accounts when the server lists them. AccountLabel (Claude slots) shows only on its own login screen.
public sealed record AIAuthEntry(string HarnessId, string Name, string? Slot, AuthenticationProgress Progress, string? AccountLabel = null, string? LimitLine = null, bool SignedOut = false);

public enum OSNotificationAuthorization { Authorized, Denied, NotDetermined }

// The notification page one state: what the main button, the head line and the home badge follow.
public enum NotificationState { ServerOff, OsOff, Unregistered, Registered }

public static class NotificationStates
{
    // authorization: null until the OS answered. An unanswered or undecided OS is not "off": the register button asks it.
    public static NotificationState Decide(bool serverEnabled, OSNotificationAuthorization? authorization, bool registered)
        => !serverEnabled ? NotificationState.ServerOff : authorization == OSNotificationAuthorization.Denied ? NotificationState.OsOff : registered ? NotificationState.Registered : NotificationState.Unregistered;
}

public static class SettingsSummary
{
    private static SettingsStatus Attention(string line, string badge, SettingsPage page) => new(line, badge, SettingsTone.Orange, true, new SettingsRoute(page));

    // AIの認証. The worst stage over all logins wins; failed and needsLogin first, done last.
    private static int Severity(AuthenticationProgress progress) => progress.Stage switch
    {
        AuthenticationStage.Done => 0, AuthenticationStage.Checking => 1, AuthenticationStage.Confirming or AuthenticationStage.SendingCode => 2,
        AuthenticationStage.WaitingSite => 3, AuthenticationStage.WaitingCode => 4, AuthenticationStage.Unknown => 5, AuthenticationStage.NeedsLogin => 6, _ => 7
    };

    public static SettingsStatus Ai(IReadOnlyList<AIAuthEntry>? entries)
    {
        if (entries is null || entries.Count == 0) return Attention("AIの認証の状態を確認できません", "確認できません", SettingsPage.Ai);
        var worst = entries[0];
        foreach (var entry in entries) if (Severity(worst.Progress) < Severity(entry.Progress)) worst = entry; // the first of equals wins
        var others = entries.Count(entry => entry.Progress != AuthenticationProgress.Done) - (worst.Progress == AuthenticationProgress.Done ? 0 : 1);
        var more = others > 0 ? $"（ほか{others}件）" : "";
        var line = worst.Progress.Stage switch
        {
            AuthenticationStage.Done => "すべて認証済み",
            AuthenticationStage.Checking => "認証の状態を確認しています",
            AuthenticationStage.Confirming or AuthenticationStage.SendingCode => $"{worst.Name}の認証を確認しています" + more,
            AuthenticationStage.WaitingSite => $"{worst.Name}は公式サイトでの認証の途中です" + more,
            AuthenticationStage.WaitingCode => $"{worst.Name}は認証コードの入力待ちです" + more,
            AuthenticationStage.Unknown => $"{worst.Name}の状態を確認できません" + more,
            AuthenticationStage.NeedsLogin => $"{worst.Name}のログインが必要です" + more,
            _ => $"{worst.Name}の認証に失敗しました" + more
        };
        var attention = worst.Progress.Stage is AuthenticationStage.Unknown or AuthenticationStage.NeedsLogin or AuthenticationStage.Failed;
        var route = !attention ? null : worst == ClaudeAccountsReads.UnreadableEntry ? new SettingsRoute(SettingsPage.Ai) : new SettingsRoute(SettingsPage.Ai, worst.HarnessId, worst.Slot);
        return new(line, worst.Progress.Badge, worst.Progress.Tone, attention, route);
    }

    // 1Password. A null setting: the server does not return the item yet (or at all); the old calm line stays.
    public static SettingsStatus OnePassword(FeatureSetting? setting)
    {
        if (setting is null) return new(SettingsPage.OnePassword.Detail());
        var state = OnePasswordItem.State(setting);
        var badge = OnePasswordItem.BadgeText(state);
        return state switch
        {
            OnePasswordState.Connected => new(setting.Connection is { } connection ? $"保管庫{connection.Vaults.Length}件・SSH鍵{connection.SshKeys}件" : "つながっています", badge, SettingsTone.Green),
            OnePasswordState.Off => new("まだ連携していません", badge, SettingsTone.Gray),
            _ => new(setting.ErrorMessage.Length == 0 ? "連携できませんでした" : setting.ErrorMessage, badge, SettingsTone.Orange, true, new SettingsRoute(SettingsPage.OnePassword))
        };
    }

    public static SettingsStatus Notifications(NotificationState state, bool failed = false) => state switch
    {
        NotificationState.ServerOff => new("サーバーで無効です", "サーバーで無効", SettingsTone.Gray),
        NotificationState.OsOff => new("端末の通知がオフです", "OSでオフ", SettingsTone.Gray),
        NotificationState.Unregistered when failed => new("登録できませんでした", "失敗", SettingsTone.Orange, true, new SettingsRoute(SettingsPage.Notifications)),
        NotificationState.Unregistered => new("この端末に届きません", "未登録", SettingsTone.Violet),
        _ => new("この端末に届きます", "届きます", SettingsTone.Green)
    };

    // A key counts as missing when the server says so; an older body without key states falls back to its configured flag.
    public static bool SshKeyMissing(Terminal terminal) => terminal.Key(TerminalKeyKind.Ssh).Status switch
    {
        TerminalKeyStatus.Missing => true, TerminalKeyStatus.Unsupported => !terminal.SshKeyConfigured, _ => false
    };

    // shortcut: no reachability here until the server returns `lastCheck` per terminal; then add "つながらない端末" to the line and the band.
    public static SettingsStatus Terminals(TerminalListState state, IReadOnlyList<Terminal>? list)
    {
        if (state == TerminalListState.Failed) return Attention("端末の一覧を確認できません", "確認できません", SettingsPage.Terminals);
        if (state != TerminalListState.Supported || list is null) return new(SettingsPage.Terminals.Detail());
        if (list.Count == 0) return new("まだ端末がありません", "未設定", SettingsTone.Gray);
        var missing = list.Count(SshKeyMissing);
        var count = $"{list.Count}台";
        return missing > 0 ? new(count + $"・鍵が未設定の端末が{missing}台", "未設定", SettingsTone.Gray) : new(count, "設定済み", SettingsTone.Green);
    }

    // 稼働中に数えない処理 (a65). list null: not read yet, or an older server (calm line); unreadable: the last read failed, even with an earlier list kept.
    public static SettingsStatus Exclusions(RunningExclusionList? list, bool unreadable)
    {
        if (unreadable) return new(list is null ? "一覧を読めませんでした" : $"最新の一覧を読めませんでした（前に読んだ時は{list.Entries.Length}件）", "確認できません", SettingsTone.Orange);
        if (list is null) return new(SettingsPage.Exclusions.Detail());
        var count = list.Entries.Length; var waiting = list.Pending.Count(item => !item.Approved);
        if (waiting > 0) return new($"{count}件・承認を待っている提案が{waiting}件", "承認待ち", SettingsTone.Violet);
        return count > 0 ? new($"{count}件", "設定済み", SettingsTone.Green) : new("ありません");
    }

    // 仕事の要約を書くAI. catalog is the model list (GET /api/models) so the line says the display name of the model; an id not in it is shown as is.
    public static SettingsStatus SummaryAgent(BackgroundAgentRecord? record, Dictionary<string, HarnessModels>? catalog = null)
    {
        if (record is null) return new(SettingsPage.Summary.Detail());
        if (record.Selection is not { } selection) return new("まだ選んでいません", "未設定", SettingsTone.Gray);
        var name = BackgroundAgentChoices.Harnesses.FirstOrDefault(harness => harness.Id == selection.Harness).Label ?? selection.Harness;
        var model = catalog is null ? selection.Model : BackgroundAgentChoices.Models(catalog, selection.Harness).FirstOrDefault(choice => choice.Id == selection.Model)?.Label ?? selection.Model;
        return new(string.Join(" · ", name, model, EffortText.Label(selection.ReasoningEffort)), "設定済み", SettingsTone.Green);
    }

    // アップデート. UpdateKind maps 1:1 to the Mac UpdateContent.Status cases.
    public static SettingsStatus Update(UpdateKind kind, string title) => kind switch
    {
        UpdateKind.Loading or UpdateKind.Unconfirmed => new(title, "確認中", SettingsTone.Violet),
        UpdateKind.Updating => new(title, "更新中", SettingsTone.Violet),
        UpdateKind.Available => new(title, "更新あり", SettingsTone.Violet, true, new SettingsRoute(SettingsPage.Update)),
        UpdateKind.Completed => new(title, "完了", SettingsTone.Green),
        UpdateKind.UpToDate or UpdateKind.Waiting => new(title, "最新", SettingsTone.Green),
        UpdateKind.Failed => new(title, "失敗", SettingsTone.Orange, true, new SettingsRoute(SettingsPage.Update)),
        _ => new(title, "確認できません", SettingsTone.Orange, true, new SettingsRoute(SettingsPage.Update))
    };
    public static string StopSentence(AiControlState state) => new AiControl { State = state }.StatusText;

    // 全体停止. A null control with unreadable false is still loading and keeps the calm line.
    public static SettingsStatus Stop(AiControl? control, bool unreadable)
    {
        if (control is null) return unreadable ? Attention("全体停止の状態を読み込めませんでした", "確認できません", SettingsPage.Stop) : new(SettingsPage.Stop.Detail());
        var line = control.StatusText;
        return control.State switch
        {
            AiControlState.Enabled => new(line, "動作中", SettingsTone.Green),
            AiControlState.Stopping => new(line, "確認中", SettingsTone.Violet),
            AiControlState.Stopped => Attention(line, "停止中", SettingsPage.Stop),
            _ => Attention(line, "確認できません", SettingsPage.Stop)
        };
    }

    // チームの決まり
    public static SettingsStatus Rules(string? text, bool unreadable)
    {
        if (text is null) return unreadable ? Attention("決まりを読み込めませんでした", "確認できません", SettingsPage.Rules) : new(SettingsPage.Rules.Detail());
        var document = UserRulesDocument.Parse(text);
        if (document.IsEmpty) return new("まだ決まりがありません", "未設定", SettingsTone.Gray);
        return new(document.RuleCount > 0 ? $"{document.RuleCount}件の決まり" : $"{document.PlainLines.Count}行の決まり", "設定済み", SettingsTone.Green);
    }

    // 追加機能: the feature list without 1Password (its own item).
    public static SettingsStatus Features(IReadOnlyList<FeatureSetting> settings)
    {
        var rest = settings.Where(setting => setting.Id != OnePasswordItem.Id).ToArray();
        if (rest.Length == 0) return new(SettingsPage.Features.Detail());
        var failed = rest.Count(setting => setting.ApplyFailed);
        if (failed > 0) return new($"反映できていない機能が{failed}件あります", "失敗", SettingsTone.Orange, true, new SettingsRoute(SettingsPage.Features));
        var enabled = rest.Count(setting => setting.Status == "enabled");
        var off = rest.Count(setting => setting.Status == "disabled");
        var unset = rest.Length - enabled - off;
        var line = string.Join("・", new[] { enabled > 0 ? $"{enabled}つ使用中" : null, unset > 0 ? $"{unset}つ未設定" : null, off > 0 ? $"{off}つオフ" : null }.OfType<string>());
        return new(line.Length == 0 ? "使用中の機能はありません" : line, enabled > 0 ? "設定済み" : "未設定", enabled > 0 ? SettingsTone.Green : SettingsTone.Gray);
    }
}
