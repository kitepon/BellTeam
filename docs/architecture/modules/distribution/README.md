# 商用配布

責任者：センチ。

配布構成・候補build・image/source受入・公開版発行とpromotion。設置/移行の実装はエピネル、本番実行はトロニー。

接続の正本は[module.json](module.json)。全体の[機能図](../../feature-map.md)と[担当・変更手順](../../module-ownership.md)から、呼出元と依存先を辿る。

## 現行図と移管工程

- [distribution-details.md](../../distribution-details.md)
- [H1 offline保存更新の配布入力](h1-offline.md)
- [Web受付の固定artifactと公式認証](web-gateway-artifact.md)
- [通知の固定artifactと公式認証](notifications-artifact.md)
- [executionの固定factory配布](execution-artifact.md)
- [usage・diagnosticsの固定配布](business-artifacts.md)
- [memoryの固定archiveとコード専用読取view](memory-artifact.md)
- [membersの固定artifactと公式認証](members-artifact.md)
- [conversationの固定artifactと公式認証](conversation-artifact.md)
- [正式Update catalogの信頼境界](update-catalog.md)

上の既存詳細図は現行実装の読取資料。複数担当が含まれる章は最初の分離で当moduleへ移し、元の章を参照リンクへ置換する。内容を二つの現行図へ複製しない。図とコードの分離完了はまだ宣言していない。

## 最初の成果

公開入出力、所有データ、実装・全caller・関連試験、他担当との接点を図で確定する。自分の内部変更が他担当の内部コードや保存データの直接変更を要求しない形へ分離する。共有入口は登録/呼出だけにして、業務処理を自分のmoduleへ移す。変更した図とコード・限定検証結果を一つの差分にする。

正式Aiterm0.63.6/source258b8aefをDockerfileで明示固定し、diagnostics v2と原要求tracked apply/reconcileのconsumerを同じ通常source/immutable imageへ結合する。既0.63.5 pinは別の履歴で修理入りとは呼ばない。受入は承認済package/version/必要runtime/同native entryの能力と既Web A-B差分接点に限定し、143runtime/旧成功群を全面再走しない。既image構成/同梱CLI契約内の版固定で図接続は不変。CLI argvから通常core scope生成を推測せず、実接続/UID/base/stdioとRootの別世代・認証条件を維持する。

image CIの空の永続領域からのinstaller検査は、GET `/api/settings`のIDをrouting/callBridge/cloudflare/diagnostics/notifications/webPushの6件・定義順で照合する。旧5件assertの修理で、全OFF・readonly・image identity等の既検査と製品の入出力・状態・接続・失敗処理は変えない。既image/installer検査契約内のため機能図の接続変更は不要。

設定保存修理の実物確認は `verify-configuration-state-image.yml` で既immutable imageを両nativeへ取得し、既C入口→readonly人工supervisor→runtimeの実UID1001/FD3-4/mount anchor→executionの人工要求publish/read/not-issued保存を有限確認する。製品コードはimageの実bytesを使い、fixture sourceとimage sourceを分けて記録する。既Web fixtureの割当・cleanupを再利用し、0700/0600・readonly・実OS終了・残資材ゼロを確認する。SDK/設定RPC・実席・過去要求回復・再buildを含まず、通常image受入はこの別工程を待たせない。公開入出力や既接続の変更は無い。

正式Throughline 0.16.54/source532670caをDockerfileで固定し、observer-check consumerと同じ通常imageへ供給する。既両arch image CIのimmutable image IDをUID1000/network none/read-onlyで起動し、実CLI版と公開 `observer-check --json` の空人工project初回changed→同token unchanged・DB生成無しを保存する。0.16.54はCodex hookの元例外をobserver待ちより先に私有記録し、event/stageと既知session/transcript参照を補う。元container例外の原因・影響はunknown、repair_success=falseを維持する。これは配布CLI入口と同imageの確認であり、実会話の認証・引継ぎや本番反映の証明ではない。既同梱CLI/候補実物照合契約内のため図接続・状態所有は不変。
usage/diagnosticsの固定入口は[runtime module-start](../runtime/module-start.md)契約で収録する。public packageはmodule-start.cとusage-start.c/diagnostics-start.cを全て含め、Dockerfileで同includeから二つの固定binaryをcompileする。root:root/0755・非setuid、追加sudo規則無し。通常image CIの既原本採取で両binaryのowner/mode/SHA-sizeを記録する。runtimeのIPC3 advanced/privateSH4/moduleEX5・UID1001は本人入口契約であり、配置成功だけでcontroller交換/実native成功にはしない。共通include又は固定wrapper更新も通常image push対象へ含め、専用buildを増やさない。
