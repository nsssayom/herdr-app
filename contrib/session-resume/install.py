#!/usr/bin/env python3
"""Install (or uninstall) Herdr session resume for Claude Code and Codex.

DRY RUN BY DEFAULT: it says what it would change and changes nothing.
Pass --apply to write. Every file it would replace is first copied to a
timestamped backup. Running it again changes nothing (idempotent).

What it does with --apply:
  1. copies session-hook.py to the hook folder
     (default: ${XDG_DATA_HOME:-~/.local/share}/herdr-session-resume/)
  2. adds one SessionStart and one SessionEnd hook entry running it to
     Claude Code's settings.json (default: ${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json)
     and Codex's hooks.json (default: ${CODEX_HOME:-~/.codex}/hooks.json),
     leaving every other hook and setting as it was
  3. only with --with-mod: copies the mod to <Herdr app home>/mods/session-resume/
     (default: ${HERDR_APP_HOME:-~/.config/herdr-app}) and prints the layout
     block that makes it run (it is not added for you). This fork's Herdr ships
     the mod in its main layout already; the official app needs --with-mod.

--uninstall removes exactly those hook entries and the hook script (and, with
--with-mod, the mod folder it copied).
It never runs herdr-app, hc, claude or codex, and it never prints the contents
of the settings files (they can hold secrets): only the hook entries it changes.
"""

import argparse
import datetime
import filecmp
import json
import os
from pathlib import Path
import shlex
import shutil
import sys

HERE = Path(__file__).resolve().parent
# The mod ships with this fork's app; --with-mod copies it from here.
MOD_SOURCE = HERE.parent.parent / "defaults" / "mods" / "session-resume"
HOOK_NAME = "session-hook.py"
MOD_NAME = "session-resume"
MOD_FILES = ("main.js", "plan.js", "mod.json")
EVENTS = ("SessionStart", "SessionEnd")
TIMEOUT = 10

LAYOUT_BLOCK = """\
  "floating": [
    { "id": "session-resume", "content": { "mod": "session-resume" }, "edge": "bottom", "align": "end" }
  ]"""


def default_paths(home, env):
    # With --home, the environment's overrides are ignored too: everything stays under that folder.
    rooted = home is not None

    def under(var, fallback):
        value = env.get(var)
        return Path(value) if value and not rooted else fallback
    home = Path(home) if rooted else Path.home()
    return {
        "claude": under("CLAUDE_CONFIG_DIR", home / ".claude") / "settings.json",
        "codex": under("CODEX_HOME", home / ".codex") / "hooks.json",
        "app": under("HERDR_APP_HOME", home / ".config" / "herdr-app"),
        "hook_dir": under("XDG_DATA_HOME", home / ".local" / "share") / "herdr-session-resume",
    }


def default_python():
    # An absolute system interpreter: hooks run with whatever PATH the agent has.
    return "/usr/bin/python3" if os.path.exists("/usr/bin/python3") else "python3"


def ours(hook):
    return isinstance(hook, dict) and HOOK_NAME in str(hook.get("command", ""))


def hook_command(python, script, agent):
    return f"{shlex.quote(python)} {shlex.quote(str(script))} {agent}"


class Plan:
    """Changes to make, said in words first, applied only with --apply."""

    def __init__(self, apply, stamp):
        self.apply, self.stamp, self.lines, self.changed = apply, stamp, [], False

    def say(self, text=""):
        self.lines.append(text)

    def backup(self, path):
        target = path.with_name(f"{path.name}.bak-session-resume-{self.stamp}")
        self.say(f"    backup: {target}")
        if self.apply:
            shutil.copy2(path, target)

    def write_json(self, path, data, existed):
        self.changed = True
        if existed:
            self.backup(path)
        if self.apply:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_name(path.name + ".tmp-session-resume")
            tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            if existed:
                shutil.copymode(path, tmp)
            os.replace(tmp, path)


def load_json(path):
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as error:
        raise SystemExit(f"{path} is not valid JSON ({error}); fix it first. Nothing was changed.")
    if not isinstance(data, dict):
        raise SystemExit(f"{path} is not a JSON object; nothing was changed.")
    return data


