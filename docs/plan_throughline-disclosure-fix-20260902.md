# Throughline引き継ぎ宣言の反復修正

## 目的

Bellの同一Grok sessionで、各応答の冒頭にThroughlineの引き継ぎ宣言が反復表示される問題を
根治し、修正版をBellTeam本番へ届ける。

## 実測した原因

- BellのAiterm session、Grok session ID、Throughline session IDはいずれも同一で、通常送信ごとの
  再起動や再引き継ぎは発生していない。
- Throughlineの初回引き継ぎコンテキストが、固定宣言を応答冒頭へ必ず出すようモデルへ命令していた。
- 初回応答に出た宣言も同じ会話履歴へ残り、後続応答と次回引き継ぎで模倣される状態だった。

## 変更範囲

1. 通常のThroughlineでは引き継ぎ案内を最初の一度だけ残し、後続応答では繰り返させない。
2. Throughline旧版がassistant本文へ付けた固定宣言だけを、次回の引き継ぎ材料から除外する。
3. BellTeamがBot単位で作るproject束縛済み補足にサイレント指定を入れる。
4. Throughlineを正式リリースし、BellTeamの公式npm package固定版を更新する。
5. 本番コンテナを更新し、Bellを一度再起動する。

ユーザー発言、保存済み会話、03:00の日次再起動条件、通常メッセージ配送経路は変更しない。

## 受入条件

- 通常の生成コンテキストは最初の一度だけ案内し、BellTeamの補足付きコンテキストには案内がない。
- assistantの旧固定宣言は除外され、その後の本文は残る。
- 同じ文を含むユーザー発言は保持される。
- Throughlineのfocused testと関連test、公開package検証が通る。
- BellTeam本番が修正版Throughlineでhealthyになり、Bellの新しいGrok sessionが起動する。

## 工程と責任

- F: Throughline契約、公開release、BellTeam本番更新。
- A: Throughline実装とfocused test、BellTeam依存版更新と関連test。
- H: なし。人手でしか取得できない観測は組み込まない。

Throughline releaseがBellTeam buildの前提なので、二つのrepoは順番に確定する。
