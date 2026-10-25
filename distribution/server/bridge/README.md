# Independent call-bridge service

This optional directory packages the Bridge owner's image. It does not build or modify Bridge, and it works without a BellTeam service or Bot database. Docker Engine and Compose are the only host prerequisites. The existing BellTeam `compose.yaml` and `install.sh` continue to work by themselves.

Keep this directory as `bridge/` inside an installation directory. For a Bridge-only installation, that parent directory does not need BellTeam files. Copy `bridge.env.example` to `bridge.env`, set `CALL_BRIDGE_IMAGE` to the Bridge owner's public reference, and supply your own `CALL_BRIDGE_TOKEN`. Alternatively, put your existing token registry in `runtime/call-bridge/auth/tokens.json` and set `CALL_BRIDGE_TOKENS_FILE=/run/call-bridge/tokens.json`. Authentication values are not generated or shipped here.

For a published Docker-load archive, verify its SHA256SUMS, run `docker load -i ARCHIVE`, set `CALL_BRIDGE_IMAGE` to the image name recorded by the Bridge release, set `CALL_BRIDGE_PULL_POLICY=never`, and use `sh bridge/install.sh --no-pull`. The archive SHA256, Docker image ID and any registry digest are separate identities.

Run `sh bridge/install.sh` from the parent directory. The installer pulls and starts only `call-bridge`; it does not start BellTeam. Existing `/health`, `/mcp`, port 18910 and the `grokbot-bridge` image command remain unchanged. The published port defaults to loopback; change `CALL_BRIDGE_BIND_IP` and `CALL_BRIDGE_PUBLISHED_PORT` for your installation. Existing Bridge directory configuration can be set in `bridge.env` without BellTeam.

The entire SQLite directory, including DB/WAL/SHM, is kept under `runtime/call-bridge/data`. Authentication is mounted as a read-only directory so replacement of a token file remains visible. The runtime user is the image's user. The installer initializes ownership only for a newly created data directory; changing the user of an existing installation needs its own migration plan.

Update with `sh bridge/install.sh --image PUBLIC_REFERENCE`. A previously accepted image can be selected with `sh bridge/install.sh --image OLD_REFERENCE --no-pull`. The selected reference and previous reference are stored in `runtime/call-bridge/{image,previous-image}.ref`. Updates and rollback recreate only the Bridge service and retain current data. Never restore an old DB over newer calls as a normal image rollback, and do not remove these runtime directories or use `down --volumes` to update.

## Optional BellTeam combination

First prepare BellTeam with its existing installer. Run `sh bridge/install.sh --with-bellteam` to start Bridge on the same Compose project/network and prepare only the dedicated socket directory. This command does not recreate BellTeam or update its CLI tools.

To apply the optional BellTeam connection, use the same Compose project name and the same three files:

```sh
set --
if [ -f .env ]; then set -- --env-file .env; fi
docker compose --project-directory . "$@" --env-file bridge/bridge.env \
  -f compose.yaml -f bridge/compose.yaml -f bridge/compose.bellteam.yaml \
  up -d --no-deps --pull never bellteam
```

This last command recreates BellTeam with the optional connection. Perform it when existing work can be interrupted. It does not pull a new server image. Enable Calls in BellTeam settings with URL `http://call-bridge:18910/mcp` and your Bridge token. Saved BellTeam settings remain authoritative; the environment URL only seeds an unset installation.

The combination preserves your existing `CALL_BRIDGE_ALLOWED_HOSTS` and appends `call-bridge:18910`. When no custom list is set, the existing loopback values `127.0.0.1:*,localhost:*` are retained. Existing BellTeam `.env` values are read first, with the explicitly supplied Bridge settings layered after them. When an Origin-bearing client is used, set its actual Origin in the existing `CALL_BRIDGE_ALLOWED_ORIGINS` setting.

Only `runtime/data/shared/sockets/call-bridge` is shared with Bridge, read-only, for the existing BellTeam socket contract. Bridge never receives BellTeam's entire HOME, data, CLI authentication or Bot registry. Neither service has `depends_on`; each can run, stop and update independently. Removing the optional connection does not remove either service's saved data.

The Bridge source, image revision, architecture support, authentication schema and DB compatibility belong to its product owner. Check that product's release notes before selecting a new reference. Distribution verification records native execution separately from manifest inspection; these files alone do not claim macOS, Windows or ARM execution.
