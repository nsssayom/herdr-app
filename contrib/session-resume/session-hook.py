#!/usr/bin/env python3
"""Remember which Claude Code or Codex session runs in a Herdr terminal.

Registered as the agent's SessionStart and SessionEnd hook, with the agent's
name as the only argument:

    python3 session-hook.py claude
    python3 session-hook.py codex

It writes one label, `herdr.session`, on the herdr-core terminal the agent runs
in, so the `session-resume` mod can bring the same session back after the
terminal is recovered (a reboot, a lost core). The label holds the session id,
its folder, its transcript path, the permission mode it was started with and
bookkeeping about the terminal; never prompts, messages or environment.

It never prints on stdout (Claude Code adds a SessionStart hook's stdout to the
model's context). Problems go to stderr with a non-zero exit. Cases that are
simply not ours (no Herdr terminal, a nested or headless agent, a subagent)
exit 0 silently; set HERDR_RESUME_DEBUG=1 to hear why on stderr.

`session-hook.py --boot` prints this boot's identity (for diagnostics).

Python 3 standard library only. Parts of the approach follow upstream Herdr's
scripts/agent_session.py on its fix/durable-agent-session-capture branch
(https://github.com/herdrdev/herdr-app, Apache-2.0, like this repository).
"""

import json
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import time

LABEL = "herdr.session"
AGENTS = ("claude", "codex")
UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
WORD = re.compile(r"^[A-Za-z_]{1,32}$")
BYPASS = "bypassPermissions"
# Claude Code SessionEnd reasons a person causes by quitting (measured on 2.1.325:
# /exit, Ctrl+C twice and Ctrl+D all report prompt_input_exit; /logout reports logout).
QUIT = ("prompt_input_exit", "logout")
# The session goes on in the same process, or another SessionStart follows at once.
CONTINUES = ("clear", "resume")
# How long the core may take to see the agent in front (it samples about twice a second).
SEE_START_S = 1.5
SEE_END_S = 0.6
HC_TIMEOUT_S = 3


class Skip(Exception):
    """Not ours: exit 0 without a word (unless debugging)."""


class Failure(Exception):
    """A real problem: stderr and a non-zero exit."""


# ---- processes -------------------------------------------------------------


class Proc:
    def __init__(self, pid, ppid, pgid, tpgid, comm, argv):
        self.pid, self.ppid, self.pgid, self.tpgid = pid, ppid, pgid, tpgid
        self.comm, self.argv = comm, argv

    def __repr__(self):
        return f"Proc({self.pid}, ppid={self.ppid}, pgid={self.pgid}, tpgid={self.tpgid}, comm={self.comm!r})"


def _linux_proc(pid):
    try:
        with open(f"/proc/{pid}/stat", "rb") as f:
            raw = f.read().decode("utf-8", "replace")
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            argv = [a.decode("utf-8", "replace") for a in f.read().split(b"\0") if a]
    except OSError:
        return None
    comm = raw[raw.find("(") + 1:raw.rfind(")")]
    fields = raw[raw.rfind(")") + 2:].split()
    # state ppid pgrp session tty_nr tpgid
    return Proc(pid, int(fields[1]), int(fields[2]), int(fields[5]), comm, argv)


def _macos_argv(pid):
    """KERN_PROCARGS2: argc, the executable path, then the arguments, NUL-separated."""
    try:
        import ctypes
        libc = ctypes.CDLL("/usr/lib/libc.dylib", use_errno=True)
        argmax = ctypes.c_int(0)
        size = ctypes.c_size_t(ctypes.sizeof(argmax))
        if libc.sysctl((ctypes.c_int * 2)(1, 8), 2, ctypes.byref(argmax), ctypes.byref(size), None, 0) != 0:
            return None
        buf = ctypes.create_string_buffer(argmax.value)
        size = ctypes.c_size_t(argmax.value)
        if libc.sysctl((ctypes.c_int * 3)(1, 49, pid), 3, buf, ctypes.byref(size), None, 0) != 0:
            return None
        raw = buf.raw[:size.value]
        argc = int.from_bytes(raw[:4], sys.byteorder)
        rest = raw[4:]
        rest = rest[rest.find(b"\0"):].lstrip(b"\0")
        return [a.decode("utf-8", "replace") for a in rest.split(b"\0")[:argc]]
    except (OSError, ValueError, AttributeError):
        return None


def _macos_proc(pid):
    try:
        out = subprocess.run(["ps", "-ww", "-o", "pid=,ppid=,pgid=,tpgid=,comm=", "-p", str(pid)],
                             capture_output=True, text=True, timeout=HC_TIMEOUT_S).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    parts = out.strip().split(None, 4)
    if len(parts) < 5:
        return None
    argv = _macos_argv(pid)
    if argv is None:
        try:
            argv = subprocess.run(["ps", "-ww", "-o", "args=", "-p", str(pid)], capture_output=True,
                                  text=True, timeout=HC_TIMEOUT_S).stdout.split()
        except (OSError, subprocess.SubprocessError):
            argv = []
    return Proc(int(parts[0]), int(parts[1]), int(parts[2]), int(parts[3]), parts[4], argv)


