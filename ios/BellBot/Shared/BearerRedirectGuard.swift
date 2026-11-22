import Foundation

/// B5（Mintの適合確認）: セッションのトークンを付けた要求は、どこへのリダイレクトも辿らない（トークンを別のホストへ渡さない）。
/// 付けていない要求（Cloudflare Accessの旧経路の最初の読み取りなど）は今までどおり辿る。アプリ（BellAPI）と共有拡張（ShareClient）が同じ規則を使う。
final class BearerRedirectGuard: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(task.originalRequest?.value(forHTTPHeaderField: "Authorization") == nil ? request : nil)
    }
}
