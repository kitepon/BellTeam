# Aitermへの画像添付とBellTeamの画像配送

## 目的

BellTeamからどのハーネスのBotへも画像を届ける。ハーネスごとの添付の癖はAitermの一箇所へ閉じ込め、BellTeamはAitermへ画像を渡すだけにする（オーナー裁定 2026-09-04「方針はB。全ハーネスに対してAitermに画像を渡せるようにしろ」）。

## 原因

- Aitermには画像を渡す入口が無かった。`pty_send`・`agent_launch`・`agent_steer`は文字列だけを受けていた。
- BellTeamは画像パスを`force:true`の生打鍵で先送りしてから本文を配送していた。Grokには通ったが、AitermはClaude agent sessionへの生打鍵を拒否するため、Claude宛の画像配送は一度も成功していなかった（2026-09-04にチャイム宛2件が失敗）。

## 実測（2026-09-04）

Claude Code・Codex・Grok・Cursorの4ハーネスに、本文へ画像の絶対パスを書いただけの初手プロンプトを送ったところ、全員が自分のfile読取toolで開き、赤青の試験画像の左右の色を正しく答えた。入力欄への先打鍵は不要。

## 変更範囲

- Aiterm: `pty_send`（agent dispatch）・`agent_steer`・`agent_launch`に`image`（絶対パスの配列）を追加。本文末尾へ添付行を付け、不正なpathは送信前にtyped errorで拒否する。通常PTY送信とforce送信では指定できない。
- BellTeam: 画像パスの先打鍵と本文への`[BellTeam image path=...]`付記をやめ、`image`引数へ渡す。Dockerfileの固定版を新版へ上げて本番へ反映する。

## 非目標

- 画像本体の転送（クリップボード・base64）。パスで足りる。
- Bot側の画像保存・アバター生成の変更。
- 配送失敗の可視化と経過時間表示（別件として保留中）。

## 既知の罠

- Claude agent sessionへ`force:true`で送るとAitermが拒否する（0.15.0から）。
- Claude Codeは新しいcwdで信頼確認ダイアログを出し、初手プロンプトが送れない。試験は信頼済みフォルダで行う。

## 実装順

1. Aitermに`attachImages`と`image`引数を実装し、focused testを通す。
2. Aitermを公開する（`npm run release -- 0.30.0`）。
3. BellTeamの配送を`image`引数へ切り替え、focused testを通す。
4. Dockerfileを新版へ上げて本番へ反映する。
5. 本番でClaude宛とGrok宛に画像を送り、返答で画像の内容が読めていることを確認する。

## 受入条件

- 4ハーネスの席へ`image`付きで送ると、AIが画像の内容を答える。
- BellTeamのコードにharness別の画像手順が残らない。
- 本番のチャイム（Claude）とベル（Grok）が画像付きメッセージを受け取り、内容を答える。

## 進め方

Aitermの公開版をBellTeamが使うため、二つのリポジトリは直列に変更する。書込みの委譲と並列実装は行わない。

## 実測結果（2026-09-04）

- Aiterm 0.30.0を公開し、BellTeam本番へ反映した。npmは`publish`受理から実際に版が現れるまで10分かかり（npmからは「処理中、数分かかる」の通知）、Registry登録workflowは10分の待ち上限で一度失敗した。npmに載った後に再実行した。
- 本番でチャイム（Claude）とベル（Grok）へ赤青の試験画像を`image`付きで送り、両者とも「左半分が赤、右半分が青」と正しく答えた。配送記録はどちらも成功、エラーログなし。
- BellTeamのコードからharness別の画像手順（パスの先打鍵・本文へのパス付記）は消えた。