def merge_hooks(plan, label, path, command, uninstall):
    """Adds (or removes) our SessionStart/SessionEnd entries, leaving all others alone."""
    data = load_json(path)
    existed = data is not None
    data = data if existed else {}
    hooks = data.get("hooks")
    if hooks is not None and not isinstance(hooks, dict):
        raise SystemExit(f"{path}: \"hooks\" is not an object; nothing was changed.")
    hooks = dict(hooks or {})
    notes = []
    for event in EVENTS:
        groups = hooks.get(event, [])
        if not isinstance(groups, list):
            raise SystemExit(f"{path}: hooks.{event} is not a list; nothing was changed.")
        kept, found = [], []
        for group in groups:
            inner = group.get("hooks") if isinstance(group, dict) else None
            if not isinstance(inner, list):
                kept.append(group)
                continue
            mine = [h for h in inner if ours(h)]
            found += mine
            rest = [h for h in inner if not ours(h)]
            if rest:
                kept.append(dict(group, hooks=rest) if mine else group)
        want = [] if uninstall else [{"type": "command", "command": command, "timeout": TIMEOUT}]
        if found == want:
            continue
        for h in found:
            notes.append(f"    - {event}: {h.get('command')}")
        for h in want:
            notes.append(f"    + {event}: {h['command']}")
        groups = kept + ([{"hooks": want}] if want else [])
        if groups:
            hooks[event] = groups
        else:
            hooks.pop(event, None)
    if not notes:
        plan.say(f"  {label}: {path} (unchanged)")
        return
    plan.say(f"  {label}: {path} ({'update' if existed else 'create'})")
    for line in notes:
        plan.say(line)
    data["hooks"] = hooks
    plan.write_json(path, data, existed)


def copy_file(plan, src, dst, label):
    if dst.exists() and filecmp.cmp(src, dst, shallow=False):
        plan.say(f"  {label}: {dst} (unchanged)")
        return
    plan.say(f"  {label}: {dst} ({'update' if dst.exists() else 'create'})")
    plan.changed = True
    if dst.exists():
        plan.backup(dst)
    if plan.apply:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)


def install_mod(plan, app, hook_dir):
    folder = app / "mods" / MOD_NAME
    for name in MOD_FILES:
        src = MOD_SOURCE / name
        dst = folder / name
        if dst.exists() and filecmp.cmp(src, dst, shallow=False):
            plan.say(f"  mod: {dst} (unchanged)")
            continue
        plan.say(f"  mod: {dst} ({'update' if dst.exists() else 'create'})")
        plan.changed = True
        if dst.exists():
            # Not beside it: a copy inside mods/ would load as another mod.
            keep = hook_dir / "backups" / plan.stamp / name
            plan.say(f"    backup: {keep}")
            if plan.apply:
                keep.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(dst, keep)
        if plan.apply:
            folder.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)


def remove(plan, path, label, backup_to=None):
    if not path.exists():
        plan.say(f"  {label}: {path} (not there)")
        return
    plan.say(f"  {label}: {path} (remove)")
    plan.changed = True
    if backup_to is not None:
        plan.say(f"    backup: {backup_to}")
    if plan.apply:
        if backup_to is not None:
            backup_to.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(path, backup_to) if path.is_dir() else shutil.copy2(path, backup_to)
        shutil.rmtree(path) if path.is_dir() else path.unlink()


