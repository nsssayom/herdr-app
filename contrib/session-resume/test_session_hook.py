"""Run with: python3 -B -m unittest discover -s contrib/session-resume -p test_session_hook.py

Also covers install.py, against throwaway home folders only.

A fake `hc` (a small Python script) stands in for herdr-core, as in upstream's
scripts/test_agent_session.py; one test runs the hook from a real process
named `claude` that leads a real PTY, so this platform's process lookup is
exercised too. No core is started and no model is called.
"""

import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout, redirect_stderr

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("session_hook", HERE / "session-hook.py")
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)

SID = "0f8c7a52-6a64-4c1e-9d3b-2b8f6d1e9a01"
OTHER = "9d1e2c3b-4a5f-4e6d-8c7b-1a2b3c4d5e6f"
BOOT = "B00T-1"

# A fake hc: `--json get <t>` prints the terminal from state.json (popping one
# foreground pid per call from "fronts" while there are some); `label <t> k=v`
# sets a label. Every call is logged with the env keys it saw.
FAKE_HC = r'''#!PYTHON
import json, os, sys
state_path = os.environ["FAKE_HC_STATE"]
state = json.load(open(state_path))
args = sys.argv[1:]
with open(state_path + ".calls", "a") as log:
    log.write(json.dumps({"args": args, "socket": os.environ.get("HC_SOCKET"),
                          "env": sorted(k for k in os.environ if k.startswith(("CLAUDE", "CODEX_")))}) + "\n")
if state.get("fail"):
    print('{"error":{"kind":"unavailable","message":"core is gone"}}', file=sys.stderr)
    sys.exit(4)
t = state["terminal"]
if args[:2] == ["--json", "get"]:
    if state.get("fronts"):
        t["foreground"]["pid"] = state["fronts"].pop(0)
    json.dump(state, open(state_path, "w"))
    print(json.dumps(t))
elif args[0] == "label":
    k, v = args[2].split("=", 1)
    t.setdefault("labels", {})[k] = v
    json.dump(state, open(state_path, "w"))
    print("{}")
else:
    sys.exit(2)
'''


class Clock:
    def __init__(self):
        self.t = 1_000.0

    def now(self):
        return self.t

    def sleep(self, s):
        self.t += s


def procs(*rows):
    """A process table: rows of (pid, ppid, pgid, tpgid, comm, argv)."""
    table = {r[0]: hook.Proc(*r) for r in rows}
    return lambda pid: table.get(pid)


# hook (100) <- sh (90) <- claude (80, in front) <- zsh (70, the terminal's root)
CLAUDE_TREE = procs(
    (100, 90, 100, 0, "python3", ["python3", "session-hook.py", "claude"]),
    (90, 80, 90, 0, "sh", ["/bin/sh", "-c", "python3 session-hook.py claude"]),
    (80, 70, 80, 80, "claude", ["claude", "--permission-mode", "acceptEdits"]),
    (70, 1, 70, 80, "zsh", ["-zsh"]),
)


