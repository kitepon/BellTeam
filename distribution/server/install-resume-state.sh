#!/bin/sh
# Sourced by the installer; Docker/Compose inputs are already frozen.
resume_prepare() {
  {
    printf '[';cat "$saved/normal.json";printf ','
    if [ -f "$saved/previous-normal.json" ]; then cat "$saved/previous-normal.json";else printf null;fi
    printf ','
    if [ -f "$saved/previous-runtime.json" ]; then cat "$saved/previous-runtime.json";else printf null;fi
    printf ','
    if [ -n "${BELLTEAM_RESUME_TARGETS_FILE:-}" ]; then
      [ -f "$BELLTEAM_RESUME_TARGETS_FILE" ] && [ ! -L "$BELLTEAM_RESUME_TARGETS_FILE" ] || return 1
      [ "$(wc -c < "$BELLTEAM_RESUME_TARGETS_FILE")" -le 65536 ] || return 1
      cat "$BELLTEAM_RESUME_TARGETS_FILE"
    else printf null;fi
    printf ']'
  } | docker run --pull never --rm -i --network none --read-only --user 1001:1001 \
    --entrypoint /usr/local/bin/node "$image" /app/src/resume-install-plan.mjs "$saved" > "$staging/resume-models.jsonl"
  sed -n '1p' "$staging/resume-models.jsonl" > "$saved/resume-plan.json"
  sed -n '2p' "$staging/resume-models.jsonl" > "$saved/normal.json"
  cat "$saved/resume-plan.json" | docker run --pull never --rm -i --network none --read-only \
    --entrypoint /usr/local/bin/node "$image" -e 'const p=JSON.parse(require("fs").readFileSync(0));for(const k of ["state_volume","source_volume","home","generation"])console.log(p[k]);console.log(p.targets.length)' > "$staging/resume-fields"
  resume_volume=$(sed -n '1p' "$staging/resume-fields")
  resume_source=$(sed -n '2p' "$staging/resume-fields")
  resume_home=$(sed -n '3p' "$staging/resume-fields")
  resume_generation=$(sed -n '4p' "$staging/resume-fields")
  resume_count=$(sed -n '5p' "$staging/resume-fields")
  docker run --pull never --rm --network none --read-only --entrypoint /usr/local/bin/node "$image" -e '
const fs=require("fs"),p="/usr/local/lib/node_modules/aiterm-mcp/";if(require(p+"package.json").bin?.["aiterm-resume-state"]!=="dist/resume-state-cli.js"||!fs.statSync(p+"dist/resume-state-cli.js").isFile())process.exit(1)'
  if ! docker volume inspect "$resume_volume" >/dev/null 2>&1; then
    docker volume create --driver local --label "com.docker.compose.project=$project" --label bellteam.role=aiterm-state "$resume_volume" >/dev/null
  fi
  metadata=$(docker volume inspect --format '{{.Name}} {{.Driver}} {{len .Options}} {{index .Labels "com.docker.compose.project"}} {{index .Labels "bellteam.role"}}' "$resume_volume")
  [ "$metadata" = "$resume_volume local 0 $project aiterm-state" ] || return 1
  if [ "$resume_count" -ne 0 ]; then
    for path in compose.aiterm-checkpoint.yaml;do
      docker run --pull never --rm --network none --read-only --entrypoint /bin/cat "$image" "/app/$path" > "$staging/checkpoint.yaml"
    done
    BELLTEAM_AITERM_STATE_VOLUME=$resume_source BELLTEAM_AITERM_CHECKPOINT_HOME=$resume_home \
      docker compose -f "$staging/checkpoint.yaml" config --format json > "$saved/checkpoint.raw.json"
    cat "$saved/checkpoint.raw.json" | docker run --pull never --rm -i --network none --read-only \
      --entrypoint /usr/local/bin/node "$image" -e 'const fs=require("fs"),p=JSON.parse(fs.readFileSync(0,"utf8").replaceAll("$$","$"));p.services["aiterm-checkpoint"].image=process.argv[1];console.log(JSON.stringify(p,(_k,v)=>typeof v==="string"?v.replaceAll("$",()=>"$$"):v))' "$image" > "$saved/checkpoint.json"
    source_image=$(cat "$saved/resume-plan.json" | docker run --pull never --rm -i --network none --read-only \
      --entrypoint /usr/local/bin/node "$image" -e 'console.log(JSON.parse(require("fs").readFileSync(0)).source_image)')
    for candidate in "$source_image";do
      docker run --pull never --rm --network none --read-only --entrypoint /usr/local/bin/node "$candidate" \
        -e 'if(!require("fs").statSync("/usr/local/lib/node_modules/aiterm-mcp/dist/resume-state-cli.js").isFile())process.exit(1)'
    done
  fi
}

