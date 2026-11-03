# 通知専用の固定artifact・公式署名供給

配布の正本。Root通知単独更新契約v1を実装し、runtimeの通知配置/reader、usageの通知entry/状態へ接続する。通知独立更新の基盤を初回imageへ入れる工程と、その後の署名archive単独更新を分ける。実署名・実root配置・本番の成立は固定run原本で別に確認する。

```mermaid
flowchart LR
  Git[固定main / 通知entry / package-lock] --> Pack[clean Git src / prod npm ci / 全file inventory]
  Pack --> Tar[通知manifest + payload / archive SHA版ID]
  Tar --> OIDC[publish-notifications.yml / 両native / Node26 / 公式attest]
  Trust[固定通知policy / 既信頼根 / root承認3期待値] --> Verify[verify-notifications.py / 同FD / 公式gh / 完全inventory]
  OIDC --> Verify
  Verify --> Receipt[notifications.verification.v1]
  Receipt --> Writer[Epi install-notifications-release / 最後にinstallation公開]
  Writer --> Reader[Epi prepareNotificationsRelease / stateSchema1]
  Reader --> C[固定image C entry / UID1001 / 独立lock]
  C --> Child[Mika 通知entry / 唯一のpush-devices writer]
```

component=notifications、artifact/installation/verification各bellteam.notifications.*.v1、entry=payload/src/notifications-entry.mjs。runtimeはlinux/amd64又はarm64/Node26/parentProtocol1/stateSchema1。Webのschema/runtimeキー/公開CLIは不変。固定Web/通知二つの内部契約だけを使い、manifestが任意policy/entry/workflowを選ぶ入口は作らない。

archiveはmanifest.json先頭とpayload通常fileのみ。sourceCommit40hex、完全inventory各path/bytes/SHA256。通知のsrc/package/lockとclean production依存を自己完結させる。通知はWeb資材を必要条件にしない。実HOME/APNs鍵/端末/状態/envは収録しない。既archive512MiB/展開512MiB/bundle16MiB/manifest8MiB/20000file、link/越境/重複拒否を維持する。

CLIはpackage-notifications.py OUTPUT --source SHA40 --arch amd64|arm64、およびverify-notifications.py ARCHIVE BUNDLE EXPECTATION。期待JSONはroothelperが承認済archiveSha256/sourceCommit/signerCommitの3key/64・40・40hexから作る。未検証manifestから自己生成しない。署名policyはrepo kitepon/BellTeam/ID1404510084/main/SLSAv1/通知専用publish-notifications.ymlを固定。public trust rootは既config/web-gateway-trusted-root.jsonlを一か所で使う。公式ghの同FD/json名alias/秘密env不継承/証明書repoID検証を共通化し、Web署名の通知流用を拒否する。

package-serverは通知verifier/policy/共通Python、Epi roothelperとnotifications-start.cを明示収録。既src全収録に通知entry/reader/planが入る。DockerfileはCを固定/usr/local/libexec/bellteam-notifications-startへroot所有0755で収録する。setuid/新mount/任意commandは追加しない。roothelper/installer/Cの業務とlockはruntimeが所有する。Rootが採用後のstate更新と交換、Mikaが通知DTO/処理/保存、Mollyがassemblyと通常mainを持つ。

公式OIDC前に実archiveのentry/ready/閉じ方/自己完結を人工provider・隔離stateで確認する。通知A-B-A/登録保持/署名拒否/UID1001実lock/readonly/他process保持は同新sourceと実署名資材/固定imageで受け入れる。実APNs送信/Host/本番を人工providerで代用済みとしない。旧全成功群や既署名の再発行をgateにしない。
