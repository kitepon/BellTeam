# Throughline引き継ぎ案内の反復修正

## 原因

BellTeamの通常配送ごとにThroughlineが再実行されたのではない。同じAiterm session、Grok session、
Throughline sessionのまま、初回引き継ぎ文脈に含まれていた「応答冒頭で必ず宣言する」という命令と、
その命令から生成されたassistant本文をGrokが後続応答でも模倣していた。

## 修正

- 通常Throughlineでは、引き継ぎ案内を最初の応答だけに限定した。
- project束縛済み補足の`handoffDisclosure: silent`で、BellTeamだけ案内を省略できるようにした。
- Throughline旧版がassistant本文へ付けた固定宣言だけを次回引き継ぎ材料から除外した。
- ユーザーが同じ文を引用した内容、宣言後の本文、保存済み原会話は変更していない。

## 検証

```yaml
throughline:
  version: 0.10.13
  commit: 6ba600fa4c131bec654e036e95d2948fd5d9845d
  release: https://github.com/kitepon/Throughline/releases/tag/v0.10.13
  npm_shasum: c58d55983c116f9db15ff5cfb937aef35430b875
  ci_run: 33570313557
  ci_platforms: [macos, linux, windows]
  focused_tests: 31/31
  full_tests: 827/827
  normal_context_visible_once_directive: present

bellteam:
  local_product_commit: f2caf6f
  production_product_commit: bf64102
  tests: 88/88
  image: sha256:7b089cbbbd8cbd82c3a7726066722a6e7aa2f361e4e42b9a8c41757f37c6789d
  production_throughline: 0.10.13
  supplement_handoff_disclosure: silent
  bell_grok_session: 08429ad2-cc33-413e-a3c2-5d9137a4c2cf
  bell_online: true
  public_health: ok
  generated_context_visible_once_directive: absent
  post_report_generated_disclosure_occurrences: 0
```

BellTeam用の生成文脈には、ユーザーが問題文を引用した1件だけが残る。これはユーザー発言を保持する
受入条件どおりであり、表示を命じる指示と、過去のassistant固定宣言は含まれない。
