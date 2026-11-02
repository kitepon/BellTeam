# Aiterm/Steerとの接点

担当：エレグ。native起動・設定・実行・観測・認証。

製品図の正本は[Aiterm/Steer設計索引](/srv/bellteam/bots/bot-c2adbe04/docs/refactor-20261102/README.md)、本体との責任・公開契約は[bellteam-boundary.md](/srv/bellteam/bots/bot-c2adbe04/docs/refactor-20261102/bellteam-boundary.md)。現在26図と未実装の提案3図を区別し、編集原本のDOTを製品側で管理する。コード変更時に必要図を製品repoへ移し、旧場所はリンクにする。内部図を複製しない。

`native`は起動/送信/観測/close/configure/goal・待機/回答、agent_auth、setup/updateと既setup exportの総称。実行と設定適用時機はキロ、登録/席実行はエピネル、認証案内はミカ、会話/履歴はN102、共通契約はトロニー。native本人性・入力・vendor/Steer内部はエレグ。未送信・結果不明・受付と完了を保ち、保存modelだけで実動を証明しない。

[接続情報](module.json) / [共通の変更手順](../../module-ownership.md)
