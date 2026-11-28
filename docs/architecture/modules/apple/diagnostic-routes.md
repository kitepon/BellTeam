# 通信失敗の診断で残す経路の型

[担当の正本](README.md)。Apple全体の図ではなく、修理の範囲だけを示す。

対応版：base `19e739e5` に対する修理。1.0.5 (100)以前は、予定の一括取得、会話の画像、ハーネス認証の個別状態のGETが失敗すると、どれも `/api/other`・`operation=unknown`・module `app` として送られ、記録から見分けられない。

## 流れ

```mermaid
flowchart TD
  Req["BellAPI の要求<br/>実際のpath"] --> Route["BellRequestTrace.route(for:)<br/>値を落として経路の型にする"]
  Route -->|"/api/schedules"| Sch["/api/schedules<br/>operation schedule_read・module schedules"]
  Route -->|"/api/message-images/所有者/ファイル"| Img["/api/message-images/:id/:id<br/>module image"]
  Route -->|"/api/harness-auth/種類"| Auth["/api/harness-auth/:id<br/>module session"]
  Route -->|"上の表と既存の型にないもの"| Other["/api/other<br/>module app"]
  Sch --> Report["BellDiagnostics.report<br/>IOS_HTTP_5XXなどを /api/diagnostics へ"]
  Img --> Report
  Auth --> Report
  Other --> Report
```

## 責任と受渡し

| 段階 | 所有者と場所 | 契約 |
| --- | --- | --- |
| 経路の型 | `BellRequestTrace.route(for:)`（`Core/BellDiagnostics.swift`） | 所有者・ファイル名・認証の種類などの値は残さない。既存の型（bots・rooms・settingsなど）は変えない |
| 操作名 | `BellDiagnostics.requestContextLog` | 経路の型から決める。`/api/schedules` は既存の `/schedules` 末尾の規則で `schedule_read` になる |
| module | `BellDiagnostics.module(for:)` | 経路の型から決める。`/api/harness-auth/:id` は `/api/harness-auth` と同じ session |
| サーバーの失敗符号 | `BellRequestTrace.serverErrorCode(from:)` を `BellAPI.traced` が失敗応答の本文から付け、`BellDiagnostics.errorLog` が書く | 応答本文の `error` が値全体で `[A-Z0-9_]{1,100}` の時だけ `http_error_code=` に残す。人向けの `message`・自由文・`BOT_NOT_FOUND: <id>` のような値付きの文は残さない。画面の文と失敗の扱いは変えない。集約の単位（`src/diagnostic-report-context.mjs`）には入れない |

サーバー側の分類（`src/diagnostic-request-context.mjs`、担当モリー）も同じ3本を `/api/other` にしている。名前の揃え方はモリーと合わせる。

## 確認済みと未確認

確認済み（直接試験）：3本のGETの失敗が、値を含まない経路の型・module・操作名で送られる。`/api/harness-auth/<種類>/input` など、表にない経路は従来どおり `/api/other`。

未確認：過去の記録（f6c057c6・88564ff5）の原因や経路は、この修理で後から決めない。iPhone・iPad・Macの実画面。

## 診断送信のBearer（監査 H-08）

`BellAPI.sessionToken`の`didSet`が`BellDiagnostics.updateSessionToken`へ同じ値を渡す。診断は`send`が`serverURL`と`sessionToken`を同じ錠の中で一緒に読み、`BellDiagnostics.request(baseURL:token:)`が`<設定した接続先>/api/diagnostics`へのPOSTを作る。トークンがあれば`Authorization: Bearer`を付ける。

```mermaid
flowchart TD
  Tok["BellAPI.sessionToken 変更<br/>（ログイン・サインアウト・接続先変更・401）"] -->|didSet| Upd["BellDiagnostics.updateSessionToken"]
  Srv["AppStore.setServerAddress / changeServer<br/>BellDiagnostics.configure(serverURL:)"] -->|"接続先が前と違う（nilを含む）"| Drop["sessionTokenを捨てる"]
  Srv -->|"初回 nil→url"| Keep["復元済みのトークンを残す"]
  Upd --> Send["BellDiagnostics.send<br/>serverURLとtokenを同じ錠で読む"]
  Drop --> Send
  Keep --> Send
  Send --> Req["request(baseURL:token:)<br/>POST 設定した接続先/api/diagnostics"]
  Req --> Net["URLSession.shared + SecretRedirectDelegate"]
  Net -->|"リダイレクト"| Refuse["拒否（completionHandler(nil)）。別オリジンへ再送しない"]
  Net -->|"202"| Done["完了"]
```

- トークンが出る先は、設定した接続先のオリジンだけ。接続先の変更・サインアウトでは`BellAPI`が先にトークンを消し（`AppStore`の接続先変更は`api.sessionToken = nil`の後に`configure`）、`configure`も前と違う接続先でトークンを捨てる。リダイレクトは`SecretRedirectDelegate`が拒否するので、302の先へ`Authorization`が付くことはない。
- 試験：`BellDiagnosticsTests.testDiagnosticsBearerStaysOnTheConfiguredOrigin`。
