# agent-msg integration assessment

Reviewed 2026-11-21 against this personal fork, installed herdr-core 0.1.21,
agent-msg 0.2.0 source, and herdr-core upstream c7517808d64f06609e4ecf0db1757005373cc3a3.
This is a proposal, not an implemented integration or a live-delivery test report.

## Decision

Do not ship a wrapper around `hc send`. Proceed only with a bounded transport
feasibility phase. If the delivery and identity requirements below cannot be
met without changing Codex launch semantics or maintaining a substantial core
fork, leave messaging separate. A history panel alone does not meet this goal.

The integration must let a Herdr-managed Codex or Claude session exchange
journaled requests and correlated replies with independently running sessions,
without moving those sessions, restarting them, changing permissions, or
requiring the Herdr window to remain open.

## What exists

- Herdr owns terminals, process lifetime, layout, status and worker coordination.
  Existing native subagent tools and hc orchestration retain those jobs.
- agent-msg owns envelopes, exact harness/session identity, journaled delivery
  attempts, correlated replies, and its existing native/SSH transports.
- This fork's SessionStart/SessionEnd hook records `herdr.session`: harness,
  session UUID, cwd, root PID, boot ID and foreground agent process group.
  The resume mod consumes that record. A recorded label is evidence, not a
  live endpoint or authentication. It can survive a process exit or recovery.
- Both the program launcher and resume command use Codex `--no-daemon`.
  agent-msg discovers/delivers to Codex through the shared app-server daemon.
  It therefore currently misses this execution mode. Do not remove
  `--no-daemon` to make discovery appear to work.
- Herdr mods can run a CLI with argument arrays and draw custom panels. The
  app does not need a new built-in message model or SQLite access.

## Blockers established by code inspection

### Delivery is addressed to a terminal, not a session

`terminal.send` currently accepts terminal, text, force, status condition and
wait options; no expected session, process generation or label predicate.
Its input queue waits for human input and rechecks live status before paste,
but does not compare the destination against the session selected by an
external discovery pass. A preflight `get` followed by `send` has a race.
`--if idle` reduces exposure but does not identify a replacement idle agent.

A restored terminal can also have a bare shell. Never use transcript existence,
cwd, terminal name or a retained label alone to authorize a send.

### Human drafts have a bounded hold

The current input gate can release after the configured draft timeout. That
is appropriate documented hc behavior, but cannot establish a promise that
agent-msg never merges a message into an unfinished human draft. The adapter
needs an explicit fail-without-input policy when a draft remains.

### A paste receipt is not agent acceptance

The core builds paste, pause, Enter as separate steps. Terminal/process changes
can occur during delivery. A successful send or `started` status does not prove
that the intended harness accepted the envelope, and a completed turn does not
prove a correlated response. A guard at preparation time alone is insufficient
to claim end-to-end exactly-once delivery.

### Reply attribution must support non-daemon Codex

agent-msg currently attributes Codex callers using CODEX_THREAD_ID matched to a
loaded daemon thread. Adding receive delivery alone would leave a non-daemon
Codex sender unattributed, breaking reliable reply matching and asynchronous
return routing. Both sides need the same verified identity resolver.

## Proposed architecture, if feasibility passes

Implement the transport and discovery in agent-msg, independently of the UI.
Keep harness `codex` or `claude` and its session UUID as conversation identity;
Herdr is a delivery capability, not another harness. Use a machine/core ID,
terminal address and live process incarnation as local routing evidence.
Never put socket paths or executable commands in wire envelopes.

Discovery should merge native and Herdr observations of the same session.
Two live placements of one UUID must produce ambiguity, not a guessed winner.
Resolve exact identities on initial sends and again on replies. Revalidate
boot, core, process start/generation, foreground group and session registration;
reject bare shells, stale labels, subagent mismatches and exited sessions.
Use the same checks with process ancestry to attribute tools invoked inside
Herdr-managed agents. Environment values alone are claims, not identity proof.

Prefer a harness-native, session-scoped delivery endpoint if non-daemon Codex
can expose a supported one. Establish that experimentally before proposing
runtime changes. If that is unavailable, assess a minimal generic guarded
input capability in herdr-core: expected process incarnation and registration
predicate, strict no-draft delivery, and explicit outcomes around partial writes.
It must preserve core's harness-independent design. A terminal-side receiver
acknowledgement would still be needed to distinguish actual acceptance from
bytes written. Do not pretend generic PTY input provides that guarantee.

Core/API changes require maintainer agreement under the repository's rules;
this proposal does not authorize or implement them. If reliable delivery needs
a large custom runtime, stop rather than growing one for this integration.

Once one route is chosen for an attempt, do not fall back to another after an
ambiguous result. Journal before dispatch; preserve the message UUID. Known
rejection before any input is `failed`; partial writes, disconnects or a crash
after dispatch are `uncertain`; confirmed transport acceptance can be `sent`
with its exact meaning. Only `agent-msg reply` creates a correlated response.
No automatic replay of uncertain messages, including after resume. Receiver
UUID deduplication is required before any design can promise safe retries.

