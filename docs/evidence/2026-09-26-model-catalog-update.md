# モデルとエフォートの候補の更新根拠

2026-09-26取得。現在の候補とCLIの固定版は `config/models.json` と `Dockerfile` が正本。この文書は更新時の確認記録である。

- 形を変えた。CLIごとに、CLI全体のエフォートと、モデルごとのエフォートを持つ。設定画面のエフォートは、選んだCLIとモデルに合わせて出す。
- Claude: CLIを2.1.283へ上げた。[公式モデル設定](https://code.claude.com/docs/en/model-config)で、別名 `fable`・`opus`・`sonnet`・`haiku` と、Fable 5.1・Opus 5.5・Sonnet 5のエフォート（low〜max）を確認した。Haikuはエフォート非対応。`--effort ultracode` を実機で起動し、Aitermの設定経路でも起動できることを確かめた。
- Codex: CLIを0.157.0へ上げ、`codex debug models` の表示対象から作った。GPT-6 SolとGPT-6 Lunaが増え、GPT-5.4 miniとGPT-5.3 Codex Sparkが一覧から消えた。モデルごとのエフォートもこの一覧による。
- Grok: CLIを1.0.41へ上げた。`grok models` の一覧にgrok-4.7とgrok-4.7-build-fastが増えた。`--effort` の受付値は1.0.13・1.0.41とも low・medium・high・xhigh で、maxは無い。
- Cursor: コンテナの認証が再設置で消えていたため、オーナーがログインし直した。`cursor-agent update` で2026.09.23へ上げ、`cursor-agent models` から作った。`minimal` はAitermが稼働中の切替で選べないため除いた。

候補の更新は各Botに保存されたモデル設定を変更しない。
