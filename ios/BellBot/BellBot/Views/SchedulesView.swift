import SwiftUI

struct SchedulesView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.scenePhase) private var scenePhase
    @State private var entries: [ScheduledEntry] = []
    @State private var loading = true
    @State private var errorText: String?
    @State private var editing: ScheduledEntry?
    @State private var creating = false
    @State private var loadTask: Task<Void, Never>?

    var body: some View {
        NavigationStack {
            ZStack {
                BellBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("予定")
                                .font(.system(size: 34, weight: .bold, design: .rounded))
                                .foregroundStyle(BellTheme.ink)
                            Text("チームに任せた仕事の、これから。")
                                .foregroundStyle(BellTheme.muted)
                        }
                        .padding(.bottom, 6)
                        if let errorText {
                            Text(errorText).font(.footnote).foregroundStyle(.red)
                        }
                        if loading {
                            ProgressView().frame(maxWidth: .infinity).padding(.top, 75)
                        } else if entries.isEmpty {
                            ContentUnavailableView("予定はありません", systemImage: "calendar.badge.plus",
                                                   description: Text("右上の＋から追加できます。"))
                                .frame(maxWidth: .infinity)
                        } else {
                            ForEach(entries) { entry in
                                ScheduleCard(entry: entry, bot: store.bots.first { $0.id == entry.target.id }) {
                                    editing = entry
                                } run: {
                                    Task { await run(entry) }
                                } remove: {
                                    Task { await remove(entry) }
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 22)
                    .padding(.top, 24)
                    .padding(.bottom, 30)
                }
                .refreshable { await load() }
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { creating = true } label: { Image(systemName: "plus") }
                        .accessibilityLabel("予定を追加")
                }
            }
            .sheet(isPresented: $creating, onDismiss: { Task { await load() } }) {
                ScheduleEditor(initial: nil)
                    .environmentObject(store)
            }
            .sheet(item: $editing, onDismiss: { Task { await load() } }) { entry in
                ScheduleEditor(initial: entry)
                    .environmentObject(store)
            }
            .task(id: scenePhase) { if scenePhase == .active { await load() } }
            .onChange(of: store.eventRevision) { _, _ in Task { await load() } }
            .onChange(of: scenePhase) { _, next in
                if next != .active { loadTask?.cancel(); loading = false }
            }
            .onDisappear { loadTask?.cancel() }
        }
    }

    private func load() async {
        guard scenePhase == .active else { return }
        loadTask?.cancel()
        let task = Task { await fetchEntries() }
        loadTask = task
        await task.value
    }

    private func fetchEntries() async {
        loading = entries.isEmpty
        do {
            var result: [ScheduledEntry] = []
            for bot in store.bots {
                let response: SchedulesResponse = try await store.api.get("/api/bots/\(bot.id)/schedules")
                try Task.checkCancellation()
                result += response.schedules.map { ScheduledEntry(target: .bot(bot.id), ownerName: bot.displayName, schedule: $0) }
            }
            for room in store.rooms {
                let response: SchedulesResponse = try await store.api.get("/api/rooms/\(room.id)/schedules")
                try Task.checkCancellation()
                result += response.schedules.map { ScheduledEntry(target: .room(room.id), ownerName: room.name, schedule: $0) }
            }
            entries = result.filter { $0.schedule.nextRunAt != nil || $0.schedule.enabled == true }
                .sorted { (BellDate.parse($0.schedule.nextRunAt ?? "") ?? .distantFuture) <
                          (BellDate.parse($1.schedule.nextRunAt ?? "") ?? .distantFuture) }
            errorText = nil
        } catch is CancellationError { return }
        catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch { errorText = error.localizedDescription }
        loading = false
    }

    private func run(_ entry: ScheduledEntry) async {
        do {
            try await store.billing.requirePaidAccess()
            let _: APIAcknowledgement = try await store.api.post(entry.path + "/run", body: ScheduleEmptyBody())
            await load()
        } catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch { errorText = error.localizedDescription }
    }

    private func remove(_ entry: ScheduledEntry) async {
        do {
            try await store.api.delete(entry.path)
            await load()
        } catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch { errorText = error.localizedDescription }
    }
}