Keep native Claude delivery when it already reaches the exact session. Do not
route every harness through terminal input simply for uniformity. Route choice
must be explicit in diagnostics and capability-based, with no blind fallback.

Use the existing per-machine journals and configured agent-msg SSH routes for
remote delivery. Do not introduce a second SSH topology through hc in v1.
Start with local Herdr sessions; advertise remote Herdr delivery only after
separate tests establish identity and reply behavior on both machines.

## User experience after transport acceptance

A personal `agent-messages` mod supplies one panel: exact recipients with their
space/tab location, conversation history, compose/reply and “open terminal”.
Show delivery state separately from agent working/blocked status. A waiting
request is complete only on a correlated reply, not a status transition.
Disable sending for unsupported or ambiguous sessions with a concrete reason.
Messages to blocked permission/question dialogs must never use `--force`.

Invoke agent-msg with argument arrays and structured JSON. Add a versioned,
read-only change cursor/watch interface to agent-msg if needed for efficient
refresh; do not have the mod read SQLite or scrape the inspector HTML.
The mod is optional, stored separately from shipped mods, and has no role in
routing or delivery. Closing/reloading the app cannot lose messages or stop
agent-to-agent communication. GUI-originated messages use a human identity;
they must not impersonate the focused agent.

No teams service, autonomous dispatcher, transcript scanner, new socket server,
or agent spawning is needed. Keep full conversations in the existing journal;
labels contain only small identity/lifecycle records. Plugin/skill packaging
must include the adapter so CLI and bundled launchers behave consistently.

## Work sequence and release gates

1. Build an isolated transport spike with a scratch core, home and journal.
   Establish whether non-daemon Codex has a usable session-scoped endpoint;
   characterize idle/busy submission, draft behavior and acceptance evidence.
   If native delivery is unavailable, evaluate the generic runtime prerequisite
   above before implementing an adapter. No real user's running sessions.
2. Implement and test discovery plus sender attribution before UI work. Prove
   the same UUID, host and process incarnation are selected for send and reply.
3. Add transport dispatch and journal outcomes. Run real idle and busy
   Claude-to-Codex and Codex-to-Claude request/reply tests, including messages
   between Herdr and external sessions. Test async notification and --wait.
4. Add the mod only after transport gates pass. Verify selection and navigation
   on an isolated app home and ensure routing works with the app closed.
5. Add remote support only with separate two-machine acceptance evidence.

Required rejection/failure tests:

| Scenario | Required result |
| --- | --- |
| Same cwd/name, different sessions | Exact UUID wins; ambiguity rejects |
| Same UUID in two live placements | Reject; no first-match selection |
| Exit/replacement while queued or before Enter | No successful-acceptance claim; no send into replacement shell |
| Human draft remains past timeout | Fail without merging or submitting draft |
| Permission/trust/question dialog | Reject without input or force |
| Busy agent / turn ends during dispatch | One accepted envelope or explicit uncertainty; no duplicate fallback |
| Core recovery / PID reuse / changed boot | Old registration cannot authorize input |
| Resume same conversation | Fresh registration required; no automatic replay |
| Interrupted send / lost acknowledgement | Journal uncertainty; inspect before retry |
| Late reply after sender timeout | Persist and correlate without reissuing request |
| App closes or mod reloads | Transport and journal continue independently |
| Different XDG journals / stale plugin bundle | Explicit diagnostic, not apparent success |
| Payload contains newlines/control-like text | Payload stays data; no shell construction |

Unit tests can verify policy and errors; real isolated PTY and harness tests
must verify delivery. Do not use mocks as evidence that a harness accepted a
message. Record tested binary versions, message IDs, receipts and correlated
reply IDs, without publishing private conversation contents. Live inference
needs a separately authorized, bounded test run; none was performed here.

## Go / no-go

Ship only when local non-daemon Codex round trips, strict draft handling,
process/session replacement rejection, busy delivery, crash outcomes and sender
attribution are demonstrated. If any of those require unsafe fallbacks or a
large maintained fork, leave agent-msg and Herdr separate. A useful-looking
panel is not grounds to relax these gates.

## Evidence

- `defaults/programs.json`: Codex launch command.
- `defaults/mods/session-resume/plan.js`: resume command and label validation.
- `contrib/session-resume/session-hook.py`, `docs/labels.md`: registration.
- Installed `herdr-core schema`: terminal.send parameters and receipt.
- [Core input implementation](https://github.com/herdrdev/herdr-core/blob/c7517808d64f06609e4ecf0db1757005373cc3a3/crates/herdr-core/src/input.rs).
- [Core send types](https://github.com/herdrdev/herdr-core/blob/c7517808d64f06609e4ecf0db1757005373cc3a3/crates/herdr-core/src/api/types.rs).
- agent-msg `transports.py`, `identity.py`, `service.py`, `protocol.py` in the
  local `/Users/nsssayom/Dev/agent-msg` checkout.
