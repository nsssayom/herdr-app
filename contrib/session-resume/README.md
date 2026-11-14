# Session resume

After a restart, each Herdr tab that was running Claude Code or Codex gets the
same session back, in its own terminal.

Herdr keeps terminals through a reboot, but a kept terminal comes back as a
plain shell: its program is never run again. Two parts, with no change to
herdr-core:

- `session-hook.py` (here), the agents' SessionStart and SessionEnd hook,
  writes one label, `herdr.session`, on the terminal the agent runs in: which
  session, in which folder, and whether it ended or was cut off.
- the `session-resume` mod reads those labels. When a kept terminal comes back
  at a bare shell, it types the resume command into it (Claude Code), or offers
  to (Codex, and anything ambiguous). This fork ships it in
  `defaults/mods/session-resume/`, as a floating block of the shipped `main`
  layout. Without the hook no terminal has the label and the mod does nothing:
  no programs run, nothing drawn.

macOS and Linux, terminals on this machine only. Python 3 (standard library) for the hook.

## Install

```sh
python3 contrib/session-resume/install.py            # says what it would change; changes nothing
python3 contrib/session-resume/install.py --apply    # does it (backs up every file it replaces)
```

It copies the hook to `~/.local/share/herdr-session-resume/` and adds one
SessionStart and one SessionEnd entry to `~/.claude/settings.json` and to
`~/.codex/hooks.json` (other hooks and settings stay as they were). Run it
again any time: it changes only what differs. `--uninstall` removes exactly
what it added. Every path has a flag (`--claude-settings`, `--codex-hooks`,
`--app-home`, `--hook-dir`, `--python`, `--home`); `--agents claude` hooks only
one agent. `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `HERDR_APP_HOME` and
`XDG_DATA_HOME` are honoured.

With this fork's Herdr that is all: its `main` layout already runs the mod
(it reports so, from the app home's `installed.json`). In a personal layout
(a clone made before this version, or your own), add the floating block below.

Then, by hand:

1. **Codex: trust the hooks.** Start `codex` and run `/hooks`; Codex skips hooks
   it hasn't been told to trust.
2. **Optional keys** (`keys.json`, `"global"`; none are bound by default):
   `"<key>": "session-resume.resume"` resumes the focused tab's session now,
   whatever state it is in; `"<key>": "session-resume.offer"` opens the dialog
   (and its setting).

Agents already running pick the hooks up at their next start.

### The official Herdr app (or a personal layout)

The official app doesn't ship the mod. `--with-mod` also copies it from this
checkout's `defaults/mods/session-resume/` into `~/.config/herdr-app/mods/`
(and `--uninstall --with-mod` removes it). It is ignored where the app ships
the mod itself, since the app would move a changed copy aside. A mod runs only
in a layout that holds it, and Herdr's own layouts are read-only, so use a
personal layout (to start from the default one:
`herdr-app do layout.clone '{"name":"main","as":"main-resume"}'`) and add to
its root node:

```json
"floating": [
  { "id": "session-resume", "content": { "mod": "session-resume" }, "edge": "bottom", "align": "end" }
]
```

It draws nothing until a session waits for you; then a small "Resume N
sessions" chip shows in the corner.

## What happens after a restart

The mod looks at every terminal on this machine that Herdr keeps in a tab. One
qualifies when its label names a session, the terminal came back (its shell has
a new process id, or the machine booted since), its own shell is in front at a
prompt, the folder and the transcript still exist, and it hasn't been tried in
this incarnation yet.

| Label state | Written when | After a restart |
|---|---|---|
| `running` | SessionStart; or the mod typed a resume | Claude: resumed. Codex: offered. |
| `lost` | Claude ended with reason `other` (a signal: shutdown, lost terminal) | as `running` |
| `exited` | Codex ended (Codex reports `other` for every end, a quit included) | offered |
| `ended` | Claude `/exit`, Ctrl+C twice, Ctrl+D, `/logout`; or the mod saw the shell come back while Herdr was open | nothing |
| `missing` | the mod typed a resume and the shell was back within 10 s | nothing |

"Offered" is one toast ("Resume N sessions?") and the chip; both open a dialog
with Resume and Dismiss for each tab. The key command resumes in any state.

Resumes go one terminal at a time, 2 seconds apart. The mod first marks the
label (`tried`) and reads the mark back 0.4 s later, going on only if its own
mark is still there, so two Herdr windows don't both type into the same
terminal (a narrower race remains: labels are last-writer-wins). Then
`hc send` types the command, and the label is rewritten for the new shell.
A terminal is tried once per incarnation (its shell's pid and the boot).

While Herdr is open the mod also watches each agent: when its terminal's own
shell is back in front, the person quit it, and the label becomes `ended`.
That is what tells a Codex quit from a shutdown. If Herdr wasn't open when a
Codex session ended, it is offered, never resumed by itself.

### The typed command

Rebuilt from the label's checked fields only; nothing is copied from the old
command line:

```sh
cd -- '<folder>' && claude --resume <uuid> [--permission-mode acceptEdits|plan|auto|dontAsk]
cd -- '<folder>' && codex resume --no-daemon <uuid>
```

The folder is POSIX single-quoted; the id must be a UUID. A session started
with permissions bypassed (`--dangerously-skip-permissions`,
`--permission-mode bypassPermissions`, Codex `--yolo`,
`--dangerously-bypass-approvals-and-sandbox`, `-s danger-full-access`) is never
resumed by itself and never resumed with the bypass: the dialog says so and
resumes it in the default mode.

## Settings

In the dialog (chip, toast, or the `session-resume.offer` key), per agent:
Resume (`auto`), Ask (`ask`) or Off (`off`). Stored as
`shared("session-resume.mode")`: one word for both agents, or
`{"claude": "auto", "codex": "ask"}` (the defaults). Off means no resumes and
no offers; the key command still works.

## What the label stores

One terminal label, `herdr.session`, compact JSON, for example:

```json
{"v":1,"agent":"claude","id":"98566e73-3b42-4953-8ef8-2c6dca1aef8a","cwd":"/Users/me/app",
 "transcript":"/Users/me/.claude/projects/-Users-me-app/98566e73-3b42-4953-8ef8-2c6dca1aef8a.jsonl",
 "mode":"acceptEdits","root":3682,"boot":"0FF8C0C1-1E9D-49DE-9BFA-2646757BB028","agent_pid":3685,
 "state":"running","why":null,"at":1794675758063,"tried":null}
