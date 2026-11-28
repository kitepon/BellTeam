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
        SettingsPage.Profile => CoreStrings.SettingsStatus_Title_1, SettingsPage.Ai => CoreStrings.SettingsStatus_Title_2, SettingsPage.Summary => CoreStrings.SettingsStatus_Title_3, SettingsPage.Terminals => CoreStrings.SettingsStatus_Title_4, SettingsPage.Exclusions => CoreStrings.SettingsStatus_Title_5,
        SettingsPage.OnePassword => "1Password", SettingsPage.Notifications => CoreStrings.SettingsStatus_Title_6, SettingsPage.Rules => CoreStrings.SettingsStatus_Title_7, SettingsPage.Features => CoreStrings.SettingsStatus_Title_8,
        SettingsPage.Connection => CoreStrings.SettingsStatus_Title_9, SettingsPage.Display => CoreStrings.SettingsStatus_Title_10, SettingsPage.Billing => CoreStrings.SettingsStatus_Title_11, SettingsPage.Update => CoreStrings.SettingsStatus_Title_12,
        SettingsPage.About => CoreStrings.SettingsStatus_Title_13, _ => CoreStrings.SettingsStatus_Title_14
    };
    // The calm line: shown while the live state is not known yet, or when an older server does not return the item's data.
    public static string Detail(this SettingsPage page) => page switch
    {
        SettingsPage.Profile => CoreStrings.SettingsStatus_Detail_1,
        SettingsPage.Ai => CoreStrings.SettingsStatus_Detail_2,
        SettingsPage.Summary => CoreStrings.SettingsStatus_Detail_3,
        SettingsPage.Terminals => CoreStrings.SettingsStatus_Detail_4,
        SettingsPage.Exclusions => CoreStrings.SettingsStatus_Detail_5,
        SettingsPage.OnePassword => CoreStrings.SettingsStatus_Detail_6,
        SettingsPage.Notifications => CoreStrings.SettingsStatus_Detail_7,
        SettingsPage.Rules => CoreStrings.SettingsStatus_Detail_8,
        SettingsPage.Features => CoreStrings.SettingsStatus_Detail_9,
        SettingsPage.Connection => CoreStrings.SettingsStatus_Detail_10,
        SettingsPage.Display => CoreStrings.SettingsStatus_Detail_11,
        SettingsPage.Billing => CoreStrings.SettingsStatus_Detail_12,
        SettingsPage.Update => CoreStrings.SettingsStatus_Detail_13,
        SettingsPage.About => CoreStrings.SettingsStatus_Detail_14,
        _ => CoreStrings.SettingsStatus_Detail_15
    };
}

// Where a tap on an 要対応 row, or a push inside the settings, goes. Harness non-null is the login screen of that AI; Slot is "2nd" for Claude second account.
public sealed record SettingsRoute(SettingsPage Page, string? Harness = null, string? Slot = null);

public sealed record SettingsStatus(string Line, string? Badge = null, SettingsTone Tone = SettingsTone.Gray, bool NeedsAttention = false, SettingsRoute? AttentionRoute = null);