def proc(pid):
    return _linux_proc(pid) if sys.platform.startswith("linux") else _macos_proc(pid)


def _base(path):
    return os.path.basename(path or "").lstrip("-")


def is_agent(p, agent):
    """The process is this agent: by its command name or argv[0], or as a node/bun package script."""
    names = {_base(p.comm), _base(p.argv[0] if p.argv else "")}
    if agent in names:
        return True
    if names & {"node", "bun"} and len(p.argv) > 1:
        script = p.argv[1]
        if agent == "claude":
            return "claude-code" in script or _base(script) == "claude"
        return "@openai/codex" in script or _base(script) in ("codex", "codex.js")
    return False


def _args(p, agent):
    """The agent's own arguments (after the script for a node/bun package)."""
    names = {_base(p.comm), _base(p.argv[0] if p.argv else "")}
    return p.argv[2:] if agent not in names and len(p.argv) > 1 else p.argv[1:]


def headless(agent, args):
    """A one-shot run (claude -p, codex exec / review): nothing to resume in a terminal."""
    if agent == "claude":
        return any(a in ("-p", "--print") or a.startswith("--print=") for a in args)
    return any(a in ("exec", "e", "review") for a in args)


def argv_mode(agent, args):
    """The permission mode the agent was started with, as far as its flags say."""
    mode = None
    for i, a in enumerate(args):
        if agent == "claude":
            if a == "--dangerously-skip-permissions":
                return BYPASS
            if a == "--permission-mode" and i + 1 < len(args):
                mode = args[i + 1]
            elif a.startswith("--permission-mode="):
                mode = a.split("=", 1)[1]
        else:
            if a in ("--dangerously-bypass-approvals-and-sandbox", "--yolo"):
                return BYPASS
            if a in ("-s", "--sandbox") and i + 1 < len(args) and args[i + 1] == "danger-full-access":
                return BYPASS
            if a == "--sandbox=danger-full-access":
                return BYPASS
    if mode == BYPASS:
        return BYPASS
    return mode if mode and WORD.match(mode) else None


def find_agent(agent, start, lookup=proc, depth=16):
    """The nearest ancestor (from `start` up) that is this agent, or None."""
    pid = start
    for _ in range(depth):
        if pid <= 1:
            return None
        p = lookup(pid)
        if p is None:
            return None
        if is_agent(p, agent):
            return p
        pid = p.ppid
    return None


# ---- this machine ----------------------------------------------------------


def boot_id(run=subprocess.run, platform=sys.platform):
    """This boot's identity as a string: macOS's boot session UUID (else its boot time
    in seconds), Linux's boot_id. The session-resume mod reads the same values."""
    if platform.startswith("linux"):
        try:
            with open("/proc/sys/kernel/random/boot_id", encoding="ascii") as f:
                return f.read().strip() or None
        except OSError:
            return None
    if platform == "darwin":
        for name in ("kern.bootsessionuuid", "kern.boottime"):
            try:
                out = run(["sysctl", "-n", name], capture_output=True, text=True, timeout=HC_TIMEOUT_S).stdout.strip()
            except (OSError, subprocess.SubprocessError):
                continue
            if name == "kern.boottime":
                m = re.search(r"sec = (\d+)", out)
                out = m.group(1) if m else ""
            if out:
                return out
    return None


def core_listening(path):
    """A core answers on this socket. Checked first so that hc never starts one."""
    try:
        if not stat.S_ISSOCK(os.stat(path).st_mode):
            return False
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            s.settimeout(1)
            s.connect(path)
        finally:
            s.close()
        return True
    except OSError:
        return False


# ---- the terminal's core ---------------------------------------------------


class Core:
    def __init__(self, env):
        self.terminal = env["HC_TERMINAL_ID"]
        child = {k: v for k, v in env.items() if not (k.startswith("CLAUDE") or k.startswith("CODEX_"))}
        child["HC_SOCKET"] = env["HC_TERMINAL_SOCKET"]
        self.env = child
        self.hc = env.get("HERDR_RESUME_HC") or shutil.which("hc", path=env.get("PATH")) \
            or os.path.expanduser("~/.local/bin/hc")

    def call(self, *args):
        try:
            out = subprocess.run([self.hc, *args], env=self.env, stdin=subprocess.DEVNULL,
                                 capture_output=True, text=True, timeout=HC_TIMEOUT_S)
        except (OSError, subprocess.SubprocessError) as error:
            raise Failure(f"could not run hc: {error}") from None
        if out.returncode != 0:
            raise Failure(f"hc {args[0] if args[0] != '--json' else args[1]} failed: {out.stderr.strip() or out.returncode}")
        return out.stdout

    def get(self):
        try:
            return json.loads(self.call("--json", "get", self.terminal))
        except ValueError:
            raise Failure("hc get answered something that isn't JSON") from None

    def label(self, value):
        self.call("label", self.terminal, f"{LABEL}={value}")


