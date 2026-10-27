// Extra fake-Docker cases for the installer's fixed model capture; no daemon.
export const frozenComposeCases = `
case "$*" in
 'compose config --images')
   if [ -n "\${COMPOSE_FILE-}" ] && [ -f "$COMPOSE_FILE" ]; then
     exec node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1])).services.bellteam.image)' "$COMPOSE_FILE"
   fi;;
 'compose -f '*'/normal.raw.json config --images') exec "$0" compose config --images;;
 'run --pull never --rm -i --network none --read-only --entrypoint /usr/local/bin/node '*' -e '*)
   while [ "$1" != -e ]; do shift; done
   shift
   exec node -e "$@";;
 'compose --project-directory '*' -f '*'/compose.state-prepare.yaml config --format json --no-path-resolution'|\
 'compose --project-directory '*' -f '*'/compose.state-maintenance.json config --format json --no-path-resolution')
   exec node -e '
const e=process.env;
for(const name of ["BELLTEAM_STATE_PARENT","BELLTEAM_LEGACY_DATA","BELLTEAM_MAINTENANCE_BACKUP_PARENT"])
  if(e[name]==="")process.exit(42);
const prepare=process.argv[1].endsWith(".yaml"), parent=e.BELLTEAM_STATE_PARENT??"/fixture/private";
const name=prepare?"state-prepare":"state-maintenance";
console.log(JSON.stringify({services:{[name]:{image:e.BELLTEAM_SERVER_IMAGE,
  environment:{},entrypoint:["/usr/bin/env","-i"],volumes:[{type:"bind",
  source:parent+(prepare?"":"/state"),target:prepare?"/srv/bellteam-state-parent":"/srv/bellteam/state"}]}}}));
' "$5";;
 'compose config --format json')
   if [ -n "\${COMPOSE_FILE-}" ] && [ -f "$COMPOSE_FILE" ]; then cat "$COMPOSE_FILE"; exit; fi;;
esac
`
