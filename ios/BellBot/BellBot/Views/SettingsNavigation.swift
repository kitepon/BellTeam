import SwiftUI

/// iPad and Mac: a row inside a settings page opens inside the right pane, so the settings list stays visible.
/// The window's detail column is one navigation stack of its own; a NavigationLink inside the pane pushes onto that stack
/// and replaces the whole settings screen (docs/architecture/modules/apple/settings-user-flow.md B17), so the pane keeps its own stack.
@MainActor
final class SettingsPageNavigator: ObservableObject {
    struct Item: Identifiable {
        let id = UUID()
        let title: String
        let view: AnyView
    }

    @Published private(set) var stack: [Item] = []

    func push(title: String, _ view: AnyView) { stack.append(Item(title: title, view: view)) }
    func pop() { _ = stack.popLast() }
    func reset() { stack = [] }
}

private struct SettingsNavigatorKey: EnvironmentKey {
    static let defaultValue: SettingsPageNavigator? = nil
}

extension EnvironmentValues {
    /// Set only by the iPad/Mac split layout; nil on iPhone, where NavigationLink pushes normally.
    var settingsNavigator: SettingsPageNavigator? {
        get { self[SettingsNavigatorKey.self] }
        set { self[SettingsNavigatorKey.self] = newValue }
    }
}

/// NavigationLink on iPhone; a push into the right pane on iPad and Mac.
struct SettingsNavLink<Destination: View, Label: View>: View {
    @Environment(\.settingsNavigator) private var navigator
    let title: String
    /// Rows in a form show the disclosure arrow a NavigationLink would draw there.
    var chevron = false
    @ViewBuilder let destination: () -> Destination
    @ViewBuilder let label: () -> Label

    var body: some View {
        if let navigator {
            Button { navigator.push(title: title, AnyView(destination())) } label: {
                HStack {
                    label()
                    if chevron {
                        Spacer(minLength: 6)
                        Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary).accessibilityHidden(true)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        } else {
            NavigationLink { destination() } label: { label() }
        }
    }
}

/// The right pane: the page, or the sub-page pushed from it, under a small back bar. A new selection is a new pane (the stack starts empty).
struct SettingsDetailPane: View {
    let page: SettingsPage
    /// A route asked from outside (an 要対応 row): the pane opens it once, then clears it.
    @Binding var pendingRoute: SettingsRoute?
    @EnvironmentObject private var home: SettingsHomeState
    @StateObject private var navigator = SettingsPageNavigator()

    var body: some View {
        VStack(spacing: 0) {
            if let top = navigator.stack.last {
                HStack(spacing: 12) {
                    Button { navigator.pop() } label: {
                        Label(navigator.stack.count > 1 ? navigator.stack[navigator.stack.count - 2].title : page.title, systemImage: "chevron.left")
                    }
                    .accessibilityIdentifier("settings-pane-back")
                    Spacer()
                    Text(top.title).font(.headline).lineLimit(1)
                    Spacer()
                    // Keeps the title centred against the back button.
                    Color.clear.frame(width: 1, height: 1)
                }
                .padding(.horizontal, 16).padding(.vertical, 10)
                Divider()
                top.view.id(top.id).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                SettingsPageView(page: page)
            }
        }
        .environment(\.settingsNavigator, navigator)
        .onChange(of: pendingRoute, initial: true) { _, route in
            guard let route else { return }
            pendingRoute = nil
            navigator.reset()
            if case .authentication(let harness, let slot) = route {
                let name = home.aiEntries?.first { $0.harnessID == harness && $0.slot == slot }?.name ?? SettingsPage.ai.title
                navigator.push(title: name, AnyView(HarnessAuthenticationDestination(harnessID: harness, slot: slot)))
            }
        }
    }
}
