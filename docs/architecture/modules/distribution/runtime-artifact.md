# Runtime closure publication (slice E)

Centi owns P1 and supply to runtime P2; [runtime update contract](../runtime/runtime-updates.md) owns installation and launch selection.

## Function and data flow

| Function | Input → output | Owner/caller |
| --- | --- | --- |
| R1 publish-runtime.yml | One closed component input × native amd64/arm64 → clean Node26/glibc builder | Centi; manual main-only workflow |
| R2 package-runtime.py | Fresh official npm latest metadata → exact-version global prefix, isolated artifact/native probes → manifest-first archive and integrity/closure receipt | Centi; R1 |
| R3 provenance/release | Exact archive bytes → official main workflow attestation → updates-stamp archive and bundle | Centi; R1, runtime verifier P4 reads |
| R4 prepare-runtime-catalog.py | config/runtime-releases.json + exact catalog.json SHA → validated separate runtime-catalog.json | Centi; existing catalog publisher |
| R5 existing catalog publisher | Main catalog and separate runtime catalog → four signed assets in SAME Release | Centi; runtime P2, released installers keep reading only catalog.json |

R2 operates on disposable HOME/cache/prefix only, with repository mounted read-only and no signing credentials in the builder. The manifest records files under prefix/, read-only modes0444/0555, SHA256/bytes, and only in-prefix relative leaf links. It uses the existing runtime manifest/extraction public contract to check its own output, not the runtime owner's internal test suite. Native probes load/spawn node-pty when installed; CLI probes use disposable state. No production HOME, auth, install/migrate/self-update, current selection or running launch is touched.

R3 signs with actions/attest-build-provenance; verifier identity remains publish-runtime.yml/main/source. Assets are component-source-linux-arch.tar.gz and its .sigstore.json. Registry resolution, exact top-level npm integrity, installed dependency tree, actual Node/glibc/architecture and archive digest are retained in the CI receipt.

R4 NEVER inserts runtime rows into catalog.json. Its input is an explicit array of already-published runtime rows; normal catalog schema remains unchanged. Separate runtime-catalog.v1 binds that release's main catalog SHA. Empty input is valid and publishes no runtime targets. Old installers ignore the separate asset; no enabling-image publication ordering guard is needed. Invalid supply input fails before release creation; correct explicit inputs permit the next publication.

## Current product conditions

- Throughline: discover latest afresh, accept only0.16.56 for initial supply under Rivarin's compatibility decision; record exact integrity/closure. A future version needs product-owner concurrent compatibility acceptance, not an automatic Owner approval request.
- Aiterm: archive build/attest allowed; do not add its runtime row until Elegg/Kiro's exclusive state/tmux and stateCompatibility contract is implemented. No field/value is invented here.
- Codex/Claude Code: no extra product condition. All runtime targets apply to future launches only.

## Scope and verification

Changes reach the new builder/packer/workflow, explicit runtime release input and separate-catalog publisher, distribution provides/source map, runtime caller port, and this linked diagram. Main catalog bytes/component set, installers, job/state/consumer logic and production body are unchanged. One focused supply fixture covers tar order/file inventory/links/modes, real runtime extraction boundary and separate catalog binding. Native CI builds/probes cover both architecture outputs; existing author tests are inherited.
