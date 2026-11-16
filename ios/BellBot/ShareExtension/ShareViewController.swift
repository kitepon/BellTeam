import SwiftUI
import UIKit

/// 他のアプリの共有シートから開く。テキスト・URL・画像を受け取り、Botか部屋とコメントを選んで送る（conversation forward.md の share）。
final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        let model = ShareModel(items: (extensionContext?.inputItems as? [NSExtensionItem]) ?? [],
                               finish: { [weak self] in self?.extensionContext?.completeRequest(returningItems: nil) },
                               cancel: { [weak self] in
                                   self?.extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
                               })
        let host = UIHostingController(rootView: ShareView(model: model))
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
    }
}