private struct ScheduleEmptyBody: Encodable {}

struct ScheduledEntry: Identifiable {
    let target: ChatTarget
    let ownerName: String
    let schedule: Schedule
    var id: String { "\(target.path)/\(schedule.id)" }
    var path: String { "\(target.path)/schedules/\(schedule.id)" }
}

private struct ScheduleCard: View {
    let entry: ScheduledEntry
    let bot: Bot?
    let edit: () -> Void
    let run: () -> Void
    let remove: () -> Void
    @State private var confirmDelete = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                AvatarView(name: entry.ownerName, avatar: bot?.avatar ?? "",
                           color: BellTheme.accent(bot?.color ?? "violet"), size: 42, isRoom: entry.target.isRoom)
                VStack(alignment: .leading, spacing: 3) {
                    Text(entry.ownerName).font(.system(size: 13, weight: .semibold)).foregroundStyle(BellTheme.violet)
                    Text(entry.schedule.title)
                        .font(.system(size: 17, weight: .bold, design: .rounded))
                        .foregroundStyle(BellTheme.ink)
                        .lineLimit(2)
                }
                Spacer()
                Image(systemName: entry.schedule.kind == "once" ? "calendar" : "repeat")
                    .foregroundStyle(BellTheme.violet)
            }
            if let action = entry.schedule.command ?? entry.schedule.prompt {
                Text(action).font(.system(size: 14)).foregroundStyle(BellTheme.muted).lineLimit(3)
            }
            HStack(spacing: 6) {
                Image(systemName: "clock")
                Text(entry.schedule.nextRunAt.map { "次回 \(BellDate.long($0))" } ?? "次回未定")
            }
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(BellTheme.violet)
            Divider()
            HStack {
                Button("今すぐ実行", action: run).font(.system(size: 13, weight: .semibold))
                Spacer()
                Button("編集", action: edit).font(.system(size: 13, weight: .semibold))
                Button(role: .destructive) { confirmDelete = true } label: {
                    Image(systemName: "trash")
                }
                .padding(.leading, 12)
            }
        }
        .padding(18)
        .bellCard()
        .confirmationDialog("この予定を削除しますか？", isPresented: $confirmDelete) {
            Button("削除", role: .destructive, action: remove)
        }
    }
}

private struct ScheduleRequest: Encodable {
    let name: String
    let kind: String
    let prompt: String?
    let command: String?
    let enabled: Bool
    let at: String?
    let expression: String?
    let timezone: String?
    let targets: [String]?
    let intervalDays: Int?
    let startDate: String?
    let time: String?
    let intervalHours: Int?
    let startHour: Int?
    let endHour: Int?
    let minute: Int?
}

private struct ScheduleEditor: View {
    let initial: ScheduledEntry?
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var target: ChatTarget?
    @State private var name = ""
    @State private var action = "prompt"
    @State private var prompt = ""
    @State private var command = ""
    @State private var frequency = "once"
    @State private var date = Date().addingTimeInterval(3600)
    @State private var minute = 0
    @State private var hour = 9
    @State private var weekdays: Set<Int> = [1]
    @State private var expression = "0 9 * * 1-5"
    @State private var selectedTargets: Set<String> = []
    @State private var intervalDays = 2
    @State private var startDate = Date()
    @State private var intervalHours = 3
    @State private var startHour = 9
    @State private var endHour = 18
    @State private var saving = false
    @State private var errorText: String?