class Harness(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory(prefix="srh-")
        root = Path(self.dir.name)
        self.state_path = root / "state.json"
        fake = root / "hc"
        fake.write_text(FAKE_HC.replace("PYTHON", sys.executable))
        fake.chmod(0o755)
        self.env = {"HC_TERMINAL_ID": "t7", "HC_TERMINAL_SOCKET": str(root / "core.sock"),
                    "HERDR_RESUME_HC": str(fake), "PATH": os.environ.get("PATH", ""),
                    "CLAUDECODE": "1", "CLAUDE_CODE_ENTRYPOINT": "cli", "CODEX_THREAD_ID": "parent-thread",
                    "HOME": str(root), "FAKE_HC_STATE": str(self.state_path)}
        self.clock = Clock()
        self.terminal(fg=80)

    def tearDown(self):
        self.dir.cleanup()

    def terminal(self, fg, labels=None, fronts=None, state="live", pid=70, fail=False):
        doc = {"terminal": {"address": "t7", "state": state, "pid": pid,
                            "foreground": {"pid": fg, "name": "2.1.325", "argv": [], "cwd": "/w"},
                            "labels": dict(labels or {}, **{"herdr.space": "s1", "herdr.tab": "k1"})},
               "fronts": list(fronts or []), "fail": fail}
        self.state_path.write_text(json.dumps(doc))

    def listening_socket(self):
        path = os.path.join(self.dir.name, "l.sock")
        if not os.path.exists(path):
            self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.server.bind(path)
            self.server.listen(4)
            self.addCleanup(self.server.close)
        return path

    def label(self):
        raw = json.loads(self.state_path.read_text())["terminal"]["labels"].get(hook.LABEL)
        return None if raw is None else json.loads(raw)

    def calls(self):
        path = Path(str(self.state_path) + ".calls")
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def run_hook(self, event, agent="claude", lookup=CLAUDE_TREE, me=100, env=None):
        return hook.handle(agent, event, dict(self.env, **(env or {})), lookup=lookup, boot=lambda: BOOT,
                           now=self.clock.now, sleep=self.clock.sleep, me=me, listening=lambda _: True)

    def start(self, **extra):
        return {"hook_event_name": "SessionStart", "session_id": SID, "cwd": "/work/café",
                "transcript_path": f"/home/me/.claude/projects/-work/{SID}.jsonl", "source": "startup",
                "model": "m", **extra}

    def end(self, reason, sid=SID):
        return {"hook_event_name": "SessionEnd", "session_id": sid, "cwd": "/work", "reason": reason,
                "prompt_id": "p1", "transcript_path": "/t.jsonl"}


class SessionStartTest(Harness):
    def test_start_writes_exactly_the_record_and_no_prompt_data(self):
        rec = self.run_hook(self.start(prompt="private prompt", unknown="ignored"))
        self.assertEqual(self.label(), rec)
        self.assertEqual(rec, {"v": 1, "agent": "claude", "id": SID, "cwd": "/work/café",
                               "transcript": f"/home/me/.claude/projects/-work/{SID}.jsonl", "mode": "acceptEdits",
                               "root": 70, "boot": BOOT, "agent_pid": 80, "state": "running", "why": None,
                               "at": 1_000_000, "tried": None})
        raw = json.loads(self.state_path.read_text())["terminal"]["labels"][hook.LABEL]
        self.assertNotIn("private prompt", raw)
        self.assertNotIn(" ", raw, "the label is compact JSON")
        self.assertTrue(raw.isascii())

    def test_hc_talks_to_the_terminals_own_core_without_agent_variables(self):
        self.run_hook(self.start(), env={"HC_SOCKET": "/somewhere/else.sock"})
        for call in self.calls():
            self.assertEqual(call["socket"], self.env["HC_TERMINAL_SOCKET"])
            self.assertEqual(call["env"], [], "CLAUDE*/CODEX_* variables must not reach hc")

    def test_a_new_start_replaces_every_stale_field(self):
        stale = {"v": 1, "agent": "codex", "id": OTHER, "cwd": "/old", "transcript": None, "mode": "bypassPermissions",
                 "root": 5, "boot": "old", "agent_pid": 6, "state": "missing", "why": "observed", "at": 1, "tried": "5@old#x"}
        self.terminal(fg=80, labels={hook.LABEL: json.dumps(stale)})
        rec = self.run_hook(self.start())
        self.assertEqual((rec["agent"], rec["id"], rec["state"], rec["why"], rec["tried"], rec["root"]),
                         ("claude", SID, "running", None, None, 70))

    def test_uppercase_ids_are_stored_lowercase(self):
        self.assertEqual(self.run_hook(self.start(session_id=SID.upper()))["id"], SID)

    def test_the_core_may_see_the_agent_a_moment_late(self):
        self.terminal(fg=70, fronts=[70, 70, 80])
        rec = self.run_hook(self.start())
        self.assertEqual(rec["agent_pid"], 80)
        self.assertEqual(len([c for c in self.calls() if c["args"][1:2] == ["get"]]), 3)

    def test_an_agent_the_core_never_sees_in_front_is_not_recorded(self):
        # e.g. claude inside tmux started from this terminal: its own tty, the core sees tmux.
        self.terminal(fg=55)
        with self.assertRaises(hook.Skip):
            self.run_hook(self.start())
        self.assertIsNone(self.label())
        self.assertGreaterEqual(self.clock.now() - 1_000, hook.SEE_START_S)

    def test_only_a_foreground_root_agent_is_recorded(self):
        nested = procs(
            (100, 80, 100, 0, "python3", []),
            # a claude started by another agent's tool: not the terminal's foreground group
            (80, 60, 60, 50, "claude", ["claude"]),
            (60, 50, 60, 50, "bash", ["bash"]),
            (50, 40, 50, 50, "claude", ["claude"]),
            (40, 1, 40, 50, "zsh", ["zsh"]),
        )
        with self.assertRaises(hook.Skip):
            self.run_hook(self.start(), lookup=nested)
        background = procs((100, 80, 100, 0, "python3", []), (80, 70, 80, 70, "claude", ["claude"]),
                           (70, 1, 70, 70, "zsh", ["zsh"]))
        with self.assertRaises(hook.Skip):
            self.run_hook(self.start(), lookup=background)
        detached = procs((100, 80, 100, 0, "python3", []), (80, 1, 80, 0, "claude", ["claude"]))
        with self.assertRaises(hook.Skip):
            self.run_hook(self.start(), lookup=detached)
        self.assertIsNone(self.label())
        self.assertEqual(self.calls(), [], "rejected before asking the core")

    def test_one_shot_runs_are_not_recorded(self):
        for argv in (["claude", "-p", "hi"], ["claude", "--print"], ["claude", "--print=json"]):
            tree = procs((100, 80, 100, 0, "python3", []), (80, 70, 80, 80, "claude", argv))
            with self.assertRaises(hook.Skip):
                self.run_hook(self.start(), lookup=tree)
        for argv in (["codex", "exec", "x"], ["codex", "e", "x"], ["codex", "review"]):
            tree = procs((100, 80, 100, 0, "python3", []), (80, 70, 80, 80, "codex", argv))
            with self.assertRaises(hook.Skip):
                self.run_hook(self.start(), agent="codex", lookup=tree)
        self.assertIsNone(self.label())

    def test_subagents_and_other_events_are_ignored(self):
        with self.assertRaises(hook.Skip):
            self.run_hook(self.start(agent_id="child"))
        with self.assertRaises(hook.Skip):
            self.run_hook(dict(self.start(), hook_event_name="SubagentStart"))
        self.assertEqual(self.calls(), [])

    def test_bad_input_fails_loudly(self):
        for sid in (None, "", "not-a-uuid", 7, SID + "x"):
            with self.assertRaises(hook.Failure):
                self.run_hook(self.start(session_id=sid))
        with self.assertRaises(hook.Failure):
            self.run_hook(self.start(cwd="relative/dir"))
        with self.assertRaises(hook.Failure):
            self.run_hook("[]")
        self.assertIsNone(self.label())

    def test_outside_a_herdr_terminal_nothing_happens(self):
        for drop in ("HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"):
            env = dict(self.env)
            env.pop(drop)
            with self.assertRaises(hook.Skip):
                hook.handle("claude", self.start(), env, lookup=CLAUDE_TREE, me=100, listening=lambda _: True)
        with self.assertRaises(hook.Skip):
            hook.handle("claude", self.start(), self.env, lookup=CLAUDE_TREE, me=100, listening=lambda _: False)
        self.assertEqual(self.calls(), [])

    def test_a_core_failure_is_reported(self):
        self.terminal(fg=80, fail=True)
        with self.assertRaises(hook.Failure):
            self.run_hook(self.start())

    def test_a_terminal_that_is_not_live_is_left_alone(self):
        self.terminal(fg=80, state="finished")
        with self.assertRaises(hook.Skip):
            self.run_hook(self.start())

    def test_permission_modes(self):
        def mode(agent, argv, **extra):
            tree = procs((100, 80, 100, 0, "python3", []), (80, 70, 80, 80, agent, argv))
            return self.run_hook(self.start(**extra), agent=agent, lookup=tree)["mode"]
        self.assertIsNone(mode("claude", ["claude"]))
        self.assertEqual(mode("claude", ["claude", "--permission-mode=plan"]), "plan")
        self.assertEqual(mode("claude", ["claude", "--dangerously-skip-permissions"]), hook.BYPASS)
        self.assertEqual(mode("claude", ["claude", "--permission-mode", "bypassPermissions"]), hook.BYPASS)
        self.assertEqual(mode("claude", ["claude"], permission_mode="dontAsk"), "dontAsk")
        self.assertEqual(mode("claude", ["claude", "--dangerously-skip-permissions"], permission_mode="default"),
                         hook.BYPASS, "a bypass anywhere wins")
        self.assertIsNone(mode("claude", ["claude", "--permission-mode", "x; rm -rf /"]))
        self.assertIsNone(mode("codex", ["codex", "--no-daemon"]))
        self.assertEqual(mode("codex", ["codex", "--yolo"]), hook.BYPASS)
        self.assertEqual(mode("codex", ["codex", "-s", "danger-full-access"]), hook.BYPASS)
        self.assertEqual(mode("codex", ["codex", "--dangerously-bypass-approvals-and-sandbox"]), hook.BYPASS)

    def test_package_installs_are_found_by_their_script(self):
        claude = hook.Proc(1, 0, 1, 1, "node", ["node", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"])
        codex = hook.Proc(1, 0, 1, 1, "node", ["node", "/usr/lib/node_modules/@openai/codex/bin/codex.js"])
        login = hook.Proc(1, 0, 1, 1, "-zsh", ["-zsh"])
        self.assertTrue(hook.is_agent(claude, "claude"))
        self.assertFalse(hook.is_agent(claude, "codex"))
        self.assertTrue(hook.is_agent(codex, "codex"))
        self.assertFalse(hook.is_agent(login, "claude"))
        self.assertEqual(hook._args(claude, "claude"), [])
        # macOS: the core names Claude by its versioned binary, ps by argv[0]
        self.assertTrue(hook.is_agent(hook.Proc(1, 0, 1, 1, "claude", ["claude", "--resume", SID]), "claude"))


class SessionEndTest(Harness):
    def started(self, **extra):
        rec = self.run_hook(self.start())
        rec.update(extra)
        self.terminal(fg=80, labels={hook.LABEL: hook.dump(rec)})
        self.clock.t += 60
        return rec

    def test_claude_quits_end_the_session(self):
        for reason in ("prompt_input_exit", "logout"):
            self.started()
            rec = self.run_hook(self.end(reason))
            self.assertEqual((rec["state"], rec["why"], rec["id"], rec["at"]), ("ended", reason, SID, int(self.clock.t * 1000)))
            self.assertEqual(self.label(), rec)

    def test_claude_signals_mark_the_session_lost_not_ended(self):
        # Measured on Claude Code 2.1.325: SIGTERM and SIGHUP both report `other`.
        before = self.started(tried="70@B00T-1#n")
        rec = self.run_hook(self.end("other"))
        self.assertEqual((rec["state"], rec["why"]), ("lost", "other"))
        self.assertEqual({k: v for k, v in rec.items() if k not in ("state", "why", "at")},
                         {k: v for k, v in before.items() if k not in ("state", "why", "at")})

    def test_an_unknown_claude_reason_counts_as_lost(self):
        self.started()
        self.assertEqual(self.run_hook(self.end("bye bye"))["state"], "lost")

    def test_clear_and_resume_leave_the_label_to_the_next_start(self):
        before = self.started()
        for reason in ("clear", "resume"):
            with self.assertRaises(hook.Skip):
                self.run_hook(self.end(reason))
        self.assertEqual(self.label(), before)

    def test_every_codex_end_is_ambiguous(self):
        tree = procs((100, 80, 100, 0, "python3", []), (80, 70, 80, 80, "codex", ["codex", "--no-daemon"]))
        rec = self.run_hook(self.start(), agent="codex", lookup=tree)
        self.terminal(fg=80, labels={hook.LABEL: hook.dump(rec)})
        for reason in ("other", "prompt_input_exit", None):
            rec = self.run_hook(self.end(reason), agent="codex", lookup=tree)
            self.assertEqual((rec["state"], rec["why"]), ("exited", reason or "other"))

    def test_a_late_end_of_an_older_session_changes_nothing(self):
        newer = self.started()
        for event, agent in ((self.end("prompt_input_exit", sid=OTHER), "claude"), (self.end("other"), "codex")):
            tree = procs((100, 80, 100, 0, "python3", []), (80, 70, 80, 80, agent, [agent]))
            with self.assertRaises(hook.Skip):
                self.run_hook(event, agent=agent, lookup=tree)
        self.assertEqual(self.label(), newer)

    def test_an_end_without_a_label_writes_nothing(self):
        with self.assertRaises(hook.Skip):
            self.run_hook(self.end("prompt_input_exit"))
        self.assertIsNone(self.label())
        self.terminal(fg=80, labels={hook.LABEL: "not json"})
        with self.assertRaises(hook.Skip):
            self.run_hook(self.end("prompt_input_exit"))

    def test_the_end_waits_less_for_the_core(self):
        self.started()
        self.terminal(fg=55, labels={hook.LABEL: json.dumps(self.label() or {})})
        t0 = self.clock.now()
        with self.assertRaises(hook.Skip):
            self.run_hook(self.end("other"))
        self.assertLess(self.clock.now() - t0, hook.SEE_START_S)


class MainTest(Harness):
    def main(self, argv, data, env=None):
        out, err = io.StringIO(), io.StringIO()
        stdin = io.BytesIO(data if isinstance(data, bytes) else json.dumps(data).encode())
        with redirect_stdout(out), redirect_stderr(err):
            code = hook.main(argv, dict(self.env, **(env or {})), stdin)
        return code, out.getvalue(), err.getvalue()

    def test_the_hook_path_never_prints_on_stdout(self):
        start = {"hook_event_name": "SessionStart", "session_id": SID, "cwd": "/w"}
        live = {"HC_TERMINAL_SOCKET": self.listening_socket()}
        # skipped (no core answers), broken input, a bad id, a failing core, usage
        for argv, data, env, want in ((["claude"], start, None, 0), (["claude"], b"{not json", live, 1),
                                      (["claude"], dict(start, session_id="x"), live, 1),
                                      (["gemini"], start, live, 2), ([], start, live, 2)):
            code, out, err = self.main(argv, data, env=env)
            self.assertEqual((code, out), (want, ""), err)
            if want == 1:
                self.assertIn("herdr session-resume:", err)
        code, out, err = self.main(["claude"], start, env={"HERDR_RESUME_DEBUG": "1"})
        self.assertEqual((code, out), (0, ""))
        self.assertIn("skipped: the terminal's core is not answering", err)

    def test_boot_prints_this_boots_identity(self):
        code, out, _ = self.main(["--boot"], b"")
        self.assertEqual(code, 0)
        self.assertEqual(out.strip(), hook.boot_id() or "")


class MachineTest(unittest.TestCase):
    def test_boot_identity(self):
        def run(answers):
            def fake(cmd, **_):
                return subprocess.CompletedProcess(cmd, 0, answers.get(cmd[-1], ""), "")
            return fake
        self.assertEqual(hook.boot_id(run({"kern.bootsessionuuid": "ABC-1\n"}), "darwin"), "ABC-1")
        self.assertEqual(hook.boot_id(run({"kern.boottime": "{ sec = 1794672008, usec = 120247 } Sat Nov"}), "darwin"),
                         "1794672008")
        self.assertIsNone(hook.boot_id(run({}), "darwin"))
        self.assertIsNone(hook.boot_id(run({}), "win32"))
        if sys.platform in ("darwin",) or sys.platform.startswith("linux"):
            self.assertTrue(hook.boot_id())
            self.assertEqual(hook.boot_id(), hook.boot_id(), "stable within a boot")

    def test_only_a_listening_socket_counts(self):
        with tempfile.TemporaryDirectory(prefix="srs-", dir="/tmp" if sys.platform == "darwin" else None) as d:
            path = os.path.join(d, "c.sock")
            self.assertFalse(hook.core_listening(path))
            Path(path).write_text("")
            self.assertFalse(hook.core_listening(path), "a plain file")
            os.unlink(path)
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.bind(path)
            self.assertFalse(hook.core_listening(path), "bound but nobody listens")
            s.listen(1)
            self.assertTrue(hook.core_listening(path))
            s.close()
            self.assertFalse(hook.core_listening(path), "a stale socket file from a crashed core")


def running_binary():
    """The interpreter binary itself (not a launcher stub that would reset argv[0])."""
    if sys.platform.startswith("linux"):
        return os.readlink("/proc/self/exe")
    import ctypes
    buf = ctypes.create_string_buffer(4096)
    ctypes.CDLL("/usr/lib/libproc.dylib").proc_pidpath(os.getpid(), buf, 4096)
    return buf.value.decode()


@unittest.skipUnless(sys.platform == "darwin" or sys.platform.startswith("linux"), "Unix process lookup")
class RealProcessTest(Harness):
    def test_a_real_agent_in_front_of_a_pty_is_found_and_recorded(self):
        import pty
        go = Path(self.dir.name) / "go"
        python = running_binary()
        code = (
            "import json,os,subprocess,sys,time\n"
            f"go={str(go)!r}\n"
            "while not os.path.exists(go): time.sleep(0.02)\n"
            f"event={json.dumps({'hook_event_name': 'SessionStart', 'session_id': SID, 'cwd': '/w', 'source': 'startup'})!r}\n"
            f"r=subprocess.run([{python!r},'-B',{str(HERE / 'session-hook.py')!r},'claude'],input=event.encode(),"
            "capture_output=True)\n"
            "print('CODE', r.returncode, 'OUT', repr(r.stdout), 'ERR', r.stderr.decode(), flush=True)\n"
        )
        env = dict(self.env, HERDR_RESUME_DEBUG="1", HC_TERMINAL_SOCKET=self.listening_socket())
        pid, fd = pty.fork()
        if pid == 0:  # a session leader in front of its own PTY, named claude
            os.execve(python, ["claude", "-c", code], env)
        self.terminal(fg=pid, pid=os.getpid())
        go.write_text("")
        out = b""
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
        os.waitpid(pid, 0)
        os.close(fd)
        text = out.decode(errors="replace")
        self.assertIn("CODE 0 OUT b''", text, text)
        rec = self.label()
        self.assertIsNotNone(rec, text)
        self.assertEqual((rec["agent_pid"], rec["root"], rec["mode"], rec["state"]), (pid, os.getpid(), None, "running"))



ispec = importlib.util.spec_from_file_location("session_install", HERE / "install.py")
install = importlib.util.module_from_spec(ispec)
ispec.loader.exec_module(install)


class InstallTest(unittest.TestCase):
    """install.py against throwaway homes only."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory(prefix="sri-")
        self.home = Path(self.dir.name)
        (self.home / ".claude").mkdir()
        self.settings = self.home / ".claude" / "settings.json"
        self.original = {"env": {"TOKEN": "never-printed"}, "model": "m", "hooks": {
            "SessionStart": [{"matcher": "startup", "hooks": [{"type": "command", "command": "other-tool start"}]}],
            "Stop": [{"hooks": [{"type": "command", "command": "notify"}]}]}}
        self.settings.write_text(json.dumps(self.original))

    def tearDown(self):
        self.dir.cleanup()

    def run_install(self, *args, env=None):
        out = io.StringIO()
        with redirect_stdout(out):
            install.main(["--home", str(self.home), *args], env or {})
        return out.getvalue()

    def files(self):
        return sorted(str(p.relative_to(self.home)) for p in self.home.rglob("*") if p.is_file())

    def test_dry_run_writes_nothing_and_never_prints_settings(self):
        before = self.files()
        out = self.run_install()
        self.assertEqual(self.files(), before)
        self.assertIn("DRY RUN", out)
        self.assertIn("+ SessionStart:", out)
        self.assertNotIn("never-printed", out)
        self.assertNotIn("other-tool", out)

    def test_apply_merges_beside_other_hooks_and_is_idempotent(self):
        self.run_install("--apply", "--python", "/opt/py3")
        data = json.loads(self.settings.read_text())
        self.assertEqual((data["env"], data["model"], data["hooks"]["Stop"]), (self.original["env"], "m", self.original["hooks"]["Stop"]))
        start = data["hooks"]["SessionStart"]
        self.assertEqual(start[0], self.original["hooks"]["SessionStart"][0])
        script = self.home / ".local/share/herdr-session-resume/session-hook.py"
        self.assertEqual(start[1], {"hooks": [{"type": "command", "command": f"/opt/py3 {script} claude", "timeout": 10}]})
        self.assertEqual(data["hooks"]["SessionEnd"][0]["hooks"][0]["command"], f"/opt/py3 {script} claude")
        codex = json.loads((self.home / ".codex/hooks.json").read_text())
        self.assertEqual(codex["hooks"]["SessionEnd"][0]["hooks"][0]["command"], f"/opt/py3 {script} codex")
        self.assertTrue(os.access(script, os.X_OK))
        for name in install.MOD_FILES:
            self.assertEqual((self.home / ".config/herdr-app/mods/session-resume" / name).read_bytes(),
                             (HERE / "mod" / name).read_bytes())
        self.assertEqual(len(list((self.home / ".claude").glob("settings.json.bak-session-resume-*"))), 1)
        snapshot = {f: (self.home / f).read_bytes() for f in self.files()}
        self.assertIn("Everything is already in place.", self.run_install("--apply", "--python", "/opt/py3"))
        self.assertEqual({f: (self.home / f).read_bytes() for f in self.files()}, snapshot)

    def test_a_changed_command_replaces_only_ours(self):
        self.run_install("--apply", "--python", "/old/python3")
        out = self.run_install("--apply", "--python", "/new/python3")
        self.assertIn("- SessionStart: /old/python3", out)
        commands = [h["command"] for g in json.loads(self.settings.read_text())["hooks"]["SessionStart"] for h in g["hooks"]]
        self.assertEqual(len(commands), 2)
        self.assertEqual(commands[0], "other-tool start")
        self.assertTrue(commands[1].startswith("/new/python3 "))

    def test_uninstall_restores_the_other_hooks_exactly(self):
        self.run_install("--apply", "--agents", "claude")
        self.assertFalse((self.home / ".codex/hooks.json").exists(), "--agents claude leaves Codex alone")
        self.run_install("--apply", "--uninstall", "--agents", "claude")
        self.assertEqual(json.loads(self.settings.read_text()), self.original)
        self.assertFalse((self.home / ".config/herdr-app/mods/session-resume").exists())
        self.assertFalse((self.home / ".local/share/herdr-session-resume/session-hook.py").exists())
        self.assertTrue(list((self.home / ".local/share/herdr-session-resume/backups").glob("*/mod/main.js")))

    def test_broken_json_stops_before_any_change(self):
        self.settings.write_text("{oops")
        before = self.files()
        with self.assertRaises(SystemExit):
            self.run_install("--apply")
        self.assertEqual(self.files(), before)
        self.assertEqual(self.settings.read_text(), "{oops")

    def test_environment_overrides_pick_the_targets(self):
        env = {"CLAUDE_CONFIG_DIR": "/c", "CODEX_HOME": "/x", "HERDR_APP_HOME": "/a", "XDG_DATA_HOME": "/d"}
        paths = install.default_paths(None, env)
        self.assertEqual((str(paths["claude"]), str(paths["codex"]), str(paths["app"]), str(paths["hook_dir"])),
                         ("/c/settings.json", "/x/hooks.json", "/a", "/d/herdr-session-resume"))
        rooted = install.default_paths("/h", env)
        self.assertEqual(str(rooted["claude"]), "/h/.claude/settings.json", "--home ignores them")

    def test_quoting_of_unusual_paths(self):
        self.assertEqual(install.hook_command("/usr/bin/python3", Path("/a b/it's/session-hook.py"), "codex"),
                         "/usr/bin/python3 '/a b/it'\"'\"'s/session-hook.py' codex")


if __name__ == "__main__":
    unittest.main()
