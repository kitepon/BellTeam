# 通常の新規配送と未確認記録の分離

常設所有はキロ。2026-11-06 Root裁定によりモリーが新規submitのoccupation拒否、conversationDelivery無しcallback拒否、requireDeliveryKnownの配送転用だけ緊急修理する。

| 機能 | 入出力・保持する境界 |
| --- | --- |
| 新規Owner/peer入力 | 既submit→認可/本人/停止/通常native確認→同新規入力一回。旧jobの世代/unknown・session変更の未確認記録だけで拒否しない |
| callback | conversationDeliveryありは既同opaqueとcallback所有を厳守。無しは親callerの通常callbackを通す |
| 旧job/観測/継続 | 旧unknown/退役記録を保持。旧assertConversationOccupationはwatch/旧継続用に保持し、本文の複製再入力はしない |
| session変更 | requireSessionKnown/configurationFenceを保持。新規配送可能をwake/restart/reconfigure/close成功へ補完しない |
| 明示停止・認可 | stop version/全体停止/本人/lease/アクセス拒否を保持 |

DFD: `新規Owner/peer→submit→設定操作の終端順序→通常認可/stop/本人→dispatchInOrder→既sessionへのpty_send一回→実accepted/実completion`。`旧unknown/世代/変更不明→元記録保持`は新規入力の拒否へ接続しない。`明示session変更→requireSessionKnown→既変更`と`旧watch/継続→occupation guard`は別のまま。

ensureは既session実在なら通常配送を続け、席不在のwakeはstrict。memberOperation/awaitUnboundAdmissionは本人・lease・停止世代を保持。新規dispatchにも認可・停止検査を渡す。保存失敗の偽受領や例外の握り潰しは追加しない。

最小検証は既未確認jobとsession変更記録を保持した新規Owner/peer一回入力、通常callback、明示停止/認可と変更操作の拒否。実席適用は別判定で、AI停止/restart/quietを本修理の手段にしない。