```

`agent`, `id` (the session id), `cwd` (its folder), `transcript` (the path of
the agent's own session file, only checked for existence, never read), `mode`
(the permission mode from the agent's flags), `root` (the terminal's process
id), `boot` (this boot's id: macOS `kern.bootsessionuuid`, Linux `boot_id`),
`agent_pid` (the agent's process group), `state`, `why` (the end reason),
`at` (ms), `tried` (`<pid>@<boot>#<mark>`). **No prompts, messages, command
lines or environment.** The label lives in herdr-core with the terminal and
goes when the terminal is closed. `hc get <t>` shows it. The format is in
`docs/labels.md`.

## Limits

- A session is recorded at the agent's SessionStart. Codex fires it at the first
  turn, so a Codex session nobody typed into isn't recorded (there is nothing to
  resume yet). Claude Code writes its transcript with the first message, so a
  session with no message is not resumed either.
- Only the agent in front of its terminal is recorded: not one started by
  another agent's tool, a backgrounded one, a `claude -p` / `codex exec` run,
  or an agent inside tmux/screen (herdr-core sees the multiplexer in front).
- The permission mode is the one the agent started with; a mode changed later
  in the session (Shift+Tab) is not seen. Resumes never use a bypass anyway.
- Terminals on other machines are skipped. Windows is not supported.
- SessionStart waits until herdr-core sees the agent in front (it looks about
  twice a second): about 0.4 s at start, up to 1.5 s. SessionEnd takes ~0.1 s.
- If a session's transcript was deleted, the agent exits at once; the label
  becomes `missing` and a toast says so.

## Files

- `session-hook.py`: the hook (`session-hook.py claude|codex`, JSON on stdin; `--boot` prints the boot id).
- `../../defaults/mods/session-resume/`: the mod; `plan.js` holds every decision, `main.js` carries them out.
- `install.py`: install / uninstall, dry run by default.
- `test_session_hook.py`: `python3 -B -m unittest discover -s contrib/session-resume -p test_session_hook.py`
  (the hook with a fake `hc` and a real PTY; install.py against throwaway homes).
- `../../scripts/session-resume.test.ts`: `bun test scripts/session-resume.test.ts`, part of `just test`
  (plan.js, and main.js against a fake core).

Parts of the hook follow upstream Herdr's `scripts/agent_session.py` on its
`fix/durable-agent-session-capture` branch (Apache-2.0, as this repository).
