# Existing-install matched repair adoption

This procedure adopts the Q-1 repair into an **existing standard Docker installation** whose body and bundled `module-installer` already use retained, generated JSON Compose models. It uses the existing Docker context/operator and the fixed image's bundled Node and `module-update-compose.mjs`; no Host package, helper installation, sudo rule, service or application environment is added.

The fixed image is `ghcr.io/kitepon/bellteam-server@sha256:c0ff36167dd1975f9410746131c1f9b1cd2bc7b266b550576f622a9ed1573e43`, from source `150b13837a1a996db9f6d6e390f3ffc9a1dbec8c` and formal image run `42345886341`. It contains both the common close-only repair and its matching runtime installer. A later documentation commit does not require rebuilding this image.

## Scope and cost

Use the actual live containers' Compose labels to select their corresponding saved models. Preserve the actual AI/private/state/Cursor volumes, data/home paths, extra services, ports, profile/options and saved generations. The `.env` AI volume prefix is not the actual selected generation. Only the body and installer image fields change; `container-updater`, its model/configuration and durable records stay unchanged. `x-bellteam-image-ref` remains historical installer metadata; record the new fixed reference/local image ID/source separately.

**This restarts the body once and replaces the module-installer.** Finish any active module installation before replacement: replacing its service can terminate its worker. This prerequisite concerns the installer being replaced; unrelated Bot/native work does not require a new global drain. A body restart interrupts running conversations, so arrange the existing operator's normal restart permission and timing first. Publication of this procedure does not grant that permission.

This is not a fresh-install or full `sh install.sh`/Switch procedure and does not claim their compatibility with the repair. It does not inspect, claim, close, replay or repair any historical operation, fabricate the unavailable original53d state, mint a successor, or perform a module exchange. Those actions retain their separate authorization and prerequisites.

## Capture and generate without changing running services

In the existing install directory, use the same authorized Docker context/operator as that installation. The two current services must each reference one readable generated JSON Compose model in this directory's retained generation; multi-file labels, missing saved models or a generator result differing beyond image require the concrete contract to be resolved, not a new empty installation or permission changes. Keep resolved models private: they can contain secrets.

