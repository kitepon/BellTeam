import Foundation

// Claudeの1st/2ndアカウント（docs/architecture/modules/execution/harness-accounts.md）。GET /api/accounts の形と、画面の文言。

/// `rules`は常に空で、使い分けの規則は無い（Owner裁定 2026-11-09）。読まない。
struct HarnessAccountsResponse: Decodable {
    let harnesses: [HarnessAccounts]
}

struct HarnessAccounts: Decodable, Equatable {
    let harness: String
    let slots: [AccountSlot]
    let allLimited: [AllLimitedScope]?
}

extension HarnessAccounts {
    /// The one limit line of an account ("上限中・11/13 17:00に戻ります（いまは2つ目で動いています）"), nil without a limit.
    @MainActor func limitLine(for slot: AccountSlot) -> String? {
        let secondAvailable = slots.contains { $0.slot == "2nd" && $0.loggedIn == true && !$0.limits.contains { $0.scope == "all" } }
        return AccountText.limitLine(slot.limits, runningOnOther: slot.slot == "1st" && secondAvailable ? "2つ目" : nil)
    }
}

struct AccountSlot: Decodable, Equatable, Identifiable {
    let slot: String
    let loggedIn: Bool?
    /// 資格情報が失効した時刻。旧本体には無い。
    var signedOutAt: String? = nil
    let label: String?
    let history: String?
    let limits: [AccountLimit]
    let seats: [String]
    var id: String { slot }
}

struct AccountLimit: Decodable, Equatable {
    let scope: String
    let resetAt: String?
}

struct AllLimitedScope: Decodable, Equatable {
    let scope: String
    let earliestResetAt: String?
}

/// Bot項目の`account`（旧本体には無い）。
struct BotAccount: Decodable, Equatable {
    let harness: String
    let slot: String
}

@MainActor
enum AccountText {
    /// Web・Appleで同じ呼び名（Admi合意 2026-11-11）。AIの認証の行は名前の下に、そのアカウントのメールを出す（Root裁定）。
    static func slotName(_ slot: String) -> String { slot == "2nd" ? "2つ目のアカウント" : "1つ目のアカウント" }

    static func scopeName(_ scope: String) -> String {
        ["fable": "Fable", "opus": "Opus", "sonnet": "Sonnet", "haiku": "Haiku"][scope] ?? scope
    }

    /// 解除時刻は日本時間。今日なら時刻だけ、別の日なら日付も付ける。不明なら「解除時刻不明」。
    static func reset(_ iso: String?, now: Date = Date()) -> String {
        time(iso, now: now).map { "\($0)に解除" } ?? "解除時刻不明"
    }

    /// 日本時間の「HH:mm」（今日以外は「M/d HH:mm」）。読めなければnil。
    static func time(_ iso: String?, now: Date = Date()) -> String? {
        guard let iso, let date = BellDate.parse(iso) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = Locale(identifier: "ja_JP")
        formatter.dateFormat = calendar.isDate(date, inSameDayAs: now) ? "HH:mm" : "M/d HH:mm"
        return formatter.string(from: date)
    }

    /// 「上限中 (HH:MMに解除)」または「Fableのみ上限中 (23:00に解除)」。
    static func limit(_ limit: AccountLimit, now: Date = Date()) -> String {
        let when = reset(limit.resetAt, now: now)
        return limit.scope == "all" ? "上限中 (\(when))" : "\(scopeName(limit.scope))のみ上限中 (\(when))"
    }

    static func bothLimited(_ scope: AllLimitedScope, now: Date = Date()) -> String {
        let what = scope.scope == "all" ? "上限中" : "\(scopeName(scope.scope))が上限中"
        return "1つ目と2つ目のアカウントがどちらも\(what)です（\(reset(scope.earliestResetAt, now: now))）"
    }

    /// 行の下の一行：そのアカウントで動いているメンバーの数だけ（名前は並べない。Root review 2026-11-11）。
    /// 旧本体（Bot項目に`account`が無い）だけが使う。`seats`は最後に起動した記録で、今は別のAIのメンバーも含む。
    static func seats(_ ids: [String]) -> String { "\(ids.count)人が使用" }

    /// いまそのアカウントで動いているメンバーの数。Bot項目の`account`（本体の`transport.seatAccount`）だけで数える。
    /// 見出しの「N人が使用」（そのAIのメンバー）と、1つ目・2つ目の数の和が一致する（Root 2026-11-12：数が合わないと不具合に見える）。
    /// どのBotにも`account`が無い旧本体ではnil（呼び出し側は従来の`seats`の行）。
    static func slotUsers(_ accounts: [BotAccount?], harness: String, slot: String) -> Int? {
        guard accounts.contains(where: { $0 != nil }) else { return nil }
        return accounts.filter { $0?.harness == harness && $0?.slot == slot }.count
    }

    static func slotUsersLine(_ count: Int) -> String {
        count == 0 ? "いまこのアカウントで動いているメンバーはいません" : "いま\(count)人がこのアカウントで動いています"
    }

    /// ログインの札とは別に、上限を1行で。「上限中・11/13 17:00に戻ります（いまは2ndで動いています）」。
    /// 全モデルの上限があればその時刻、モデル別だけなら「Fable・Opusが上限中」と最も早い時刻。
    static func limitLine(_ limits: [AccountLimit], runningOnOther other: String? = nil, now: Date = Date()) -> String? {
        guard !limits.isEmpty else { return nil }
        let all = limits.first { $0.scope == "all" }
        let what = all != nil ? "上限中" : limits.map { scopeName($0.scope) }.joined(separator: "・") + "が上限中"
        let times = (all.map { [$0] } ?? limits).compactMap { limit in BellDate.parse(limit.resetAt ?? "").map { (limit, $0) } }
        let earliest = times.min { $0.1 < $1.1 }?.0
        let when = time(earliest?.resetAt, now: now).map { "・\($0)に戻ります" } ?? "・戻る時刻は分かりません"
        return what + when + (other.map { "（いまは\($0)で動いています）" } ?? "")
    }
}