    private var targets: [(ChatTarget, String)] {
        store.bots.map { (.bot($0.id), $0.displayName) } + store.rooms.map { (.room($0.id), $0.name) }
    }
    private var room: Room? {
        guard case .room(let id) = target else { return nil }
        return store.rooms.first { $0.id == id }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("担当") {
                    Picker("メンバー・ルーム", selection: $target) {
                        ForEach(targets, id: \.0) { item in Text(item.1).tag(Optional(item.0)) }
                    }
                    .disabled(initial != nil)
                    .onChange(of: target) { _, next in
                        if case .room = next {
                            selectedTargets.removeAll()
                        }
                    }
                    if let room {
                        Text("返信するメンバーを指定。未選択なら自動選択し、発言は全員に届きます。")
                            .font(.footnote)
                        ForEach(room.memberIds, id: \.self) { id in
                            Toggle(store.bots.first(where: { $0.id == id })?.displayName ?? id,
                                   isOn: Binding(get: { selectedTargets.contains(id) }, set: { value in
                                if value { selectedTargets.insert(id) } else { selectedTargets.remove(id) }
                            }))
                        }
                    }
                }
                Section("実行内容") {
                    TextField("予定の名前", text: $name)
                    if room == nil {
                        Picker("種類", selection: $action) {
                            Text("AIへの指示").tag("prompt")
                            Text("コマンド").tag("command")
                        }
                    }
                    if action == "command" && room == nil {
                        TextField("実行するコマンド", text: $command, axis: .vertical).lineLimit(2...5)
                    } else {
                        TextField("依頼する内容", text: $prompt, axis: .vertical).lineLimit(3...8)
                    }
                }
                Section("タイミング") {
                    Picker("繰り返し", selection: $frequency) {
                        Text("一回だけ").tag("once")
                        Text("毎時").tag("hourly")
                        Text("毎日").tag("daily")
                        Text("毎週").tag("weekly")
                        Text("数日おき").tag("interval_days")
                        Text("数時間おき").tag("interval_hours")
                        Text("cron式").tag("cron")
                    }
                    switch frequency {
                    case "once":
                        DatePicker("実行日時", selection: $date, in: Date()..., displayedComponents: [.date, .hourAndMinute])
                    case "hourly":
                        Picker("毎時何分", selection: $minute) {
                            ForEach(0..<60, id: \.self) { Text("\($0)分").tag($0) }
                        }
                    case "daily", "weekly":
                        DatePicker("時刻", selection: $date, displayedComponents: .hourAndMinute)
                        if frequency == "weekly" {
                            ForEach(0..<7, id: \.self) { day in
                                Toggle(["日", "月", "火", "水", "木", "金", "土"][day],
                                       isOn: Binding(get: { weekdays.contains(day) }, set: { value in
                                    if value { weekdays.insert(day) } else { weekdays.remove(day) }
                                }))
                            }
                        }
                    case "interval_days":
                        Stepper("\(intervalDays)日おき", value: $intervalDays, in: 1...365)
                        DatePicker("開始日", selection: $startDate, displayedComponents: .date)
                        DatePicker("時刻", selection: $date, displayedComponents: .hourAndMinute)
                    case "interval_hours":
                        Stepper("\(intervalHours)時間おき", value: $intervalHours, in: 1...24)
                        Stepper("開始 \(startHour)時", value: $startHour, in: 0...23)
                        Stepper("終了 \(endHour)時", value: $endHour, in: 0...23)
                        Picker("実行する分", selection: $minute) {
                            ForEach(0..<60, id: \.self) { Text("\($0)分").tag($0) }
                        }
                    default:
                        TextField("cron式", text: $expression).textInputAutocapitalization(.never)
                    }
                }
                if let errorText { Section { Text(errorText).foregroundStyle(.red) } }
            }
            .scrollContentBackground(.hidden)
            .background(BellBackground())
            .navigationTitle(initial == nil ? "予定を追加" : "予定を編集")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("キャンセル") { dismiss() } }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("保存") { Task { await save() } }.fontWeight(.semibold).disabled(saving || target == nil)
                }
            }
            .onAppear(perform: populate)
        }
    }

    private func populate() {
        guard let initial else { target = targets.first?.0; return }
        target = initial.target
        let item = initial.schedule
        name = item.name ?? ""
        prompt = item.prompt ?? ""
        command = item.command ?? ""
        action = item.command == nil ? "prompt" : "command"
        if item.kind == "once" {
            frequency = "once"
            date = BellDate.parse(item.at ?? "") ?? date
        } else if item.kind == "interval_days" {
            frequency = "interval_days"
            intervalDays = item.intervalDays ?? 2
            if let value = item.startDate { startDate = DateFormatter.bellCalendarDate.date(from: value) ?? startDate }
            if let value = item.time {
                let components = value.split(separator: ":").compactMap { Int($0) }
                if components.count == 2 {
                    date = Calendar.current.date(bySettingHour: components[0], minute: components[1], second: 0, of: date) ?? date
                }
            }
        } else if item.kind == "interval_hours" {
            frequency = "interval_hours"
            intervalHours = item.intervalHours ?? 3
            startHour = item.startHour ?? 9
            endHour = item.endHour ?? 18
            minute = item.minute ?? 0
        } else {
            let parts = (item.expression ?? "").split(separator: " ").map(String.init)
            if parts.count == 5 {
                expression = item.expression ?? expression
                minute = Int(parts[0]) ?? 0
                hour = Int(parts[1]) ?? 9
                if parts[1] == "*" { frequency = "hourly" }
                else if parts[2] == "*" && parts[3] == "*" && parts[4] == "*" { frequency = "daily" }
                else if parts[2] == "*" && parts[3] == "*" {
                    frequency = "weekly"
                    weekdays = Set(parts[4].split(separator: ",").compactMap { Int($0) })
                } else { frequency = "cron" }
                date = Calendar.current.date(bySettingHour: hour, minute: minute, second: 0, of: date) ?? date
            } else { frequency = "cron" }
        }
        if room != nil { selectedTargets = Set(item.targets ?? []) }
    }

    private func save() async {
        guard let target else { return }
        let content = action == "command" && !target.isRoom ? command : prompt
        guard !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            errorText = "実行内容を入力してください。"; return
        }
        if frequency == "weekly" && weekdays.isEmpty { errorText = "曜日を選んでください。"; return }
        saving = true
        defer { saving = false }
        let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
        let min = parts.minute ?? 0
        let hr = parts.hour ?? 9
        let cron: String? = switch frequency {
        case "hourly": "\(minute) * * * *"
        case "daily": "\(min) \(hr) * * *"
        case "weekly": "\(min) \(hr) * * \(weekdays.sorted().map(String.init).joined(separator: ","))"
        case "cron": expression.trimmingCharacters(in: .whitespacesAndNewlines)
        default: nil
        }
        let request = ScheduleRequest(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            kind: ["once", "interval_days", "interval_hours"].contains(frequency) ? frequency : "cron",
            prompt: action == "command" && !target.isRoom ? nil : prompt,
            command: action == "command" && !target.isRoom ? command : nil,
            enabled: true,
            at: frequency == "once" ? ISO8601DateFormatter().string(from: date) : nil,
            expression: cron,
            timezone: frequency == "once" ? nil : (initial?.schedule.timezone ?? TimeZone.current.identifier),
            targets: target.isRoom && !selectedTargets.isEmpty ? Array(selectedTargets) : nil,
            intervalDays: frequency == "interval_days" ? intervalDays : nil,
            startDate: frequency == "interval_days" ? DateFormatter.bellCalendarDate.string(from: startDate) : nil,
            time: frequency == "interval_days" ? String(format: "%02d:%02d", hr, min) : nil,
            intervalHours: frequency == "interval_hours" ? intervalHours : nil,
            startHour: frequency == "interval_hours" ? startHour : nil,
            endHour: frequency == "interval_hours" ? endHour : nil,
            minute: frequency == "interval_hours" ? minute : nil
        )
        do {
            try await store.billing.requirePaidAccess()
            let path = target.path + "/schedules"
            if let initial {
                let _: ScheduleResponse = try await store.api.put(path + "/\(initial.schedule.id)", body: request)
            } else {
                let _: ScheduleResponse = try await store.api.post(path, body: request)
            }
            dismiss()
        } catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch { errorText = error.localizedDescription }
    }
}

extension BellDate {
    static func long(_ value: String) -> String {
        guard let date = parse(value) else { return "未定" }
        return date.formatted(.dateTime.month().day().weekday(.abbreviated).hour().minute())
    }
}

private extension DateFormatter {
    static let bellCalendarDate: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        return formatter
    }()
}
