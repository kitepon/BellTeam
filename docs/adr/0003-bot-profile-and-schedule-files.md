# ADR 0003: Botプロフィールと予定をプロジェクト単位で所有する

## Status

Accepted — 2026-08-31

## Context

BellTeamには固定された二つのBotしかなく、Bot追加、人格や役割の変更、自動実行を扱えなかった。Bot自身がMCPから設定を変更し、コンテナ再起動後も内容を保つ必要がある。

## Decision

- Botプロフィールは`/srv/bellteam/bots/<bot-id>/bot.json`へ保存する。
- 自動実行予定は`/srv/bellteam/bots/<bot-id>/schedule.json`へ保存し、Botごとに一ファイルとする。
- `config/bots.json`は既存Botを初回作成するseedとして使う。
- 一回実行はISO日時、反復実行はcron式とIANA timezoneで表す。
- BellTeam内のschedulerが期限を判定し、既存のtmux配達経路から対象Botへ指示する。
- 停止中に過ぎた反復予定は起動後に一回実行し、過去の回数分は再生しない。
- Web UIとMCPは同じプロフィール・予定ファイルを操作する。
- Bot削除は今回の契約へ含めない。

## Verification

- Bot追加とプロフィール再読込
- Botごとの予定ファイルとcron式検証
- 一回予定の期限実行と二重実行防止
- MCPによる自己変更と予定管理
- Web APIによる追加、編集、予定追加、予定削除
- モバイル幅でのBot追加・編集・予定登録