// The effort in plain words for the settings screens (an effort the app does not know is shown as sent).
public static class EffortText
{
    public static string Label(string effort) => effort switch { "" => CoreStrings.AvatarImages_DefaultValue_1, "low" => CoreStrings.SettingsStatus_Label_2, "medium" => CoreStrings.SettingsStatus_Label_3, "high" => CoreStrings.SettingsStatus_Label_4, "xhigh" => CoreStrings.SettingsStatus_Label_5, _ => effort };
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
        AuthenticationStage.Checking or AuthenticationStage.Confirming or AuthenticationStage.SendingCode => CoreStrings.SettingsModels_Checking_1,
        AuthenticationStage.Unknown => CoreStrings.SettingsModels_RowText_2,
        AuthenticationStage.WaitingSite => CoreStrings.SettingsStatus_Badge_3,
        AuthenticationStage.WaitingCode => CoreStrings.SettingsStatus_Badge_4,
        AuthenticationStage.Done => CoreStrings.SettingsModels_From_1,
        AuthenticationStage.Failed => CoreStrings.OnePassword_BadgeText_3,
        _ => CoreStrings.SettingsStatus_Badge_7
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
        AuthenticationStage.Failed => CoreStrings.SettingsModels_From_3,
        AuthenticationStage.NeedsLogin => CoreStrings.SettingsModels_From_5,
        AuthenticationStage.WaitingSite or AuthenticationStage.WaitingCode => CoreStrings.SettingsModels_From_7,
        _ => null
    };

    public string Detail => Stage switch
    {
        AuthenticationStage.Checking => CoreStrings.SettingsStatus_Detail_16,
        AuthenticationStage.Unknown => CoreStrings.SettingsStatus_Detail_17,
        AuthenticationStage.WaitingSite => CoreStrings.SettingsStatus_Detail_18,
        AuthenticationStage.WaitingCode => CoreStrings.SettingsStatus_Detail_19,
        AuthenticationStage.SendingCode => CoreStrings.SettingsStatus_Detail_20,
        AuthenticationStage.Confirming => CoreStrings.SettingsStatus_Detail_21,
        AuthenticationStage.Done => CoreStrings.SettingsStatus_Detail_22,
        AuthenticationStage.Failed => CoreStrings.SettingsStatus_Detail_24((string.IsNullOrEmpty(Reason) ? CoreStrings.SettingsStatus_Detail_23 : Reason)),
        _ => CoreStrings.SettingsStatus_Detail_25
    };
}

// How the settings home read /api/accounts. Only 404 means an older server (Claude is one login);
// any other failure (5xx, network, a body it cannot decode) is unreadable and must show 確認できません, never 「すべて認証済み」.
public enum ClaudeAccountsRead { Listed, OldServer, Unreadable }

public static class ClaudeAccountsReads
{
    public static ClaudeAccountsRead Failure(Exception error) => error is BellApiException { Status: HttpStatusCode.NotFound } ? ClaudeAccountsRead.OldServer : ClaudeAccountsRead.Unreadable;
    // The row the home adds when the account list could not be read; it opens the AIの認証 page.
    public static readonly AIAuthEntry UnreadableEntry = new("claude", CoreStrings.SettingsStatus_UnreadableEntry_1, null, AuthenticationProgress.Unknown);
}

