# モデル候補の更新根拠

2026-09-05取得。現在の候補とCLIの固定版は `config/models.json` と `Dockerfile` が正本。この文書は更新時の確認記録である。

- Claude: [公式モデル設定](https://code.claude.com/docs/en/model-config)で、Fable 5.1のIDと対応するCLIの最低版、`fable`別名の解決先を確認した。[モデル仕様](https://platform.claude.com/docs/en/models/fable-5-1/overview)とも照合した。本番の旧CLIは対応前だったため、npmの公式パッケージで確認した最新版へ更新した。
- Codex: [GPT-6 Astraの公式仕様](https://developers.openai.com/api/docs/models/gpt-6-astra)と、ローカルCodexのモデルカタログでIDを確認した。表示対象の候補を一覧へ反映した。本番の旧CLIから取得した一覧にはAstraが無かったため、CLIもnpmの公式パッケージで確認した最新版へ更新した。
- Cursor: 正規の `node scripts/update-cursor-models.mjs` で再生成した。Fable 5.1は既存候補にあり、取得時点の一覧にはGPT-6が無かった。生成結果から消えた候補を反映した。
- Grok: ローカルと本番の `grok models` を確認し、両方の一覧から消えていたComposerの候補を削除した。

候補の更新は各Botに保存されたモデル設定を変更しない。

反映後の実測で、Composeのビルド引数がDockerfileの固定版を旧版で上書きしていた。重複した指定を除去し、プロジェクト正典どおりDockerfileを版の正本とした。
