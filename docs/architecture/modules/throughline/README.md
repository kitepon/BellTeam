# Throughlineとの接点

担当：リヴァリン。会話記録・引継ぎの公開契約。

製品内部図の正本は[Three-layer memory model](https://github.com/kitepon/Throughline/blob/main/README.md#three-layer-memory-model)、詳細索引は[docs/00_overview.md](https://github.com/kitepon/Throughline/blob/main/docs/00_overview.md)。[担当手順と接点](/srv/bellteam/bots/bot-220e0f1b/docs/throughline-maintenance.md)へリンクし、内部図は複製しない。

`context`はhandoff-context（throughline.handoff_context.v1）、observer-check（request/result v1）、observer-read（v1/v2）、room-context（throughline.room_context.v1）をまとめた公開窓口。hook登録はinstall、診断はfactory-diagnostics。起動/配送はキロ、部屋/自主回答はN102、記憶の利用方針はビスケット、席実行/hook登録はエピネルへ接続する。

## 自主回答の変更検知と本文取得

SelfTurnsは公開`observer-check --json`で完了sourceの変化を確認し、必要な本文を既`observer-read --project <path> --wire v2 --json`で取得する。[会話側の処理・保存・停止](../conversation/observation.md)と[席実行の契約](../runtime/execution.md)を接続先の正本とする。

| 公開窓口 | 入出力 | 所有と失敗の扱い |
| --- | --- | --- |
| observer-check --json | stdinにthroughline.observer_check_request.v1のJSON＋EOF。結果はthroughline.observer_check_result.v1、request順のid/status/token | Throughlineがsourceの選択・確認値生成を所有。changed/unchangedは確認値、resync_required/errorはnull。個別SOURCE失敗はcomplete/exit0、全体ARGS/INTERNAL/CANCELLEDはstdout空・固定stderr/exit1 |
| observer-read v2 | project、独立したread cursor/through/page token → 完了turnの本文・次page・cursor/pending/resync | Throughlineが完了turnの選択と本文投影を所有。会話側が全page取得・回答append・state保存を所有し、check確認値とread cursorを混同しない |

checkは1requestにつき1..256件、符号化後UTF-8 JSONは1MiB以内。idは1..128 UTF-8 bytesで一意、projectPathは絶対pathで1..4096 bytes、afterはnull又は1..512 bytes。未知field/型/構造/上限違反は全体拒否する。projectの実在・権限/source失敗は個別error。確認値はopaqueで、製品がversion・canonical encoding・project束縛を検証する。JSON Schemaだけではbyte数・絶対path・id一意・確認値の意味検証は完結しない。

会話側はpendingを先行readして同巡checkから除外し、N0はCLIを起動しない。件数とbytesで直列分割し、結果全体のschema/id/順序/status/tokenを検証する。全page・append・原子state保存後だけcheck時の確認値を採用する。checkの失効/errorでread cursorを消さず、後続chunkの失敗でも先行成功chunkを保持する。対象集合・分割・保存・再読の判断はN102の所有で、製品内部sourceを参照しない。

checkは共通rootの既runner/base環境、readは各projectの既接続を使用する。stdinのJSON＋EOF、AbortSignal、合計16MiB上限、nonzero拒否、stdio close後の回収はruntimeの契約。今回のconsumer候補は公開check/readを使い、旧DB/WAL mtime参照と席側signature窓口を除去する差分を同時に採用する。

## 固定候補と正式供給の区別

接続確認に使った製品候補は`b1cf82f3611ddc375b36b1ecb4846f23870457eb`。[候補の公開schema](https://github.com/kitepon/Throughline/blob/b1cf82f3611ddc375b36b1ecb4846f23870457eb/docs/observer-check.schema.json)、[製品側の契約・責務](https://github.com/kitepon/Throughline/blob/b1cf82f3611ddc375b36b1ecb4846f23870457eb/docs/architecture/observer-check.md)を正本とする。schemaのSHA256は`011e261094487e70d58260508ebd99318537e4cc6de650836dfd10862270f5fa`。

2026-11-03、製品側は有限CLI計測・既runner接続・必要CIを返却した。N102はconsumerの直接39試験と、consumer→候補実binのcheck/read→既runnerによる空の人工3project接続を確認したと報告している。証跡と限界は[製品供給結果](/srv/bellteam/bots/bot-220e0f1b/work/throughline-observer-check-20261103/supply-result.json)を参照する。

上記候補と39直接試験は公開契約の不変部分として継承する。正式package 0.16.52は2026-11-03 21:29:41 JSTに公開済み。sourceは9247ae042dcc18ae4fde73e318dfd03ac9e01e9c、registry tar SHA256はac849684be7fd98ba8ea93a100aae938dd20fe5e92547761a53291f5df18a67d。候補から正式sourceへのobserver/check/read/bin/schema差分は無く、旧開発supply-resultではなく製品のregistry-source-binding.json/registry-cli-result.jsonとN102本人照合を供給結果に使う。実consumerの本番受入は未成立。BellTeamの通常main統合はモリー、公開版の供給と本番反映は既Root/製品条件に従う。

[接続情報](module.json) / [共通の変更手順](../../module-ownership.md)
