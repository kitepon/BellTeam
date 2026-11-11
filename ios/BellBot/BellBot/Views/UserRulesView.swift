import SwiftUI

/// チームの決まり: the rules text read as rules, with 編集する opening the full-text editor.
/// The text lives in SettingsHomeState (`GET /api/user-rules`), so the home row, this page and the editor share one value.
struct UserRulesPage: View {
    @EnvironmentObject private var store: AppStore
    @EnvironmentObject private var home: SettingsHomeState
    @State private var editing = false

    var body: some View {
        SettingsCardPage(page: .rules) {
            if home.rulesText != nil {
                SettingsMainButton(title: "編集する", identifier: "rules-edit") { editing = true }
            } else if home.rulesUnreadable {
                SettingsMainButton(title: "読み直す", identifier: "rules-reload") { Task { await home.loadRules() } }
            }
        } content: {
            if let text = home.rulesText { UserRulesDocumentView(document: UserRulesDocument.parse(text)) }
            else if !home.rulesUnreadable { ProgressView() }
        }
        .task { await home.loadRules() }
        .sheet(isPresented: $editing) { UserRulesEditor(initial: home.rulesText ?? "").environmentObject(store).environmentObject(home).bellEditorSheet() }
    }
}

private struct UserRulesDocumentView: View {
    let document: UserRulesDocument

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if document.isEmpty {
                Text("まだ決まりがありません。「編集する」から書けます。").font(BellTheme.detailFont).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            // Sections are only grouping in the text; the cards are the rules, each titled by its own purpose (the ids stay out of sight).
            ForEach(Array(document.sections.enumerated()), id: \.offset) { _, section in
                ForEach(Array(section.rules.enumerated()), id: \.offset) { _, rule in
                    VStack(alignment: .leading, spacing: 10) {
                        if let headline = rule.headline {
                            Text(headline.text).font(.headline).fixedSize(horizontal: false, vertical: true)
                        }
                        ForEach(Array(rule.details.enumerated()), id: \.offset) { _, clause in
                            HStack(alignment: .firstTextBaseline, spacing: 10) {
                                BellBadge(text: clause.label, tone: .violet)
                                Text(clause.text).font(BellTheme.detailFont).fixedSize(horizontal: false, vertical: true)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16).bellCard()
                }
            }
            if !document.plainLines.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(document.plainLines.enumerated()), id: \.offset) { _, line in
                        Text(line).font(BellTheme.detailFont).frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(16).bellCard()
            }
        }
    }
}

/// The full-text editor: 保存 sends the whole text (`PUT /api/user-rules`); the result and a failure appear right under the button.
private struct UserRulesEditor: View {
    @EnvironmentObject private var store: AppStore
    @EnvironmentObject private var home: SettingsHomeState
    @Environment(\.dismiss) private var dismiss
    @State private var text: String
    @State private var saving = false
    @State private var errorText: String?

    init(initial: String) { _text = State(initialValue: initial) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SettingsSubHeader(symbol: SettingsPage.rules.symbol, tint: SettingsPage.rules.tint, title: "チームの決まり",
                                      line: "全文を書き換えます。チーム全員が、あなたについて守る指示です。")
                }
                .listRowBackground(Color.clear)
                Section {
                    TextEditor(text: $text).frame(minHeight: 260)
                        .accessibilityIdentifier("rules-text")
                } header: {
                    BellSectionHeader("決まりの全文")
                } footer: {
                    Text("チーム全員が、あなたについて守る指示です。").font(BellTheme.secondaryFont)
                }
                Section {
                    SettingsMainButton(title: "保存", busyTitle: "保存しています…", busy: saving, identifier: "rules-save") { Task { await save() } }
                        .settingsButtonRow()
                    if let errorText { SettingsBanner(message: errorText) }
                }
            }
            .navigationTitle("チームの決まり")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarLeading) { Button("キャンセル") { dismiss() }.disabled(saving) } }
        }
    }

    private func save() async {
        saving = true
        errorText = nil
        defer { saving = false }
        do {
            let response: UserRulesResponse = try await store.api.put("/api/user-rules", body: UserRulesRequest(text: text))
            home.rulesSaved(response.text)
            dismiss()
        } catch let error where BellAPIError.isAuthenticationError(error) {
            store.requireLogin(for: error)
        } catch {
            errorText = "決まりを保存できませんでした。入力は残っています。プロフィールには影響しません。\(BellAPIError.operationFailureMessage(error))"
            store.api.diagnostics.report(error, path: "/api/user-rules", method: "PUT", observation: .write)
        }
    }
}
