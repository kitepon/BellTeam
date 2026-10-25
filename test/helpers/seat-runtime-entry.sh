#!/bin/bash
set -eu
mkdir -p /run/bellteam-server /srv/bellteam/state /srv/bellteam/bots /srv/bellteam/shared /home/bell/.local/bin
chown 1000:1000 /srv/bellteam /srv/bellteam/bots /srv/bellteam/shared /home/bell /home/bell/.local /home/bell/.local/bin
chown 1001:1001 /run/bellteam-server /srv/bellteam/state
cat > /home/bell/.local/bin/git <<'JS'
#!/usr/local/bin/node
const fs = require('node:fs')
const cp = require('node:child_process')
fs.writeFileSync('.synthetic-git-identity.json', JSON.stringify({
  uid: process.getuid(), serverCanaryPresent: Object.hasOwn(process.env, 'BELLTEAM_SYNTHETIC_SERVER_SECRET'),
}))
const result = cp.spawnSync('/usr/bin/git', process.argv.slice(2), { stdio: 'inherit' })
process.exit(result.status ?? 1)
JS
chmod 0755 /home/bell/.local/bin/git
exec setpriv --reuid=1001 --regid=1001 --clear-groups /usr/local/bin/node /app/test/helpers/seat-runtime-boundary.mjs
