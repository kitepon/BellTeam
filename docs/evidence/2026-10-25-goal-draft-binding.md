# Keep an unfinished goal edit bound to its original conversation

A source review found that a goal editor retained unsaved text across refresh but rebuilt its save handler with the newly observed conversation binding. If the Bot's launch/thread changed meanwhile, an old draft could target the new conversation.

The editor now keeps the existing session/launch/thread binding captured when editing starts. Refresh preserves the draft text, disables saving after a binding change, and explains how to reopen editing from the current goal. Submitting the stale form sends no mutation. A newly opened editor uses the new goal and its binding.

An isolated Chromium fixture reproduced the enabled stale save before the change and verified the correction at 1100px and 390px: draft preserved, save disabled, zero stale requests, and one intentional new edit targeting the new thread. The first fixture had no HTML charset and timed out locating its Japanese refresh label; those harness logs are retained separately. The corrected fixture served UTF-8 in both runs. Native goal behavior is not inferred from this UI-only test.

Final source Node verification: 763 tests passed with zero failure/cancellation/skip. Private original logs/results are under `integrations/goals-composer-20261025/browser-goal-draft-*-clean.{json,log}` and `goal-native-full-v2.log`.
