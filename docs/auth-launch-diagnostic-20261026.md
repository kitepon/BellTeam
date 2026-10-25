# Claude起動前認証拒否の診断

Nativeの認証preflightが起動前に失敗しても、BellTeamはMCPのisErrorを文章だけのErrorに変換し、HTTP500の診断で理由をunknownに落としていた。

`aiterm.agent-launch-error.v1`のClaude専用3code、authentication_preflight、not_issued、session_created=falseがすべて揃った場合だけ保持する。通常agent_launchとclaude_agent aliasが対象。診断の集約を3codeで分け、Nativeが観測した起動前拒否を診断へ残す。任意message、status本文、資格、追加fieldは取り込まない。HTTP500/INTERNAL_ERROR、拒否条件、再送動作は変えない。歴史的unknownの原因や結果を後から書き換えない。

検証は修理前2fail/1passから3pass。関連65pass、完了時の全体775pass/fail・取消・skip0。型付き情報の欠落/不正時は未発行や認証原因を推定しない反例を含む。

別置きのNative060e4e184fa22de5d983439478ebdd0acb83549e候補tar SHA d6745f24c55e0909a4f2886b9b32bc299ae6bfb259bddcf9028b4587b9292d2dを使用し、隔離した人工Claude loggedIn:false→実Native通常MCP→本体実HTTP→診断まで結合。セッションは前後0、人工HTTP/Nativeを終了、状態本文は診断に出ない。最初のfixtureはUNIX socket path長で失敗した原本を残し、自席cacheの短いpathへ修正した。製品変更はない。

原本はトロニー所有 `/srv/bellteam/bots/bot-7b140b27/integrations/auth-launch-diagnostic-20261026/` のbefore.log、focused.log、full.log、native-http-probe.mjs、native-http-result.json、checkpoint.json。

このNative候補は未公開で、packageの.18表記は基底のみ。正式.18/cfd529、受入済みb3d2imageの内容と混同しない。Native独立source/OS/次版公開、Root独立source受入を経て通常統合の候補とする。実Bot・実provider・本体操作は0。
