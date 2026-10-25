# SwiftUIの背景とキーボード安全領域

出典: [Appleの背景配置](raw/apple-background-keyboard.md)、[キーボード安全領域](raw/apple-keyboard-safe-area.md)、[BellTeamの隔離実測](../../docs/evidence/2026-10-25-ipad-composer-keyboard.md)。取得日: 2026-10-25。確度: Apple公式仕様とBellTeamのiPad Simulator実測。

SwiftUIは通常、表示されたソフトウェアキーボードを避けて内容を配置する。背景を画面の端まで描く時は、背景にだけ`ignoresSafeArea()`を適用し、入力欄を含む内容の安全領域は保持する。

BellTeamのiPad横3列では、`ignoresSafeArea()`付き背景を会話と同じ`ZStack`の子にした時、入力欄がキーボードの入力補助領域に覆われた。背景修飾へ移しただけで入力欄が64.5pt上がり、操作可能になった。キーボード本体のaccessibility frameだけでは上側の入力補助領域を検出できなかったため、UI試験では入力欄・送信ボタンの`isHittable`と画面画像を併用する。