// One AI login the home reads: every harness, and Claude accounts when the server lists them. AccountLabel (Claude slots) shows only on its own login screen.
public sealed record AIAuthEntry(string HarnessId, string Name, string? Slot, AuthenticationProgress Progress, string? AccountLabel = null, string? LimitLine = null, bool SignedOut = false, HarnessCliInstall? Install = null);

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
        if (entries is null || entries.Count == 0) return Attention(CoreStrings.SettingsStatus_Ai_1, CoreStrings.SettingsModels_RowText_2, SettingsPage.Ai);
        // a451: an AI that is not installed (or whose install failed) outranks every login stage; installed with a failed update does not count.
        // An AI being installed or checked moves by itself: no login read, nothing to do, so it never counts. Claude counts once for both accounts.
        static bool Absent(AIAuthEntry entry) => entry.Install is { NeedsAttention: true };
        static bool Moving(AIAuthEntry entry) => entry.Install is { CannotRun: true, NeedsAttention: false } or { State: "checking" };
        static AuthenticationProgress Shown(AIAuthEntry entry) => Moving(entry) && entry.Progress != AuthenticationProgress.Done ? AuthenticationProgress.Checking : entry.Progress;
        static int Rank(AIAuthEntry entry) => Absent(entry) ? 8 : Severity(Shown(entry));
        static bool Pending(AIAuthEntry entry) => Absent(entry) || !Moving(entry) && entry.Progress != AuthenticationProgress.Done;
        var worst = entries[0];
        foreach (var entry in entries) if (Rank(worst) < Rank(entry)) worst = entry; // the first of equals wins
        var others = entries.Where(Pending).Select(entry => Absent(entry) ? "install:" + entry.HarnessId : "login:" + entry.HarnessId + "/" + entry.Slot).Distinct().Count() - (Pending(worst) ? 1 : 0);
        var more = others > 0 ? CoreStrings.SettingsStatus_Ai_3(others) : "";
        if (worst.Install is { NeedsAttention: true } install)
        {
            var (text, badge) = install.State == "failed" ? (CoreStrings.SettingsStatus_Ai_4(worst.Name), CoreStrings.SettingsModels_FromInstall_3) : (CoreStrings.SettingsStatus_Ai_6(worst.Name), CoreStrings.SettingsModels_FromInstall_1);
            return new(text + more, badge, SettingsTone.Orange, true, new SettingsRoute(SettingsPage.Ai, worst.HarnessId, worst.Slot));
        }
        var shown = Shown(worst);
        var line = shown.Stage switch
        {
            AuthenticationStage.Done => CoreStrings.SettingsStatus_Ai_8,
            AuthenticationStage.Checking => CoreStrings.SettingsStatus_Ai_9,
            AuthenticationStage.Confirming or AuthenticationStage.SendingCode => CoreStrings.SettingsStatus_Ai_10(worst.Name, more),
            AuthenticationStage.WaitingSite => CoreStrings.SettingsStatus_Ai_11(worst.Name, more),
            AuthenticationStage.WaitingCode => CoreStrings.SettingsStatus_Ai_12(worst.Name, more),
            AuthenticationStage.Unknown => CoreStrings.SettingsStatus_Ai_13(worst.Name, more),
            AuthenticationStage.NeedsLogin => CoreStrings.SettingsStatus_Ai_14(worst.Name, more),
            _ => CoreStrings.SettingsStatus_Ai_15(worst.Name, more)
        };
        var attention = shown.Stage is AuthenticationStage.Unknown or AuthenticationStage.NeedsLogin or AuthenticationStage.Failed;
        var route = !attention ? null : worst == ClaudeAccountsReads.UnreadableEntry ? new SettingsRoute(SettingsPage.Ai) : new SettingsRoute(SettingsPage.Ai, worst.HarnessId, worst.Slot);
        return new(line, shown.Badge, shown.Tone, attention, route);
    }

    // 1Password. A null setting: the server does not return the item yet (or at all); the old calm line stays.
    public static SettingsStatus OnePassword(FeatureSetting? setting)
    {
        if (setting is null) return new(SettingsPage.OnePassword.Detail());
        var state = OnePasswordItem.State(setting);
        var badge = OnePasswordItem.BadgeText(state);
        return state switch
        {
            OnePasswordState.Connected => new(setting.Connection is { } connection ? CoreStrings.SettingsStatus_OnePassword_1(connection.Vaults.Length, connection.SshKeys) : CoreStrings.SettingsStatus_OnePassword_2, badge, SettingsTone.Green),
            OnePasswordState.Off => new(CoreStrings.SettingsStatus_OnePassword_3, badge, SettingsTone.Gray),
            _ => new(setting.ErrorMessage.Length == 0 ? CoreStrings.SettingsStatus_OnePassword_4 : setting.ErrorMessage, badge, SettingsTone.Orange, true, new SettingsRoute(SettingsPage.OnePassword))
        };
    }

    public static SettingsStatus Notifications(NotificationState state, bool failed = false) => state switch
    {
        NotificationState.ServerOff => new(CoreStrings.SettingsStatus_Notifications_1, CoreStrings.SettingsStatus_Notifications_2, SettingsTone.Gray),
        NotificationState.OsOff => new(CoreStrings.SettingsStatus_Notifications_3, CoreStrings.SettingsStatus_Notifications_4, SettingsTone.Gray),
        NotificationState.Unregistered when failed => new(CoreStrings.SettingsStatus_Notifications_5, CoreStrings.OnePassword_BadgeText_3, SettingsTone.Orange, true, new SettingsRoute(SettingsPage.Notifications)),
        NotificationState.Unregistered => new(CoreStrings.SettingsStatus_Notifications_7, CoreStrings.SettingsStatus_Notifications_8, SettingsTone.Violet),
        _ => new(CoreStrings.SettingsStatus_Notifications_9, CoreStrings.SettingsStatus_Notifications_10, SettingsTone.Green)
    };

    // A key counts as missing when the server says so; an older body without key states falls back to its configured flag.
    public static bool SshKeyMissing(Terminal terminal) => terminal.Key(TerminalKeyKind.Ssh).Status switch
    {
        TerminalKeyStatus.Missing => true, TerminalKeyStatus.Unsupported => !terminal.SshKeyConfigured, _ => false
    };

    // shortcut: no reachability here until the server returns `lastCheck` per terminal; then add "つながらない端末" to the line and the band.
    public static SettingsStatus Terminals(TerminalListState state, IReadOnlyList<Terminal>? list)
    {
        if (state == TerminalListState.Failed) return Attention(CoreStrings.SettingsStatus_Terminals_1, CoreStrings.SettingsModels_RowText_2, SettingsPage.Terminals);
        if (state != TerminalListState.Supported || list is null) return new(SettingsPage.Terminals.Detail());
        if (list.Count == 0) return new(CoreStrings.SettingsStatus_Terminals_3, CoreStrings.PlanningModels_StatusText_4, SettingsTone.Gray);
        var missing = list.Count(SshKeyMissing);
        var count = CoreStrings.SettingsStatus_Terminals_5(list.Count);
        return missing > 0 ? new(CoreStrings.SettingsStatus_Terminals_6(count, missing), CoreStrings.PlanningModels_StatusText_4, SettingsTone.Gray) : new(count, CoreStrings.SettingsStatus_Terminals_8, SettingsTone.Green);
    }

    // 稼働中に数えない処理 (a65). list null: not read yet, or an older server (calm line); unreadable: the last read failed, even with an earlier list kept.
    public static SettingsStatus Exclusions(RunningExclusionList? list, bool unreadable)
    {
        if (unreadable) return new(list is null ? CoreStrings.SettingsStatus_Exclusions_1 : CoreStrings.SettingsStatus_Exclusions_2(list.Entries.Length), CoreStrings.SettingsModels_RowText_2, SettingsTone.Orange);
        if (list is null) return new(SettingsPage.Exclusions.Detail());
        var count = list.Entries.Length; var waiting = list.Pending.Count(item => !item.Approved);
        if (waiting > 0) return new(CoreStrings.SettingsStatus_Exclusions_4(count, waiting), CoreStrings.SeatApprovals_Badge_1, SettingsTone.Violet);
        return count > 0 ? new(CoreStrings.SettingsStatus_Exclusions_6(count), CoreStrings.SettingsStatus_Terminals_8, SettingsTone.Green) : new(CoreStrings.SettingsStatus_Exclusions_8);
    }

    // 仕事の要約を書くAI. catalog is the model list (GET /api/models) so the line says the display name of the model; an id not in it is shown as is.
    public static SettingsStatus SummaryAgent(BackgroundAgentRecord? record, Dictionary<string, HarnessModels>? catalog = null)
    {
        if (record is null) return new(SettingsPage.Summary.Detail());
        if (record.Selection is not { } selection) return new(CoreStrings.SettingsStatus_SummaryAgent_1, CoreStrings.PlanningModels_StatusText_4, SettingsTone.Gray);
        if (record.Notice is { } notice) return new(notice, CoreStrings.SettingsStatus_SummaryAgent_3, SettingsTone.Orange, true, new SettingsRoute(SettingsPage.Summary));
        var name = BackgroundAgentChoices.Harnesses.FirstOrDefault(harness => harness.Id == selection.Harness).Label ?? selection.Harness;
        var model = catalog is null ? selection.Model : BackgroundAgentChoices.Models(catalog, selection.Harness).FirstOrDefault(choice => choice.Id == selection.Model)?.Label ?? selection.Model;
        return new(string.Join(" · ", name, model, EffortText.Label(selection.ReasoningEffort)), CoreStrings.SettingsStatus_Terminals_8, SettingsTone.Green);
    }

    // アップデート. UpdateKind maps 1:1 to the Mac UpdateContent.Status cases.
    public static SettingsStatus Update(UpdateKind kind, string title) => kind switch
    {
        UpdateKind.Loading or UpdateKind.Unconfirmed => new(title, CoreStrings.SettingsModels_Checking_1, SettingsTone.Violet),
        UpdateKind.Updating => new(title, CoreStrings.SettingsStatus_Update_2, SettingsTone.Violet),
        UpdateKind.Available => new(title, CoreStrings.SettingsStatus_Update_3, SettingsTone.Violet, true, new SettingsRoute(SettingsPage.Update)),
        UpdateKind.Completed => new(title, CoreStrings.GoalModels_StatusTitle_6, SettingsTone.Green),
        UpdateKind.UpToDate or UpdateKind.Waiting => new(title, CoreStrings.SettingsStatus_Update_5, SettingsTone.Green),
        UpdateKind.Failed => new(title, CoreStrings.OnePassword_BadgeText_3, SettingsTone.Orange, true, new SettingsRoute(SettingsPage.Update)),
        _ => new(title, CoreStrings.SettingsModels_RowText_2, SettingsTone.Orange, true, new SettingsRoute(SettingsPage.Update))
    };
    public static string StopSentence(AiControlState state) => new AiControl { State = state }.StatusText;

    // 全体停止. A null control with unreadable false is still loading and keeps the calm line.
    public static SettingsStatus Stop(AiControl? control, bool unreadable)
    {
        if (control is null) return unreadable ? Attention(CoreStrings.SettingsStatus_Stop_1, CoreStrings.SettingsModels_RowText_2, SettingsPage.Stop) : new(SettingsPage.Stop.Detail());
        var line = control.StatusText;
        return control.State switch
        {
            AiControlState.Enabled => new(line, CoreStrings.SettingsModels_RowText_3, SettingsTone.Green),
            AiControlState.Stopping => new(line, CoreStrings.SettingsModels_Checking_1, SettingsTone.Violet),
            AiControlState.Stopped => Attention(line, CoreStrings.SettingsModels_RowText_1, SettingsPage.Stop),
            _ => Attention(line, CoreStrings.SettingsModels_RowText_2, SettingsPage.Stop)
        };
    }

    // チームの決まり
    public static SettingsStatus Rules(string? text, bool unreadable)
    {
        if (text is null) return unreadable ? Attention(CoreStrings.SettingsStatus_Rules_1, CoreStrings.SettingsModels_RowText_2, SettingsPage.Rules) : new(SettingsPage.Rules.Detail());
        var document = UserRulesDocument.Parse(text);
        if (document.IsEmpty) return new(CoreStrings.SettingsStatus_Rules_3, CoreStrings.PlanningModels_StatusText_4, SettingsTone.Gray);
        return new(document.RuleCount > 0 ? CoreStrings.SettingsStatus_Rules_5(document.RuleCount) : CoreStrings.SettingsStatus_Rules_6(document.PlainLines.Count), CoreStrings.SettingsStatus_Terminals_8, SettingsTone.Green);
    }

    // 追加機能: the feature list without 1Password (its own item).
    public static SettingsStatus Features(IReadOnlyList<FeatureSetting> settings)
    {
        var rest = settings.Where(setting => setting.Id != OnePasswordItem.Id).ToArray();
        if (rest.Length == 0) return new(SettingsPage.Features.Detail());
        var failed = rest.Count(setting => setting.ApplyFailed);
        if (failed > 0) return new(CoreStrings.SettingsStatus_Features_1(failed), CoreStrings.OnePassword_BadgeText_3, SettingsTone.Orange, true, new SettingsRoute(SettingsPage.Features));
        var enabled = rest.Count(setting => setting.Status == "enabled");
        var off = rest.Count(setting => setting.Status == "disabled");
        var unset = rest.Length - enabled - off;
        var line = string.Join(CoreStrings.HarnessAccounts_LimitLine_2, new[] { enabled > 0 ? CoreStrings.SettingsStatus_Features_4(enabled) : null, unset > 0 ? CoreStrings.SettingsStatus_Features_5(unset) : null, off > 0 ? CoreStrings.SettingsStatus_Features_6(off) : null }.OfType<string>());
        return new(line.Length == 0 ? CoreStrings.SettingsStatus_Features_7 : line, enabled > 0 ? CoreStrings.SettingsStatus_Terminals_8 : CoreStrings.PlanningModels_StatusText_4, enabled > 0 ? SettingsTone.Green : SettingsTone.Gray);
    }
}
