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
    static func slotName(_ slot: String) -> String { slot == "2nd" ? "2ndアカウント" : "1stアカウント" }

    static func scopeName(_ scope: String) -> String {
        ["fable": "Fable", "opus": "Opus", "sonnet": "Sonnet", "haiku": "Haiku"][scope] ?? scope
    }

    /// 解除時刻は日本時間。今日なら時刻だけ、別の日なら日付も付ける。不明なら「解除時刻不明」。
    static func reset(_ iso: String?, now: Date = Date()) -> String {
        guard let iso, let date = BellDate.parse(iso) else { return "解除時刻不明" }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = Locale(identifier: "ja_JP")
        formatter.dateFormat = calendar.isDate(date, inSameDayAs: now) ? "HH:mm" : "M/d HH:mm"
        return "\(formatter.string(from: date))に解除"
    }

    /// 「上限中 (HH:MMに解除)」または「Fableのみ上限中 (23:00に解除)」。
    static func limit(_ limit: AccountLimit, now: Date = Date()) -> String {
        let when = reset(limit.resetAt, now: now)
        return limit.scope == "all" ? "上限中 (\(when))" : "\(scopeName(limit.scope))のみ上限中 (\(when))"
    }

    static func bothLimited(_ scope: AllLimitedScope, now: Date = Date()) -> String {
        let what = scope.scope == "all" ? "上限中" : "\(scopeName(scope.scope))が上限中"
        return "1stアカウントと2ndアカウントがどちらも\(what)です（\(reset(scope.earliestResetAt, now: now))）"
    }

    /// 行の下に出す、そのアカウントで動いているメンバー。名簿に無いIDはそのまま出す。
    static func seats(_ ids: [String], names: [String: String]) -> String {
        "使用中: " + ids.map { names[$0] ?? $0 }.joined(separator: "、")
    }
}
