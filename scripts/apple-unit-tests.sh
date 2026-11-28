#!/bin/zsh
# The Apple unit run, in one call: BellBotTests on an iOS simulator.
# Ad-hoc signed (CODE_SIGN_IDENTITY=-) so the simulator app gets its entitlements (app group, keychain); CODE_SIGNING_ALLOWED=NO strips them.
# Starts the auth fixture (test/helpers/auth-ui-server.mjs) the AuthSetupOrderingTests read through BELLTEAM_AUTH_TYPED_URL and stops it at the end.
# usage: scripts/apple-unit-tests.sh [extra xcodebuild args, e.g. -only-testing:BellBotTests/ApprovalBoxLinkTests]
# env: DESTINATION (default 'platform=iOS Simulator,name=iPhone 17 Pro'), DERIVED (default a temp dir, removed at the end)
set -u
ROOT=${0:A:h:h}
DEST=${DESTINATION:-'platform=iOS Simulator,name=iPhone 17 Pro'}
T=$(mktemp -d); DD=${DERIVED:-$T/dd}
node $ROOT/test/helpers/auth-ui-server.mjs > $T/fixture.out 2>&1 &
FPID=$!
trap 'kill $FPID 2>/dev/null; rm -rf $T' EXIT
for i in {1..50}; do grep -q '"url"' $T/fixture.out 2>/dev/null && break; sleep 0.2; done
URL=$(python3 -c "import json; print(json.loads(open('$T/fixture.out').readline())['url'])") || { echo "auth fixture did not start"; cat $T/fixture.out; exit 3; }
cd $ROOT/ios/BellBot && TEST_RUNNER_BELLTEAM_AUTH_TYPED_URL=$URL xcodebuild test -project BellBot.xcodeproj -scheme BellTeam -destination "$DEST" -derivedDataPath $DD CODE_SIGN_IDENTITY=- "${@:--only-testing:BellBotTests}"
