# Ordered delivery, desired settings and failure visibility

Owner: Kiro. Root/Owner final decision, 2026-11-07. The authoritative configuration flow/state diagram is [configuration-requests](configuration-requests.md). This supersedes configuration/session-outcome fences and conditional ready reuse; no unknown command outcome can block a subsequent dispatch or operator operation.

Function/DFD: registered delivery job (original groupId) → member/access/stop checks → ordered presence observation → launch desired or fresh-UUID apply if needed → native send. Intent/receipt is append-only audit, not admission state. Every new input observes again. Known failures keep their original ID and failed callback/history/UI reason. Accepted input with unknown completion retains the existing tracking marker; no automatic replay.

The failure status callback must finish before acceptance rejection, so its conversation lifetime remains valid while persisting failure. A bounded failed queue projection retains only the latest failed delivery per Bot, outside active jobs/idle checks, and clears on the next accepted job. It transfers across hot execution handoff; durable history remains with conversation. One registered diagnostic contains only fixed stage code and bot/delivery identifiers; no arbitrary native message/credentials.

Conversation owns closed delivery_error code projection and persisted direct/peer/room history; Web owns plain Japanese rendering. Failed queue rows never say processing or offer a stop button. Current completion-tracking unknown and a proven refused input remain distinct.

Explicit restart/stop retain ordinary stop/member ordering, close/launch mechanics and history, without requireSessionKnown or uncertainty gates. No forced retirement, native proof certificate, settings getter, startup reconcile, issued marker or new persistent queue is introduced.

## Restart rejection diagnostic caller

Function: cold initialize's existing reconnect rejection → existing SERVER_TURN_TRACKING_FAILED/conversation sink. Closed diagnostic JSON contains stage=restart_resume, fixed RESTART_RESUME_UNAVAILABLE, selected botId/sessionId and only allowlisted exception code; no message/stack/body/config. Existing activity selection/resume-only flag/admission remain unchanged. DFD: consumed actual prior-active reference → same resume caller → rejected promise → supported diagnostics.record → existing retained diagnostic. Recording failure stays best-effort; it never enables replay/fresh launch. This corrects an unregistered diagnostic code/module, not the native killed-working admission contract.

## Deferred settings and active-turn input

Function map: same-harness non-reset reconfigure waits for existing activity outside the input ordering barrier. Its tracked Promise carries `deferredSettings=true`; ordinary submit does not await that Promise. Once activity completes, the actual configuration joins the same per-Bot dispatch acceptance chain as input. Restart/reset/stop operations retain the existing full barrier.

DFD: desired settings → deferred tracked operation → activity completion → per-Bot dispatch chain → bound configuration apply. Original input → registered job → skip deferred-settings barrier → same dispatch chain → presence observation → existing launch input. While that deferred operation exists, a present launch receives input without a duplicate desired-setting apply; absent launch still uses normal desired launch. The chain serializes actual apply against send, including a turn completing while send is in flight. The full configure Promise remains tracked for shutdown/exchange and application completion. No ID replacement, replay, early completion or new public queue projection.
