# 記憶と検索の責務

現行の記憶/RAGはBellTeam内部の機能で、独立した配布パッケージではない。`package.json`の`bellteam`、`src/supervisor.mjs`の生成、`src/mcp-tools.mjs`と`src/http-server.mjs`の呼び出しが実装の境界になる。会話記録を提供するThroughlineとは別の処理である。

`src/memory-service.mjs`の`BellTeamMemory`は、Bot台帳、personal/sharedの選択、プロジェクトと保存先、SQLite接続の開閉、記憶の更新、Markdown正本を持つ。MCPとHTTPの既存入出力をそのまま使う。

`src/memory-search.mjs`は、呼び出し元が開いたSQLite接続、検索語、件数だけを受ける内部モジュールである。単語分割、FTS索引同期、順位付け、節選択、抜粋、完全一致とpartialの採否を持つ。Bot ID、台帳、配送、プロセス起動、保存先の決定は受け持たない。接続を閉じる責任も呼び出し元にある。

この分離でDB schema、索引version、BM25重み、検索順、partial上限、MarkdownとINDEX、公開APIは変えない。検索に必要な派生索引の更新は従来と同じトランザクションで行う。

単独動作は`test/memory-search.test.mjs`で検索ファイルだけを隔離し、Node標準SQLiteと人工データで確認する。BellTeamへの接続は`test/memory-search-integration.test.mjs`で実際のサービスをMCP/HTTPから使い、`test/memory-service.test.mjs`で保存と検索の契約を確認する。独立製品の公開や提供形態を追加する変更ではない。他のOSSの既存の単独導入・動作は変更しない。
