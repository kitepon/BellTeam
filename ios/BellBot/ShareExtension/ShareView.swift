import SwiftUI

struct ShareView: View {
    @ObservedObject var model: ShareModel

    var body: some View {
        NavigationStack {
            Group {
                switch model.phase {
                case .loading: ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                case .notReady(let reason): message(reason)
                case .sent(let name): sent(name)
                case .ready: form
                }
            }
            .navigationTitle("BellTeamへ共有")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { model.cancel() } }
            }
        }
    }

    private var form: some View {
        Form {
            Section("共有する内容") {
                if !model.content.text.isEmpty { Text(model.content.text).lineLimit(4) }
                ForEach(model.content.urls, id: \.self) { Text($0).lineLimit(1).foregroundStyle(.secondary) }
                if !model.content.images.isEmpty { Label("画像\(model.content.images.count)枚", systemImage: "photo") }
                if let refusal = model.content.refusal { Text(refusal).foregroundStyle(.orange).font(.footnote) }
            }
            Section("送り先") {
                ForEach(model.destinations) { destination in
                    Button {
                        model.pick = destination
                    } label: {
                        HStack {
                            Text(destination.name)
                            if destination.kind == .room { Text("部屋").font(.caption).foregroundStyle(.secondary) }
                            Spacer()
                            if model.pick == destination { Image(systemName: "checkmark.circle.fill") }
                        }
                    }
                    .foregroundStyle(.primary)
                }
            }
            Section("コメント（なくても送れます）") {
                TextField("この内容についての依頼や一言", text: $model.comment, axis: .vertical).lineLimit(3...6)
            }
            if let errorText = model.errorText { Text(errorText).foregroundStyle(.red).font(.footnote) }
            Section {
                Button(model.sending ? "送っています…" : "送る") { Task { await model.send() } }.disabled(!model.canSend)
            }
        }
    }

    private func message(_ text: String) -> some View {
        VStack(spacing: 16) {
            Text(text).multilineTextAlignment(.center).padding()
            Button("閉じる") { model.cancel() }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func sent(_ name: String) -> some View {
        VStack(spacing: 16) {
            Text("送りました（\(name)）。").font(.headline)
            Button("閉じる") { model.finish() }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