```sh
set -eu
umask 077
install_dir=$(pwd -P)
body_cid=$(docker compose ps -q bellteam)
test -n "$body_cid"
project=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$body_cid")
test "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$body_cid")" = "$install_dir"
old_normal=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$body_cid")
installer_cid=$(docker ps -q --filter "label=com.docker.compose.project=$project" \
  --filter label=com.docker.compose.service=module-installer)
test -n "$installer_cid"
old_module=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$installer_cid")
test -f "$old_normal"
test -f "$old_module"
updater_cid=$(docker ps -q --filter "label=com.docker.compose.project=$project" \
  --filter label=com.docker.compose.service=container-updater)
test -n "$updater_cid"
updater_started=$(docker inspect --format '{{.State.StartedAt}}' "$updater_cid")
repair_dir=$(mktemp -d "$install_dir/.bellteam-repair.XXXXXX")
repair_image=ghcr.io/kitepon/bellteam-server@sha256:c0ff36167dd1975f9410746131c1f9b1cd2bc7b266b550576f622a9ed1573e43
docker pull "$repair_image"
repair_image_id=$(docker image inspect --format '{{.Id}}' "$repair_image")

# Use only Node already bundled in the fixed image; no data mounts.
docker run --pull never --rm -i --network none --read-only \
  --entrypoint /usr/local/bin/node "$repair_image" --input-type=module -e '
import { text } from "node:stream/consumers";
const normal = JSON.parse(await text(process.stdin));
normal.services.bellteam.image = process.argv[1];
console.log(JSON.stringify(normal));
' "$repair_image_id" < "$old_normal" > "$repair_dir/normal.input.json"

docker run --pull never --rm -i --network none --read-only \
  --entrypoint /usr/local/bin/node "$repair_image" \
  /app/scripts/module-update-compose.mjs \
  < "$repair_dir/normal.input.json" > "$repair_dir/generated.jsonl"

# Four complete JSON values, consumed by the same image's Node for comparison.
{ printf '['; cat "$old_normal"; printf ','; cat "$old_module"; printf ','
  sed -n '1p' "$repair_dir/generated.jsonl"; printf ','
  sed -n '2p' "$repair_dir/generated.jsonl"; printf ']'
} > "$repair_dir/comparison.json"
docker run --pull never --rm -i --network none --read-only \
  --entrypoint /usr/local/bin/node "$repair_image" --input-type=module -e '
import assert from "node:assert/strict";
import { text } from "node:stream/consumers";
const [oldNormal, oldModule, normal, backend] = JSON.parse(await text(process.stdin));
assert.equal(oldNormal.name, process.argv[2]);
assert.equal(oldModule.name, oldNormal.name);
assert.ok(backend);
for (const [old, next, service] of [[oldNormal, normal, "bellteam"], [oldModule, backend, "module-installer"]]) {
  assert.equal(next.services[service].image, process.argv[1]);
  const comparison = structuredClone(next);
  comparison.services[service].image = old.services[service].image;
  assert.deepEqual(comparison, old);
  console.log(JSON.stringify(next));
}
' "$repair_image_id" "$project" \
  < "$repair_dir/comparison.json" > "$repair_dir/checked.jsonl"
sed -n '1p' "$repair_dir/checked.jsonl" > "$repair_dir/normal.json"
sed -n '2p' "$repair_dir/checked.jsonl" > "$repair_dir/module-installer.json"
printf '%s\n' "$repair_image" "$repair_image_id" \
  150b13837a1a996db9f6d6e390f3ffc9a1dbec8c > "$repair_dir/adoption-image.txt"
docker compose --project-directory "$install_dir" -p "$project" \
  -f "$repair_dir/normal.json" config --quiet
docker compose --project-directory "$install_dir" -p "$project" \
  -f "$repair_dir/module-installer.json" config --quiet
```

These commands only pull the fixed image and prepare private models. They do not update the existing `.env`, override, saved generation, updater configuration or running services. The generated normal/backend must compare equal to their respective captured originals except for the image. Do not post these files or their contents in logs/issues. Retain the new directory while any container references it; retain the original models and volumes as before.

## Adopt once, then observe the ordinary public contact

After the existing restart permission and no-active-install prerequisite are satisfied, run in the same shell/context. The interval between the two replacements is not a matching-source availability result; wait for both before the public observation. Do not run the whole installer or `container-updater --configure` as an additional step.

```sh
docker compose --project-directory "$install_dir" -p "$project" \
  -f "$repair_dir/normal.json" up -d --no-deps --no-build --pull never \
  --wait --wait-timeout 300 bellteam
docker compose --project-directory "$install_dir" -p "$project" \
  -f "$repair_dir/module-installer.json" up -d --no-deps --no-build --pull never \
  --wait --wait-timeout 300 module-installer
test "$(docker ps -q --filter "label=com.docker.compose.project=$project" \
  --filter label=com.docker.compose.service=container-updater)" = "$updater_cid"
test "$(docker inspect --format '{{.State.StartedAt}}' "$updater_cid")" = "$updater_started"
```

Record the actual pull/adoption durations, body downtime, both new service IDs/healthy startup and the new fixed image/source separately from operator waiting. Confirm `container-updater` retains its prior ID/start time. Open the ordinary Web Update screen at the installation's existing public address and capture its normal inventory response (`GET /api/updates`), matching source/module capability and saved selection/job display. This is an affected startup/normal-reader contact, not a repeated AI/auth/module-update suite. Keep any exact failure/result for the same operation; do not silently substitute fresh storage or execute historical IDs. No actual operational duration or product PASS is claimed by this document.

Keep the old `.env` image pin identified as an old installer input; do not subsequently run the unclaimed whole installer from those inputs as if it were this repair route. A future full update has its own supported procedure and compatibility scope.
