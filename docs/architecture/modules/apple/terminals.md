# 端末の登録とメンバーの端末・フォルダ（F-SEAT-HOST P2）

[全体図](overview.md) / [メンバー・ルーム編集](members-and-rooms.md) / [設定](settings-and-profile.md) / [関数索引](function-index.md) / [試験](tests.md)。以下の実装名は`ios/BellBot/BellBot/`からの相対名。

使う契約：[terminals](../terminals/README.md)（registry・reachability・C8 maintenance）、[ingress RS09/RS12](../integration/remote-seat-ingress.md#data-flow)（HTTP `/api/terminals*`、鍵を結ぶのはBot MCPの`bind_terminal_key`だけ）、[members C1](../members/remote-seat.md#c1-member-binding)（`terminalId`・`projectRoot`）、[secret credentials C5](../usage/secret-credentials.md)（1Password参照を先、保存値は代替。値は一般の欄に書かない）。Appleはこれらの利用側で、契約を変えない。

## 機能図

```mermaid
flowchart TD
  SettingsRow["SettingsView: SettingsPage.terminals<br/>設定の「端末」"] --> List["TerminalListPage<br/>一覧・追加・未対応の一行"]
  EditorLink["BotEditor「端末とフォルダ」<br/>「端末を管理」"] --> List
  List --> Detail["TerminalDetailPage<br/>接続先・確認結果・ホスト鍵・鍵・C8"]
  List --> Form["TerminalEditor<br/>ID・ホスト・ユーザー・ポート・OS・持ち主"]
  Detail --> Form
  Detail --> HostKey["HostKeyConfirmSheet<br/>端末で読んだ指紋を入力"]
  Detail --> Keys["鍵の行: 設定済み/未設定だけ<br/>「Botに頼んで設定する」"]
  Form --> Rules["TerminalDraft.problem<br/>サーバーと同じ形の検査"]
  HostKey --> FP["HostKeyFingerprint.problem<br/>SHA256:+43文字"]
  Store["AppStore+Terminals<br/>terminals: TerminalDirectory"] --> API["BellAPI get/put/post/delete"]
  List --> Store
  Detail --> Store
  Form --> Store
  HostKey --> Store
  Section["MemberTerminalSection<br/>このBellTeam / 登録した端末 + フォルダ"] --> Store
  Section --> Pair["MemberBinding.problem<br/>組の規則・絶対パス"]
  BotEditor["BotEditor.save"] --> Pair
  BotEditor --> Members["BotSettings.terminalId / projectRoot<br/>対応サーバーだけ送る"]
  Store --> Errors["TerminalErrorText<br/>符号から平易な文"]
```

| 部品 | 責任 |
| --- | --- |
| `Core/Terminals.swift` | `Terminal`・`TerminalCheck`・`TerminalMaintenance`（新しい項目はすべて省略可で読む）、`TerminalDraft`（登録の検査とbody）、`MemberBinding`（組の規則とフォルダの検査）、`HostKeyFingerprint`、`TerminalReachabilityText`（確認結果の文）、`TerminalErrorText`（HTTPの符号から文） |
| `Core/AppStore+Terminals.swift` | `TerminalDirectory`（`state`・`checks`・`checking`）を`AppStore.terminals`に保持。`refreshTerminals`・`saveTerminal`・`confirmHostKey`・`removeTerminal`・`checkTerminal`。サインアウトと接続先変更で空に戻す |
| `Views/TerminalsView.swift` | 一覧・詳細・登録/編集・ホスト鍵の画面と、メンバー編集の「端末とフォルダ」節 |
| `Views/ManagementView.swift` | BotEditorに節を置き、保存前に組の規則を検査し、対応サーバーの時だけ2項目を送る |
| `Views/SettingsView.swift` | 設定の項目「端末」 |

## データの流れ

| ID | 画面 -> HTTP | 送るもの / 戻り |
| --- | --- | --- |
| AT01 | 一覧・メンバー編集 -> `GET /api/terminals` | `{terminals:[…]}`。404、または503 `TERMINALS_UNAVAILABLE`は「未対応」として一行だけ出す（赤字なし）。他の失敗は理由と再読込 |
| AT02 | 登録・編集 -> `PUT /api/terminals/:id` | `host`・`user`・`port`・`os`・`accountOwner`だけ。鍵の項目は送らない。応答の公開projectionを一覧へ反映。IDは登録時だけ入力し、編集では変えない |
| AT03 | 確認 -> `POST /api/terminals/:id/check` | `{reachable, reason, action?, observedAt}`を端末ごとに`checks`へ保持（アプリ内だけ）。席は起動しない |
| AT04 | ホスト鍵 -> `PUT /api/terminals/:id` `{confirmHostKey:'SHA256:…'}` | オーナーが端末で読んだ指紋だけを送る。サーバーは一度scanし、等しい時だけ信用し直す。409 `HOST_KEY_FINGERPRINT_MISMATCH`は「指紋が違う」と表示して入力を残す |
| AT05 | 削除 -> `DELETE /api/terminals/:id` | 確認ダイアログの後。メンバーの設定と保留中のメッセージは残ると表示 |
| AT06 | メンバー保存 -> `PATCH /api/bots/:id` / `POST /api/bots` | 対応サーバーの時だけ`terminalId`・`projectRoot`（このBellTeamは両方空）。400 `BOT_TERMINAL_ID_INVALID`・`BOT_PROJECT_ROOT_INVALID`・`BOT_REMOTE_BINDING_INVALID`は画面の検査と同じ文 |

鍵（SSH・sudo）を結ぶ入口はアプリから届かない。HTTPに無く、Bot MCPの`bind_terminal_key`（Aitermが持つ鍵の登録）と`register_terminal`の`sudoKeyRef`（秘密入力カードの参照）だけがある。アプリは設定済み/未設定だけを表示し、行に「Botに頼んで設定する」とその理由を出す。鍵の値・`op://`参照の欄は作らない。アプリの入口が契約に加わったら、1Password参照を先、秘密入力カードの保存値を代替として同じ行から結ぶ。

## 状態

```mermaid
stateDiagram-v2
  [*] --> NotLoaded
  NotLoaded --> Loading: 画面を開く
  Loading --> Supported: 200
  Loading --> Unsupported: 404 / 503 TERMINALS_UNAVAILABLE
  Loading --> Failed: その他の失敗（理由と再読込）
  Failed --> Loading: 再読込
  Unsupported --> Loading: 画面を開き直す
  Supported --> Supported: 保存・削除・ホスト鍵は応答を一覧へ反映、確認は checks へ
  Supported --> Loading: 画面を開き直す・再読込（後の失敗は一覧を残して readError）
  Supported --> [*]: サインアウト / 接続先変更で破棄
```

| 確認結果（`reason`） | 表示 |
| --- | --- |
| `reachable:true` | つながる（確かめた時刻） |
| `TERMINAL_UNAVAILABLE`・`UNREACHABLE`・`REMOTE_AITERM_*`・`CONNECTION_LOST` | つながらない。端末が眠っているか届かない。起きれば自動で再開する |
| `CREDENTIAL_UNAVAILABLE`・`SSH_KEY_UNSET`・`CREDENTIAL_*`・`AUTH_FAILED` | つながらない。SSH鍵が無いか使えない |
| `TARGET_MISMATCH`・`HOST_TRUST_*`・`HOST_KEY_*` | つながらない。ホスト鍵を確かめる必要がある（「ホスト鍵を確かめる」を出す） |
| `TERMINAL_NOT_FOUND` | 登録が見つからない |

サーバーの`action`（英文）は「サーバーの案内」として小さく添える。応答に指紋の項目は無い。`action`に`SHA256:`の指紋が含まれる時だけ「サーバーが示した指紋」として並べて見せ、入力した指紋との一致を表示する。どちらの場合も、オーナーが端末で読んだ指紋を入れない限り送らない。

## メンバー編集「端末とフォルダ」

| 状態 | 表示 |
| --- | --- |
| 一覧未対応（AT01） | 「このBellTeamはまだ端末の登録に対応していません」の一行。項目を送らない |
| メンバーの応答に`terminalId`が無い（旧本体） | 「このBellTeamはまだメンバーの端末設定に対応していません」の一行。項目を送らない |
| 対応 | 「動かす場所」Picker（このBellTeam / 登録した端末）。端末を選ぶとフォルダ欄。このBellTeamに戻すと両方空 |
| 保存済みの端末が一覧に無い | 「（登録が見つかりません）」付きで選択肢に残し、別の端末へ自動で替えない |

検査はサーバーと同じ：`terminalId`は`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`、`projectRoot`は`/`で始まり、NUL・`.`・`..`・空の区切り・末尾の`/`（`/`だけは可）を含まず4096バイト以下。片方だけは保存しない。

## 旧本体との互換

すべての新しい項目は省略可で読む。旧本体では端末の一覧が404になり、メンバーに2項目が無いので、両方の節は一行の案内だけになる。`BotSettings`の2項目は`nil`の時にencodeせず、保存結果の照合でも`nil`ならサーバーの現在値を採用する。

## 試験と確認用の起動引数

単体は`TerminalsTests`、iPhoneの画面は`TerminalsUITests`と[terminals-ui-server.mjs](../../../../test/helpers/terminals-ui-server.mjs)（[試験の対応表](tests.md#terminalsuitestsswift)）。DEBUGの`-bellbot-preview-terminals`はpreview名簿に2項目を付ける（無ければ旧本体の名簿）。`-bellbot-preview-terminal add | detail:<id> | check:<id> | hostkey:<id> | edit:<id>`は`-bellbot-preview-settings terminals`と組み合わせてその状態を開く。

## 未調査

- サーバーが`action`に指紋を含めるか（Aitermの文面）。含まない時は端末で読んだ指紋の入力だけで確かめる。
- 実端末への確認・ホスト鍵の信用し直しは、試験用サーバー（`test/helpers/terminals-ui-server.mjs`）だけで確認した。
