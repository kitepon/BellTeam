# Apple単発ScrollMetricsKey warningとMac 500診断の有限判断

固定入力はmain `a9eaac7`、Apple版90のmain `03ea7ee`。両者のApple製品コード差分は0。新しい試験、再build、再提出は行っていない。

## ScrollMetricsKey単発warning

判断: 修理しない。版89の測定で2回の単発warningは、発生条件の種類までは言えるが、発生元の操作は特定できない。実害は観測されていない。

観測（TF89、PID 29811、01:41:44〜02:13:44 JST）: warningは01:52:33と02:00:13の2回。Cycle detected 0、新しい`.hang` 0。60秒内3回以上の束なし。Footprintは01:53に151→171MBへ増えた後は162〜183MBで推移し、warningとの因果は未確認。2回目はload 100超の時間帯。

warningの意味: `ScrollMetricsKey`が1フレーム内に2回以上更新された。発生元の`GeometryReader`は`ConversationView.swift`の4箇所（末尾、本文全体、各行、境界の行）で、どれもレイアウトごとに値を出す。計測後の処理は`DispatchQueue.main.async`へ送っているが、これは次のキュー周であり、同じ描画フレームを越える保証はない。遅れて走る`renderedRows`や`proxy.scrollTo`の更新が同じフレームに重なれば同じwarningになる。これはコードからの推定で、再現は行っていない。

warningの記録に呼び出し元は無く、Footprint以外の操作記録も無いので、4箇所のどれが原因かは決められない。原因を特定せずに描画周期の同期などを入れると、症状を消すだけの変更になる。

再開条件: 束、Cycle、新しい`.hang`のいずれかが出たら、通常の不具合として扱う。単発warningだけでは再開しない。

## Mac 500診断 82b9 / 9f9d

判断: 版90のMacアプリは、iPhoneで実測した経路と同じコードを持つ。Macで保存された実物だけが未観測で、元の原因と回復も未確認のまま。

| 確認項目 | 結果 |
| --- | --- |
| Mac実効版 | `/Applications/BellTeam.app` 1.0.3 (90)、TestFlight Beta Distribution |
| 導入物と版90 archiveの一致 | Mach-O UUID一致。arm64 `E20B76DB-C3AE-34E3-B5C4-11DA36487A30`、x86_64 `BBD2E016-EA5F-35A8-A412-289389682C2F` |
| 導入物の中身 | 3つのheader名と`server_diagnostic_fingerprint`の文字列を含む |
| 共有コード | `BellAPI.swift`にOS分岐なし。`BellDiagnostics.swift`のOS分岐は端末種別の1箇所だけ |
| ターゲット | iOSとMac Catalystは同じターゲットの同じソース |
| 本番の実出力 | 本体担当が、実iPhone 90の通常操作の500で3値すべての保存と本体記録との一致を確認 |

証明できること: 500応答からtrace、report、POST、本体保存までの経路はMacでも同じコードで、Mac固有の分岐が無い。

証明できないこと: Macで受けた500の保存行そのもの、82b9/9f9dの元の原因、Mac画面の回復。iPhoneの実測をMacの実測として数えない。

残る観測は1つだけで、本体の保存診断を`device_type=Mac`、版`1.0.3 (90)`で読む。行があれば3行と本体記録の一致を確かめる。無ければ、現在保存されている診断では版90 Macの500を未観測とする。発生しなかったとは断定せず、元の原因と回復は未確認のまま通常処置へ返す。診断は指紋ごとに最新の標本を保存するため、行が無いことは未発生の証明にならない。新しい500は起こさない。

## .hang / Cycle

| 版 | 保存原本 | 受入条件との関係 |
| --- | --- | --- |
| 86 | `~/Library/Developer/BellTeam-evidence/2026-10-31-mac-hang/` の`.hang` 4件 | 修理前の原因調査の原本 |
| 89 | `2026-11-01-apple-89-signed/live-mem.log` | 30分測定で新`.hang` 0、Cycle 0、束0。提出条件を満たす |
| 89・90の提出後 | なし | 読取を行っていない。提出後の実測は0件であり、問題が無かったという意味ではない |

## 限界

`.hang`、Cycle、warningの読取は提出後に行っていない。版90のMacでScrollMetricsKeyが出ているかも未確認。
