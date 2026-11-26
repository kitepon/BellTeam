import SwiftUI

/// 「決裁箱につなぐ」: under 「決裁箱につながっています」 and the sign-out. Owner's session only; the QR is drawn from qrText with the component the device pairing already uses.
struct SeatLinkSection: View {
    @EnvironmentObject private var store: AppStore
    var body: some View { Content(model: SeatLinkModel(api: store.api)) }

    struct Content: View {
        @StateObject var model: SeatLinkModel

        init(model: SeatLinkModel) { _model = StateObject(wrappedValue: model) }

        var body: some View {
            Group {
                if let link = model.link, link.state != "absent" { section(link) }
            }
            // Read once; while it waits, read every 2 s (waiting → linked / failed). The task restarts on each state change.
            .task(id: model.link?.state) {
                if model.link == nil { await model.read(); return }
                while !Task.isCancelled, model.link?.state == "waiting" {
                    try? await Task.sleep(for: .seconds(2))
                    if Task.isCancelled { break }
                    await model.read()
                }
            }
        }

        private func section(_ link: SeatLink) -> some View {
            VStack(alignment: .leading, spacing: 10) {
                Divider().padding(.vertical, 4)
                Text(SeatLinkWords.title).font(.system(size: 14, weight: .semibold)).foregroundStyle(LatticePalette.ink)
                    .accessibilityIdentifier("seat-link-title")
                if let badge = badge(link) { badgeView(badge.text, badge.color) }
                Text(SeatLinkWords.line(link)).font(.system(size: 13)).foregroundStyle(LatticePalette.ink)
                    .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("seat-link-line")
                if link.waiting { waiting(link) }
                actions(link)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }

        private func badge(_ link: SeatLink) -> (text: String, color: Color)? {
            switch link.state {
            case "linked": (SeatLinkWords.badgeLinked, LatticePalette.live)
            case "removed": (SeatLinkWords.badgeRemoved, LatticePalette.muted)
            case "failed", "unavailable": (SeatLinkWords.badgeFailed, LatticePalette.red)
            default: nil
            }
        }

        /// The same chip as 「ライブ」: a dot and a word in the muted capsule.
        private func badgeView(_ text: String, _ color: Color) -> some View {
            HStack(spacing: 5) {
                Circle().fill(color).frame(width: 7, height: 7)
                Text(text).font(.system(size: 12, weight: .semibold))
            }
            .foregroundStyle(LatticePalette.muted)
            .padding(.horizontal, 9).padding(.vertical, 4).background(LatticePalette.lane, in: Capsule())
            .accessibilityElement(children: .combine).accessibilityIdentifier("seat-link-badge")
        }

        /// The instruction line comes first (above); then the QR, the typed code and the expiry.
        private func waiting(_ link: SeatLink) -> some View {
            VStack(spacing: 8) {
                if let picture = ServerLoginView.qrImage(link.qrText ?? "") {
                    Image(uiImage: picture).interpolation(.none).resizable().scaledToFit().frame(width: 180, height: 180)
                        .accessibilityLabel("決裁箱のアプリで読むQRコード")
                }
                value(SeatLinkWords.codeLabel, link.code, id: "seat-link-code")
                value(SeatLinkWords.secretLabel, link.typedSecret, id: "seat-link-secret")
                if let until = link.expiresAt {
                    Text(SeatLinkWords.until(until)).font(.system(size: 12.5)).foregroundStyle(LatticePalette.muted)
                }
            }
            .frame(maxWidth: .infinity)
        }

        /// A labelled value the Owner can select and copy.
        @ViewBuilder private func value(_ label: String, _ text: String?, id: String) -> some View {
            if let text, !text.isEmpty {
                VStack(spacing: 2) {
                    Text(label).font(.system(size: 12)).foregroundStyle(LatticePalette.muted)
                    Text(verbatim: text).font(.system(size: 16, design: .monospaced)).textSelection(.enabled)
                        .accessibilityIdentifier(id)
                }
            }
        }

        @ViewBuilder private func actions(_ link: SeatLink) -> some View {
            switch link.state {
            case "none":
                Button(SeatLinkWords.connect) { Task { await model.start() } }.buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("seat-link-go")
            case "waiting":
                Button(SeatLinkWords.cancel) { Task { await model.stop() } }.buttonStyle(.bordered)
                    .accessibilityIdentifier("seat-link-cancel")
            case "linked": EmptyView()
            default:
                Button(SeatLinkWords.again) { Task { await model.start() } }.buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("seat-link-go")
            }
        }
    }
}