def ships_mod(app):
    try:
        record = json.loads((app / "installed.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return isinstance(record, dict) and MOD_NAME in record


def main(argv=None, env=None):
    env = dict(os.environ) if env is None else env
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--apply", action="store_true", help="write the changes (default: only say what they would be)")
    p.add_argument("--uninstall", action="store_true", help="remove the hook entries and the hook script (and the mod, with --with-mod)")
    p.add_argument("--with-mod", action="store_true",
                   help="also copy the mod into the app home, for a Herdr that doesn't ship it (the official app)")
    p.add_argument("--home", help="treat this folder as the home folder for every default below (for trying it out)")
    p.add_argument("--claude-settings", type=Path, help="Claude Code settings.json")
    p.add_argument("--codex-hooks", type=Path, help="Codex hooks.json")
    p.add_argument("--app-home", type=Path, help="the Herdr app's folder (holds mods/)")
    p.add_argument("--hook-dir", type=Path, help="where session-hook.py is installed")
    p.add_argument("--python", default=None, help="the Python 3 the hooks run (default: /usr/bin/python3 if present)")
    p.add_argument("--agents", default="claude,codex", help="comma list of agents to hook (default: claude,codex)")
    args = p.parse_args(argv)

    agents = [a.strip() for a in args.agents.split(",") if a.strip()]
    if not agents or any(a not in ("claude", "codex") for a in agents):
        p.error("--agents takes claude, codex or both")
    paths = default_paths(args.home, env)
    claude = (args.claude_settings or paths["claude"]).expanduser()
    codex = (args.codex_hooks or paths["codex"]).expanduser()
    app = (args.app_home or paths["app"]).expanduser()
    hook_dir = (args.hook_dir or paths["hook_dir"]).expanduser()
    python = args.python or default_python()
    script = hook_dir / HOOK_NAME
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    # The app records the mods it ships in installed.json and replaces them on start:
    # a copy of ours there would be moved aside as session-resume-edited.
    shipped = ships_mod(app)
    with_mod = args.with_mod and not shipped

    def steps(plan):
        plan.say(f"Herdr session resume: {'uninstall' if args.uninstall else 'install'}"
                 f"{'' if plan.apply else ' (DRY RUN: nothing is written; add --apply)'}")
        plan.say()
        if args.uninstall:
            for agent in agents:
                merge_hooks(plan, f"{agent} hooks", claude if agent == "claude" else codex, None, True)
            if with_mod:
                remove(plan, app / "mods" / MOD_NAME, "mod", hook_dir / "backups" / stamp / "mod")
            remove(plan, script, "hook script")
        else:
            copy_file(plan, HERE / HOOK_NAME, script, "hook script")
            if plan.apply and script.exists():
                script.chmod(0o755)
            for agent in agents:
                merge_hooks(plan, f"{agent} hooks", claude if agent == "claude" else codex,
                            hook_command(python, script, agent), False)
            if with_mod:
                install_mod(plan, app, hook_dir)
        if args.with_mod and shipped:
            plan.say(f"  mod: {app / 'mods' / MOD_NAME} is shipped by this Herdr; left to the app (--with-mod ignored)")
        return plan

    # A dry pass first: a broken settings file stops everything before anything is written.
    plan = steps(Plan(False, stamp))
    if args.apply:
        plan = steps(Plan(True, stamp))
    plan.say()
    if not plan.changed:
        plan.say("Everything is already in place." if not args.uninstall else "Nothing to remove.")
    elif not args.apply:
        plan.say("Run again with --apply to make these changes.")
    else:
        plan.say("Done.")
    plan.say()
    if args.uninstall:
        if with_mod:
            plan.say("If a layout has the session-resume floating block, remove it from that layout's root.")
        else:
            plan.say("A Herdr that ships the mod keeps it; without the hook it stays idle.")
    else:
        plan.say("Then:")
        if shipped:
            plan.say("  * Herdr ships the session-resume mod in its main layout here: nothing to add.")
        elif not with_mod:
            plan.say(f"  * The Herdr in {app} doesn't ship the session-resume mod (the official app, or this")
            plan.say("    fork before its first start). To run it there, run again with --with-mod.")
    if not args.uninstall and with_mod:
        plan.say("  * The mod runs only in a layout that holds it. Shipped layouts are read-only, so add this")
        plan.say("    to the root node of a personal layout (to make one from Herdr's default:")
        plan.say("    herdr-app do layout.clone '{\"name\":\"main\",\"as\":\"main-resume\"}'),")
        plan.say(f"    in {app / 'layouts'}/<your layout>.json:")
        plan.say(LAYOUT_BLOCK)
        plan.say("    (if the root already has \"floating\", add just the { ... } entry to it).")
    if not args.uninstall:
        plan.say("  * Optional keys, in keys.json \"global\": \"<key>\": \"session-resume.resume\" (resume the")
        plan.say("    focused tab's session now) and \"<key>\": \"session-resume.offer\" (the dialog and settings).")
        if "codex" in agents:
            plan.say("  * Codex: start codex once and run /hooks to trust the two new hooks; Codex skips")
            plan.say("    untrusted hooks.")
        if "claude" in agents:
            plan.say("  * Claude Code picks the hooks up in new sessions; running ones need a restart.")
    print("\n".join(plan.lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