resume_initialize() {
  docker run --pull never --rm --network none --read-only --user 0:0 --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
    --security-opt no-new-privileges:true --mount "type=volume,source=$resume_volume,target=/resume-state,volume-nocopy" --entrypoint /usr/local/bin/node "$image" -e '
const fs=require("fs"),p="/resume-state";if(fs.readdirSync(p).length)process.exit(1);fs.chmodSync(p,0o700);fs.chownSync(p,1000,1000)'
}

resume_stopped() {
  [ "$resume_count" -ne 0 ] || return 0
  proof=$(docker container inspect --format '{{.Id}} {{.Image}} {{.State.Pid}} {{.State.Running}} {{.State.Restarting}} {{.HostConfig.RestartPolicy.Name}}' "$stopped_container")
  printf '%s\n' "$proof" | docker run --pull never --rm -i --network none --read-only \
    --mount "type=bind,source=$saved,target=/resume-plan,readonly" --entrypoint /usr/local/bin/node "$image" -e '
const fs=require("fs"),p=JSON.parse(fs.readFileSync("/resume-plan/resume-plan.json")),s=fs.readFileSync(0,"utf8").trim();
if(s!==`${p.source_container} ${p.source_image} 0 false false no`)process.exit(1);
console.log(JSON.stringify({source_container:p.source_container,source_image:p.source_image,source_volume:p.source_volume,stopped:true,restart_policy:"no"}))' > "$saved/stopped-runtime.json"
}

resume_store() {
  docker compose --project-directory "$PWD" -f "$saved/compose.state-maintenance.json" -p "$project" \
    run --pull never --rm --no-deps -T --user 1001:1001 --entrypoint /usr/bin/flock \
    state-maintenance -x -n -E 75 /srv/bellteam-private /usr/local/bin/node /app/src/run-resume-store.mjs "$@"
}

resume_capture() {
  [ "$resume_count" -ne 0 ] || return 0
  [ -s "$saved/stopped-runtime.json" ] || return 1
  cat "$saved/resume-plan.json" | docker run --pull never --rm -i --network none --read-only \
    --entrypoint /usr/local/bin/node "$image" -e 'const p=JSON.parse(require("fs").readFileSync(0));for(const t of p.targets){console.log(t.session_id);console.log(t.launch_id)}' > "$staging/resume-targets"
  while IFS= read -r session && IFS= read -r launch;do
    mkfifo -m 600 "$staging/resume-bundle.pipe" "$staging/resume-ready.pipe"
    resume_store stage "$resume_generation" "$session" "$launch" < "$staging/resume-bundle.pipe" > "$staging/resume-ready.pipe" &
    resume_receiver_pid=$!
    exec 3> "$staging/resume-bundle.pipe"
    if IFS= read -r ready < "$staging/resume-ready.pipe" && [ "$ready" = READY ];then :;else
      exec 3>&-;wait "$resume_receiver_pid" || :;resume_receiver_pid=
      rm "$staging/resume-bundle.pipe" "$staging/resume-ready.pipe"
      return 1
    fi
    mkfifo -m 600 "$staging/resume-receipt.pipe"
    head -c 513 < "$staging/resume-receipt.pipe" > "$staging/resume-receipt" &
    resume_receipt_pid=$!
    # Start reading source only after the receiver holds existing startup admission.
    producer_result=0
    docker compose -f "$saved/checkpoint.json" -p "$project" run --pull never --rm --no-deps -T \
      aiterm-checkpoint checkpoint --session "$session" --launch "$launch" >&3 2> "$staging/resume-receipt.pipe" &
    resume_producer_pid=$!
    wait "$resume_producer_pid" || producer_result=$?
    resume_producer_pid=
    exec 3>&-
    receiver_result=0;wait "$resume_receiver_pid" || receiver_result=$?;resume_receiver_pid=
    wait "$resume_receipt_pid";resume_receipt_pid=
    rm "$staging/resume-bundle.pipe" "$staging/resume-ready.pipe" "$staging/resume-receipt.pipe"
    [ "$producer_result" -eq 0 ] && [ "$receiver_result" -eq 0 ] || return 1
    [ "$(wc -c < "$staging/resume-receipt")" -le 512 ] || return 1
    resume_store finish "$resume_generation" "$session" "$launch" < "$staging/resume-receipt"
  done < "$staging/resume-targets"
  resume_store generation "$resume_generation" < "$saved/resume-plan.json"
}
