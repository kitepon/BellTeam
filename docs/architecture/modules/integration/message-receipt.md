# 直接メッセージの受領入口

Owner公開契約は2026-11-06の「耐久受領とAI実行を分ける」。共通MCP/HTTP・親接続はMolly、保存/履歴はN102、AI引渡しはKiro、ready/寿命はEpi。

| 共通機能 | 入力→出力 | 保持する失敗境界 |
| --- | --- | --- |
| MCP直接送信入口 | 閉引数・fresh送信者・解決済宛先/添付→既deliverMessage | sendmessage/send_user_messageは不要なRoom一覧を取得しない。registry/本人/宛先/画像の検証は保持 |
| その他のMCP/Room操作 | 既fresh registry/Room→各担当窓口 | 既room認可/取得/失敗は変更しない |
| 耐久受領→AI | 同IDの保存結果→受領返却、未入力だけ通常ready後一回進行 | N102/Kiro/Epiの受領保存・pending・unknown非再送sourceが別途必要。Room一覧回避だけを保存/実行の成功にしない |

データフロー：`MCP→閉引数→registry.refresh→送信者存在→直接2toolは既target/画像解決→deliverMessage→耐久受領結果`。その他toolは従来のRoom refreshを経由する。`保存済同ID→受信待ち→通常ready→未入力一回の実receipt`は各所有者sourceを通して結合する。保存失敗・認可不成立・元入力unknownは成功や再送へ変えない。

本差分で受領返却型・保存schema・native再送/本番は変更しない。直接検証はRoom取得が拒否されても合法直接送信が既配送口へ一回届き、送信者不在は拒否される一接点。

## 緊急新規入力の接続

Root限定割当の実行3接点は[通常配送と未確認記録の分離](../execution/configuration-delivery.md)を正本とする。Owner通常チャット/peer→既保存→通常notify/turn→既現AI入力を、旧追跡不明だけで拒否しない。N102の唯一親writer/queued受領の組立は別の後続差分であり、この修理を待たせない。
