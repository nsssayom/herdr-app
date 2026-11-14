# Shared state in labels

Herdr clients (the desktop app, the phone app, a terminal UI) share two
things through herdr-core terminal labels: which agents a person has seen,
and which are pinned. Look at an agent on one client and it stops being
"done" on all of them; pin it on one and it's pinned everywhere. An optional
agent hook also records there which agent session each terminal runs, so a
client can resume it after a restart.

Labels live on the terminal, so this state ends with it. Every client
already gets them: `events.subscribe` snapshots carry `labels` and `turn`,
and each `labels` event carries the whole map. Remote terminals
(`mac/t7`) work the same way.

Clients that don't know these labels keep working: everything here is
optional, and a missing label falls back to what the client did before.

## `herdr.seen=<turn>`: the last turn a person looked at

`turn` is core's counter: it goes up each time the terminal stops working.

Showing an agent:

1. `blocked` or `error`: needs you.
2. `working`: working.
3. Otherwise (`idle`, `done`, ...): **done** when `turn > herdr.seen`,
   else **idle**.

With no `herdr.seen` label, use your own seen rules for that terminal.
A missing label is not `0`.

Writing it:

- When a person is looking at an agent, write `herdr.seen=<turn>`. Write
  only to raise it, and also when it's missing (so terminals started
  elsewhere join).
- "Looking" means really in front of someone: the window or app in the
  foreground and that agent drawn on screen (a peek or a floating view
  counts; a pane covered by another terminal doesn't). A screen left on in an empty room
  shouldn't clear everyone's "done".
- Write once per turn while it stays on screen, not on every update: then
  a "mark unread" from another client isn't overruled by a screen nobody
  watches. Looking again later raises it again.
- A turn ends with a `status` event first, then a `turn` event. Decide on
  the `turn` event.
- Mark unread is the one lower write: `herdr.seen=<turn - 1>`. At turn 0
  nothing has finished yet, so there is nothing to mark.
- A terminal a client starts gets `herdr.seen=0`.

Last writer wins. Turn counts observed progress: an agent that goes from
blocked to idle without working again keeps its turn.

How long a done row stays in place while you look at it is up to each
client.

## `herdr.pinned=1`: pinned

Present and non-empty: pinned. Unpin by writing it empty
(`herdr.pinned=`), which removes it. Pinned agents go first, in the
client's usual order.

In the desktop app, mods pin with `terminal.pin {terminal, pinned}` and
read `pinned` from `agents()`; they never write the label themselves.

## `herdr.session=<json>`: the agent session a terminal runs

Written by the optional hook `contrib/session-resume/session-hook.py`, which
Claude Code and Codex run at SessionStart and SessionEnd, on the terminal the
agent runs in (`HC_TERMINAL_ID`, on its own core `HC_TERMINAL_SOCKET`). Read
by the desktop app's `session-resume` mod, which brings the session back when
a kept terminal returns as a shell after a reboot or a lost core. Without the
hook the label never exists and the mod does nothing.

Compact JSON, version 1:

```json
{"v":1,"agent":"claude","id":"<uuid>","cwd":"/abs","transcript":"/abs/x.jsonl",
 "mode":"acceptEdits","root":3682,"boot":"<boot id>","agent_pid":3685,
 "state":"running","why":null,"at":1794675758063,"tried":null}
```

- `agent`: `claude` or `codex`. `id`: the session id, a lowercase UUID.
  `cwd`: its folder. `transcript`: the agent's own session file (checked for
  existence, never read), or null. `mode`: the permission mode from the
  agent's flags, or null (`bypassPermissions` when they bypassed checks).
- `root`: the terminal's `pid` when the session started; `boot`: that boot's
  id (macOS `kern.bootsessionuuid`, Linux `/proc/sys/kernel/random/boot_id`).
  A terminal whose `pid` or boot differs came back without its program.
  `agent_pid`: the agent's process group, or null when not known yet.
- `state`: `running` (started, or a resume was typed), `lost` (Claude ended
  with reason `other`: a signal, such as a shutdown), `exited` (Codex ended;
  it reports `other` for a quit too), `ended` (a person quit, or a client saw
  the shell come back while it watched), `missing` (a typed resume exited at
  once). `why`: the end reason. `at`: ms since the epoch.
- `tried`: `<pid>@<boot>#<mark>`: a client claimed a resume of this
  incarnation (`#dismissed`: the person declined it). Write it, read it back,
  and type only if your mark is still there.

A SessionEnd changes the label only if its `id` is the session there, so a
late hook of an older session can't overwrite a newer one. A client types a
command rebuilt from these fields alone: `cd -- '<cwd>' && claude --resume
<id>`, adding `--permission-mode` only for `acceptEdits`, `plan`, `auto` or
`dontAsk`; or `cd -- '<cwd>' && codex resume --no-daemon <id>`. Never a bypass.
No prompts, messages, command lines or environment are stored.

## Adding more

Labels suit small values that change at human speed. Use the `herdr.`
prefix. Bigger or app-wide state belongs in documents (`doc.get`,
`doc.set`), and state for one device stays on that device.