def parse(raw):
    try:
        rec = json.loads(raw) if isinstance(raw, str) else None
    except ValueError:
        return None
    return rec if isinstance(rec, dict) and rec.get("v") == 1 else None


def dump(rec):
    return json.dumps(rec, separators=(",", ":"), ensure_ascii=True)


def _abs(value):
    return value if isinstance(value, str) and value.startswith("/") and "\0" not in value else None


# ---- the hook ----------------------------------------------------------------


def handle(agent, event, env, *, lookup=proc, core=None, boot=boot_id, now=time.time, sleep=time.sleep,
           me=None, listening=core_listening):
    """Runs one hook event. Returns the label written (a dict), or raises Skip / Failure."""
    if not env.get("HC_TERMINAL_ID"):
        raise Skip("not in a herdr-core terminal")
    if not env.get("HC_TERMINAL_SOCKET") or not listening(env["HC_TERMINAL_SOCKET"]):
        raise Skip("the terminal's core is not answering")
    if not isinstance(event, dict):
        raise Failure("the hook input is not a JSON object")
    name = event.get("hook_event_name")
    if name not in ("SessionStart", "SessionEnd"):
        raise Skip(f"{name!r} is not a session start or end")
    if event.get("agent_id"):
        raise Skip("a subagent's event")
    sid = event.get("session_id")
    if not isinstance(sid, str) or not UUID.match(sid):
        raise Failure("the hook input has no session_id that is a UUID")

    p = find_agent(agent, os.getppid() if me is None else me, lookup)
    if p is None:
        raise Skip(f"no {agent} process above this hook")
    if p.tpgid <= 0 or p.pgid != p.tpgid:
        raise Skip(f"{agent} ({p.pid}) is not in front of its terminal")
    args = _args(p, agent)
    if headless(agent, args):
        raise Skip(f"{agent} ({p.pid}) is a one-shot run")

    core = core or Core(env)
    deadline = now() + (SEE_START_S if name == "SessionStart" else SEE_END_S)
    while True:
        record = core.get()
        if record.get("state") != "live":
            raise Skip("the terminal is not live")
        front = (record.get("foreground") or {}).get("pid")
        if front == p.pgid:
            break
        if now() >= deadline:
            raise Skip(f"the core sees {front} in front, not {agent} ({p.pgid})")
        sleep(0.1)
    old = parse((record.get("labels") or {}).get(LABEL))
    at = int(now() * 1000)

    if name == "SessionStart":
        given = event.get("permission_mode")
        given = given if isinstance(given, str) and WORD.match(given) else None
        flags = argv_mode(agent, args)
        mode = BYPASS if BYPASS in (given, flags) else (given or flags)
        rec = {"v": 1, "agent": agent, "id": sid.lower(), "cwd": _abs(event.get("cwd")),
               "transcript": _abs(event.get("transcript_path")), "mode": mode, "root": record.get("pid"),
               "boot": boot(), "agent_pid": p.pgid, "state": "running", "why": None, "at": at, "tried": None}
        if rec["cwd"] is None:
            raise Failure("the hook input has no absolute cwd")
        core.label(dump(rec))
        return rec

    # SessionEnd: only for the session the label names; a late hook of an older one changes nothing.
    if old is None or old.get("id") != sid.lower() or old.get("agent") != agent:
        raise Skip("the label names another session")
    reason = event.get("reason")
    reason = reason if isinstance(reason, str) and WORD.match(reason) else "other"
    if agent == "claude" and reason in CONTINUES:
        raise Skip(f"the session goes on ({reason})")
    if agent == "claude":
        # Claude reports `other` for signals (SIGTERM, SIGHUP: a shutdown, a lost terminal);
        # a person quitting reports prompt_input_exit or logout.
        state = "ended" if reason in QUIT else "lost"
    else:
        # Codex says `other` whatever happened: a quit and a shutdown look alike.
        state = "exited"
    rec = dict(old, state=state, why=reason, at=at)
    core.label(dump(rec))
    return rec


def main(argv=None, env=None, stdin=None):
    argv = sys.argv[1:] if argv is None else argv
    env = dict(os.environ) if env is None else env
    out, sys.stdout = sys.stdout, sys.stderr  # nothing reaches stdout from the hook path
    try:
        if argv == ["--boot"]:
            print(boot_id() or "", file=out)
            return 0
        if len(argv) != 1 or argv[0] not in AGENTS:
            print("usage: session-hook.py claude|codex  (reads the hook's JSON on stdin)", file=sys.stderr)
            return 2
        try:
            raw = (stdin or sys.stdin.buffer).read()
            try:
                event = json.loads(raw.decode("utf-8") if isinstance(raw, bytes) else raw)
            except ValueError:
                raise Failure("the hook input is not JSON") from None
            handle(argv[0], event, env)
        except Skip as why:
            if env.get("HERDR_RESUME_DEBUG"):
                print(f"herdr session-resume: skipped: {why}", file=sys.stderr)
        except Failure as error:
            print(f"herdr session-resume: {error}", file=sys.stderr)
            return 1
        return 0
    finally:
        sys.stdout = out


if __name__ == "__main__":
    sys.exit(main())
