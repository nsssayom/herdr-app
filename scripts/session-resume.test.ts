// The session-resume mod (defaults/mods/session-resume) and its label, from contrib/session-resume/session-hook.py.
import { test, expect, describe } from "bun:test";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import * as plan from "../defaults/mods/session-resume/plan.js";

const {
  LABEL, shQuote, parseRecord, resumeCommand, choiceFor, atBareShell, shellInFront, restored, assess, assessManual,
  planAll, markTried, markResumed, markMissing, markDismissed, judgeResume, observe, placeOf, offerText,
  stillOffered, freshRequest, bootProbes, parseExists, EXISTS_SCRIPT, triedNow, serialize,
} = plan;

const ID = "0f8c7a52-6a64-4c1e-9d3b-2b8f6d1e9a01";
const BOOT = "0FF8C0C1-1E9D-49DE-9BFA-2646757BB028";
const OLD_BOOT = "11111111-2222-3333-4444-555555555555";

function rec(over: Record<string, unknown> = {}) {
  return {
    v: 1, agent: "claude", id: ID, cwd: "/work/app", transcript: `/home/me/.claude/projects/-work-app/${ID}.jsonl`,
    mode: null, root: 100, boot: OLD_BOOT, agent_pid: 120, state: "running", why: null, at: 1, tried: null, ...over,
  };
}

/** A kept Herdr terminal (null: no session label); by default recovered after a reboot: a new shell pid at its prompt. */
function term(r: unknown = rec(), over: Record<string, any> = {}) {
  const pid = over.pid ?? 500;
  return {
    address: "t7", state: "live", keep: true, pid,
    foreground: { pid, name: "zsh", argv: ["-zsh"], cwd: "/work/app" },
    program: { key: "shell", shell: true },
    labels: { "herdr.space": "s1", "herdr.tab": "k1", ...(r === null ? {} : { [LABEL]: typeof r === "string" ? r : JSON.stringify(r) }) },
    ...over,
  };
}

const all = () => true;
const ctx = (over: Record<string, unknown> = {}) => ({ boot: BOOT, setting: undefined, exists: all, ...over });

describe("the label", () => {
  test("a valid record parses; every field is checked", () => {
    expect(parseRecord(JSON.stringify(rec())).rec).toEqual(rec());
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ v: 2 }, "version"], [{ agent: "gemini" }, "agent"], [{ id: "x" }, "UUID"], [{ id: ID.toUpperCase() }, "UUID"],
      [{ cwd: "relative" }, "folder"], [{ cwd: "/a\nb" }, "folder"], [{ cwd: 7 }, "folder"],
      [{ transcript: "rel.jsonl" }, "transcript"], [{ mode: "x; rm -rf /" }, "mode"], [{ root: 0 }, "process"],
      [{ root: "100" }, "process"], [{ boot: "$(reboot)" }, "boot"], [{ agent_pid: -1 }, "agent"],
      [{ state: "zombie" }, "state"], [{ tried: 5 }, "tried"],
    ];
    for (const [over, word] of bad) {
      const out = parseRecord(JSON.stringify(rec(over)));
      expect(out.rec).toBeNull();
      expect(out.why).toContain(word);
    }
    expect(parseRecord("{not json").why).toContain("JSON");
    expect(parseRecord(undefined).why).toBe("no session label");
    expect(parseRecord("[1]").rec).toBeNull();
  });

  test("label changes keep everything else and serialize compactly", () => {
    const t = term();
    const tried = markTried(rec(), t, BOOT, "n1");
    expect(tried.tried).toBe(`500@${BOOT}#n1`);
    expect(triedNow(tried, t, BOOT)).toBe(true);
    expect(triedNow(tried, { ...t, pid: 501 }, BOOT)).toBe(false);
    expect(triedNow(tried, t, "other-boot")).toBe(false);
    const resumed = markResumed(tried, t, BOOT, 99);
    expect(resumed).toEqual({ ...tried, root: 500, boot: BOOT, agent_pid: null, state: "running", why: "resumed", at: 99 });
    expect(markMissing(resumed, 100)).toMatchObject({ state: "missing", why: "exited at once", at: 100, root: 500 });
    expect(markDismissed(rec(), t, BOOT, 5).tried).toBe(`500@${BOOT}#dismissed`);
    expect(serialize(rec())).not.toContain(" ");
    expect(parseRecord(serialize(resumed)).rec).toEqual(resumed);
  });
});

describe("the typed command", () => {
  test("POSIX single quotes survive any folder name", () => {
    expect(shQuote("plain")).toBe("'plain'");
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
    const nasty = `/w/a b/$(touch x)/\`id\`/"q"/'s'/;&|<>*?/café`;
    const echoed = execFileSync("/bin/sh", ["-c", `printf %s ${shQuote(nasty)}`]).toString();
    expect(echoed).toBe(nasty);
  });

  test("claude: rebuilt from the fields, a safe mode only, never a bypass", () => {
    expect(resumeCommand(rec({ cwd: "/w/it's" }))).toBe(`cd -- '/w/it'\\''s' && claude --resume ${ID}`);
    for (const mode of ["acceptEdits", "plan", "auto", "dontAsk"]) {
      expect(resumeCommand(rec({ mode }))).toBe(`cd -- '/work/app' && claude --resume ${ID} --permission-mode ${mode}`);
    }
    for (const mode of ["bypassPermissions", "default", "manual", null]) {
      expect(resumeCommand(rec({ mode }))).toBe(`cd -- '/work/app' && claude --resume ${ID}`);
    }
  });

  test("codex: resume without its daemon, no flags at all", () => {
    expect(resumeCommand(rec({ agent: "codex", mode: "bypassPermissions" }))).toBe(`cd -- '/work/app' && codex resume --no-daemon ${ID}`);
  });
});

describe("the setting", () => {
  test("one word for both agents, or one per agent, with defaults", () => {
    expect(choiceFor(undefined, "claude")).toBe("auto");
    expect(choiceFor(undefined, "codex")).toBe("ask");
    expect(choiceFor("off", "claude")).toBe("off");
    expect(choiceFor("auto", "codex")).toBe("auto");
    expect(choiceFor({ codex: "auto" }, "codex")).toBe("auto");
    expect(choiceFor({ codex: "auto" }, "claude")).toBe("auto");
    expect(choiceFor({ claude: "ask" }, "claude")).toBe("ask");
    expect(choiceFor({ claude: "sometimes" }, "claude")).toBe("auto");
    expect(choiceFor("yes", "codex")).toBe("ask");
  });
});

describe("the terminal", () => {
  test("a bare shell is the root process in front, and a shell", () => {
    expect(atBareShell(term())).toBe(true);
    expect(atBareShell(term(rec(), { foreground: { pid: 501, name: "zsh" } }))).toBe(false); // a nested shell
    expect(atBareShell(term(rec(), { foreground: { pid: 500, name: "2.1.325" }, program: { shell: false } }))).toBe(false);
    expect(atBareShell(term(rec(), { foreground: null }))).toBe(false);
    expect(shellInFront(term(rec(), { foreground: { pid: 500, name: "-bash" }, program: undefined }))).toBe(true);
    expect(shellInFront(term(rec(), { foreground: { pid: 500, name: "/opt/homebrew/bin/fish" }, program: undefined }))).toBe(true);
    expect(shellInFront(term(rec(), { foreground: { pid: 500, name: "xonsh-custom" }, program: { shell: true } }))).toBe(true);
    expect(shellInFront(term(rec(), { foreground: { pid: 500, name: "vim" }, program: { shell: false } }))).toBe(false);
  });

  test("restored means a new root process, or another boot", () => {
    expect(restored(rec(), term(), BOOT)).toBe(true);
    expect(restored(rec({ root: 500, boot: BOOT }), term(), BOOT)).toBe(false);
    expect(restored(rec({ root: 500, boot: OLD_BOOT }), term(), BOOT)).toBe(true); // a pid reused after reboot
    expect(restored(rec({ root: 500, boot: null }), term(), BOOT)).toBe(false);
    expect(restored(rec({ root: 500 }), term(), null)).toBe(false);
  });
});

describe("after a restore", () => {
  test("a running Claude session is resumed by itself", () => {
    const a = assess(term(), ctx());
    expect(a.kind).toBe("auto");
    expect(a.cmd).toBe(`cd -- '/work/app' && claude --resume ${ID}`);
  });

  test("a session lost to a signal (Claude's `other`) counts as running", () => {
    expect(assess(term(rec({ state: "lost", why: "other" })), ctx()).kind).toBe("auto");
  });

  test("Codex asks by default and resumes by itself when set to", () => {
    const codex = term(rec({ agent: "codex" }));
    expect(assess(codex, ctx()).kind).toBe("offer");
    expect(assess(codex, ctx({ setting: { codex: "auto" } })).kind).toBe("auto");
    expect(assess(codex, ctx({ setting: "off" })).kind).toBe("none");
  });

  test("ambiguous ends are offered, quits are left alone", () => {
    expect(assess(term(rec({ state: "exited" })), ctx()).kind).toBe("offer");
    expect(assess(term(rec({ state: "exited" })), ctx({ setting: "off" })).kind).toBe("none");
    for (const state of ["ended", "missing"]) {
      const a = assess(term(rec({ state })), ctx({ setting: "auto" }));
      expect(a.kind).toBe("none");
    }
  });

  test("a bypassed session is never resumed by itself, and offered without the bypass", () => {
    const a = assess(term(rec({ mode: "bypassPermissions" })), ctx({ setting: "auto" }));
    expect(a.kind).toBe("offer");
    expect(a.bypass).toBe(true);
    expect(a.cmd).not.toContain("bypass");
    expect(a.cmd).not.toContain("dangerously");
    expect(offerText({ ...a, address: "t7", pid: 500 }).why).toContain("never bypassed");
  });

  test("ask setting offers Claude too", () => {
    expect(assess(term(), ctx({ setting: { claude: "ask" } })).kind).toBe("offer");
  });

  test("nothing is typed unless every condition holds", () => {
    const cases: Array<[unknown, string]> = [
      [term(rec(), { address: "vps/t7" }), "another machine"],
      [term(rec(), { state: "finished" }), "not live"],
      [term(rec(), { keep: false }), "not kept"],
      [{ ...term(), labels: { [LABEL]: JSON.stringify(rec()) } }, "not in a Herdr tab"],
      [term(null), "no session label"],
      [term("garbage"), "not JSON"],
      [term(rec({ root: 500, boot: BOOT })), "not restored"], // the person quit; same shell
      [term(rec(), { foreground: { pid: 777, name: "vim" }, program: { shell: false } }), "not at its shell"],
      [term(rec({ tried: `500@${BOOT}#n1` })), "already tried"],
      [term(rec({ tried: `500@${BOOT}#dismissed` })), "already tried"],
      [term(rec({ transcript: null })), "no transcript"],
    ];
    for (const [t, why] of cases) {
      const a = assess(t, ctx());
      expect(a.kind).toBe("none");
      expect(a.why).toContain(why);
    }
    expect(assess(term(), ctx({ exists: (p: string) => p !== "/work/app" })).why).toBe("its folder is gone");
    expect(assess(term(), ctx({ exists: (p: string) => p === "/work/app" })).why).toBe("its transcript is gone");
    // tried on an earlier incarnation does not block this one
    expect(assess(term(rec({ tried: `400@${OLD_BOOT}#n1` })), ctx()).kind).toBe("auto");
  });

  test("files are checked first, by path", () => {
    const a = assess(term(), ctx({ exists: () => undefined }));
    expect(a.kind).toBe("check");
    expect(a.paths).toEqual(["/work/app", rec().transcript]);
  });

  test("planAll sorts every terminal and gathers the paths to check", () => {
    const list = [
      term(),
      term(rec({ agent: "codex", id: "9d1e2c3b-4a5f-4e6d-8c7b-1a2b3c4d5e6f" }), { address: "t8", pid: 600, foreground: { pid: 600, name: "zsh" } }),
      term(rec({ state: "ended" }), { address: "t9" }),
      term(rec({ cwd: "/elsewhere" }), { address: "tb" }),
    ];
    const p = planAll(list, ctx({ exists: (x: string) => (x.startsWith("/elsewhere") ? undefined : true) }));
    expect(p.auto.map((x: any) => x.address)).toEqual(["t7"]);
    expect(p.offer.map((x: any) => x.address)).toEqual(["t8"]);
    expect(p.offer[0].pid).toBe(600);
    expect(p.check).toEqual(["/elsewhere", rec().transcript]);
    expect(planAll(undefined, ctx())).toEqual({ auto: [], offer: [], check: [] });
  });
});

describe("the key command", () => {
  test("resumes whatever the state, but only at a bare local shell, never bypassed", () => {
    for (const state of ["running", "lost", "ended", "exited", "missing"]) {
      const a = assessManual(term(rec({ state, root: 500, boot: BOOT, tried: `500@${BOOT}#x` })), ctx());
      expect(a.kind).toBe("manual");
    }
    expect(assessManual(term(rec({ mode: "bypassPermissions" })), ctx()).cmd).not.toContain("permission");
    expect(assessManual(term(rec(), { foreground: { pid: 9, name: "claude" }, program: {} }), ctx()).why).toContain("running in it");
    expect(assessManual(term(null), ctx()).why).toContain("no session was recorded");
    expect(assessManual(term(rec(), { address: "vps/t1" }), ctx()).why).toContain("another machine");
    expect(assessManual(term(), ctx({ exists: () => false })).why).toBe("its folder is gone");
    expect(assessManual(term(), ctx({ exists: () => undefined })).kind).toBe("check");
  });
});

describe("after typing", () => {
  const sent = (over: Record<string, unknown> = {}) => ({ pid: 500, rec: rec({ root: 500, at: 50 }), deadline: 1000, ...over });
  const now = (r: unknown, over = {}) => term(r, over);

  test("waits, then calls it missing only if the shell is back and no hook wrote", () => {
    const s = sent();
    expect(judgeResume(now(s.rec), s, 500)).toBe("wait");
    expect(judgeResume(now(s.rec), s, 1000)).toBe("missing");
    expect(judgeResume(now(s.rec, { foreground: { pid: 501, name: "2.1.325" }, program: {} }), s, 1000)).toBe("ok");
    expect(judgeResume(now({ ...s.rec, at: 60, agent_pid: 501 }), s, 500)).toBe("ok"); // SessionStart came
    expect(judgeResume(now({ ...s.rec, at: 70, state: "ended" }), s, 2000)).toBe("ok"); // quit at once: theirs
    expect(judgeResume(now(s.rec, { pid: 900 }), s, 2000)).toBe("ok"); // replaced
    expect(judgeResume(undefined, s, 2000)).toBe("ok");
  });
});

describe("the quit observer", () => {
  const ours = rec({ root: 500, boot: BOOT, agent_pid: 520 });
  const agentFront = term(ours, { foreground: { pid: 520, name: "2.1.325" }, program: { shell: false } });
  const shellBack = term(ours);

  test("agent in front, then the same shell back: the person quit", () => {
    let m = observe({}, [agentFront], BOOT, 1).memory;
    expect(m.t7).toEqual({ id: ID, root: 500, boot: BOOT });
    const out = observe(m, [shellBack], BOOT, 2);
    expect(out.quits).toHaveLength(1);
    expect(out.quits[0].rec).toEqual({ ...ours, state: "ended", why: "observed", at: 2 });
    expect(out.quits[0].was).toEqual(ours);
    expect(out.memory).toEqual({});
  });

  test("never without having seen the agent, nor after a restore, nor for another session", () => {
    expect(observe({}, [shellBack], BOOT, 2).quits).toHaveLength(0);
    const m = observe({}, [agentFront], BOOT, 1).memory;
    expect(observe(m, [term(ours, { pid: 900, foreground: { pid: 900, name: "zsh" } })], BOOT, 2).quits).toHaveLength(0);
    expect(observe(m, [term(rec({ ...ours, id: "9d1e2c3b-4a5f-4e6d-8c7b-1a2b3c4d5e6f" }))], BOOT, 2).quits).toHaveLength(0);
    expect(observe(m, [term({ ...ours, state: "ended" })], BOOT, 2).quits).toHaveLength(0);
    expect(observe(m, [], BOOT, 2).memory).toEqual({});
    // something else in front (an editor the agent opened): keep watching
    const editor = term(ours, { foreground: { pid: 530, name: "vim" }, program: { shell: false } });
    const kept = observe(m, [editor], BOOT, 2);
    expect(kept.quits).toHaveLength(0);
    expect(kept.memory.t7).toBeDefined();
    expect(observe(kept.memory, [shellBack], BOOT, 3).quits).toHaveLength(1);
  });

  test("after a resume (agent pid unknown) any program in front arms it; an agent that is the root never does", () => {
    const resumed = rec({ root: 500, boot: BOOT, agent_pid: null, agent: "codex", state: "running" });
    const m = observe({}, [term(resumed, { foreground: { pid: 610, name: "codex" }, program: {} })], BOOT, 1).memory;
    expect(observe(m, [term(resumed)], BOOT, 2).quits[0].rec.state).toBe("ended");
    const root = rec({ root: 500, boot: BOOT, agent_pid: 500 });
    expect(observe({}, [term(root, { foreground: { pid: 500, name: "2.1.325" }, program: {} })], BOOT, 1).memory).toEqual({});
  });

  test("remote and finished terminals are ignored", () => {
    expect(observe({}, [{ ...agentFront, address: "vps/t7" }, { ...agentFront, state: "finished" }], BOOT, 1).memory).toEqual({});
  });
});

describe("the dialog", () => {
  test("names the place and says why", () => {
    const sp = [{ id: "s1", name: "herdr", tabs: [{ id: "k1", name: "fix login" }] }];
    expect(placeOf(term(), sp)).toBe("herdr › fix login");
    expect(placeOf(term(), [{ id: "s1", name: "herdr", tabs: [] }])).toBe("herdr");
    expect(placeOf(term(), [])).toBe("t7");
    expect(placeOf(undefined, sp)).toBe("");
    const offer = (r: any) => ({ address: "t7", pid: 500, rec: r, cmd: resumeCommand(r), bypass: r.mode === "bypassPermissions" });
    expect(offerText(offer(rec({ state: "exited" }))).why).toContain("maybe a shutdown");
    expect(offerText(offer(rec({ agent: "codex" }))).why).toContain("when you ask");
    expect(offerText(offer(rec())).title).toBe("Claude Code · 0f8c7a52");
  });

  test("an offer lasts while the same terminal holds the same untried session", () => {
    const o = { address: "t7", pid: 500, rec: rec() };
    expect(stillOffered(o, [term()], BOOT)).toBe(true);
    expect(stillOffered(o, [term(rec(), { pid: 501 })], BOOT)).toBe(false);
    expect(stillOffered(o, [term(rec({ tried: `500@${BOOT}#n` }))], BOOT)).toBe(false);
    expect(stillOffered(o, [term(rec({ id: "9d1e2c3b-4a5f-4e6d-8c7b-1a2b3c4d5e6f" }))], BOOT)).toBe(false);
    expect(stillOffered(o, [], BOOT)).toBe(false);
  });

  test("requests are honoured once and only while fresh", () => {
    const item = { address: "t7", pid: 500, id: ID, action: "resume" };
    const req = { nonce: "a", at: 1000, items: [item, { ...item, action: "rm -rf" }, { ...item, pid: "500" }, null] };
    expect(freshRequest(req, null, 2000)).toEqual({ nonce: "a", items: [item] });
    expect(freshRequest(req, "a", 2000)).toBeNull();
    expect(freshRequest(req, null, 1000 + 61_000)).toBeNull();
    expect(freshRequest({ ...req, at: 9000 }, null, 1000)).toBeNull();
    expect(freshRequest(null, null, 1)).toBeNull();
    expect(freshRequest({ nonce: "b", at: 1, items: "x" }, null, 1)).toBeNull();
  });
});

describe("this machine", () => {
  test("the boot id the mod reads is the one the hook records", async () => {
    const platform = process.platform === "darwin" ? "macos" : process.platform;
    const probes = bootProbes(platform);
    if (!probes.length) return;
    let mine: string | null = null;
    for (const p of probes) {
      mine = p.parse(execFileSync(p.cmd, p.args).toString());
      if (mine) break;
    }
    const hook = execFileSync("python3", [new URL("../contrib/session-resume/session-hook.py", import.meta.url).pathname, "--boot"]).toString().trim();
    expect(mine).toBe(hook);
    expect(parseRecord(JSON.stringify(rec({ boot: mine }))).rec).not.toBeNull();
  });

  test("boot probes parse both macOS forms", () => {
    const [uuid, time] = bootProbes("macos");
    expect(uuid.parse("0FF8C0C1-1E9D-49DE-9BFA-2646757BB028\n")).toBe("0FF8C0C1-1E9D-49DE-9BFA-2646757BB028");
    expect(time.parse("{ sec = 1794672008, usec = 120247 } Sat Nov 14")).toBe("1794672008");
    expect(bootProbes("windows")).toEqual([]);
  });

  test("one sh call says which paths exist", () => {
    const paths = ["/", "/definitely/not/here", "/tmp/it's here?"];
    const out = execFileSync("/bin/sh", ["-c", EXISTS_SCRIPT, "sh", ...paths]).toString();
    expect(parseExists(paths, out)).toEqual({ "/": true, "/definitely/not/here": false, "/tmp/it's here?": false });
    expect(parseExists(["/a"], "")).toEqual({});
  });
});

// ---- main.js against a fake core ---------------------------------------------

const source = (await readFile(new URL("../defaults/mods/session-resume/main.js", import.meta.url), "utf8"))
  .replace(/^import [\s\S]*?;\n/gm, "")
  .replace("export default class SessionResume", "class SessionResume");

function engineHarness(list: any[], opts: { shared?: Record<string, unknown>; claimLost?: boolean; sendFails?: boolean; frozen?: boolean; live?: boolean; boot?: string } = {}) {
  const core = new Map(list.map((t) => [t.address, structuredClone(t)]));
  const snapshot = structuredClone(list);
  const calls: string[][] = [];
  const toasts: any[] = [];
  const store: Record<string, unknown> = { ...(opts.shared ?? {}) };
  const hc = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "--json" && args[1] === "get") {
      const t = core.get(args[2]);
      return t ? { code: 0, stdout: JSON.stringify(t), stderr: "" } : { code: 3, stdout: "", stderr: "not_found" };
    }
    if (args[0] === "label") {
      const [k, v] = [args[2].slice(0, args[2].indexOf("=")), args[2].slice(args[2].indexOf("=") + 1)];
      const t = core.get(args[1])!;
      // Another window claims at the same moment: its mark lands after ours.
      t.labels[k] = opts.claimLost && JSON.parse(v).tried?.includes("#") && !JSON.parse(v).tried.includes("#dismissed")
        ? JSON.stringify({ ...JSON.parse(v), tried: JSON.parse(v).tried.replace(/#.*/, "#theirs") }) : v;
      return { code: 0, stdout: "{}", stderr: "" };
    }
    if (args[0] === "send") return opts.sendFails ? { code: 9, stdout: "", stderr: "blocked" } : { code: 0, stdout: "{}", stderr: "" };
    return { code: 2, stdout: "", stderr: "?" };
  };
  const execs: string[][] = [];
  const exec = async (cmd: string, args: string[]) => {
    execs.push([cmd, ...args]);
    if (cmd === "/bin/sh") return { code: 0, stdout: args.slice(3).map(() => "1").join("\n") + "\n", stderr: "" };
    return { code: 0, stdout: `${BOOT}\n`, stderr: "" };
  };
  const api: Record<string, unknown> = {
    hc, exec, terminals: () => (opts.frozen ? structuredClone(snapshot) : [...core.values()].map((t) => structuredClone(t))), spaces: () => [],
    focused: () => ({ terminal: "t7" }), notify: (n: any) => toasts.push(n), openOverlay: () => "o1", closeOverlay: () => null,
    props: () => ({}), shared: (k: string) => store[k], setShared: (k: string, v: unknown) => { store[k] = v; },
    nextCommand: () => new Promise(() => {}), theme: () => ({}), checking: () => !opts.live, window: () => ({ platform: "macos" }),
  };
  const scope: Record<string, unknown> = { herdr: api, View: class {}, div: () => ({}), v_flex: () => ({}), h_flex: () => ({}), ...plan };
  const Engine = new Function(...Object.keys(scope), `${source}; return SessionResume;`)(...Object.values(scope));
  const engine = new Engine();
  const timers: Array<(cx: unknown) => void> = [];
  const tasks: Promise<unknown>[] = [];
  const cx: any = { sleep: async () => {}, notify() {}, spawn: (body: (cx: unknown) => unknown) => { tasks.push(Promise.resolve(body(cx))); } };
  engine.init({}, { spawn: (body: (cx: unknown) => unknown) => { if (opts.live) body(cx); }, // the nextCommand loop: never awaited
    timer: { after() {}, every: (_ms: number, f: any) => timers.push(f) } });
  if (!opts.live) engine.boot = opts.boot ?? BOOT;
  /** One tick as the app's timer would run it. */
  const tick = async () => { for (const f of timers) f(cx); await Promise.all(tasks.splice(0)); };
  const label = (a = "t7") => JSON.parse(core.get(a)!.labels[LABEL]);
  return { engine, core, calls, execs, toasts, store, cx, tick, timers, label, sends: () => calls.filter((c) => c[0] === "send") };
}

describe("main.js", () => {
  test("without the hook (no session labels) it does nothing at all: no exec, no hc, no toast, no chip", async () => {
    const plain = { ...term(null), labels: {} };
    const h = engineHarness([plain, term(null, { address: "t8" })], { live: true });
    expect(h.timers).toHaveLength(1);
    for (let i = 0; i < 3; i++) await h.tick();
    expect(h.execs).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(h.toasts).toEqual([]);
    expect(h.engine.offers).toEqual([]);
    expect(h.engine.boot).toBeUndefined();
  });

  test("the boot id is read once, when a label first shows up", async () => {
    const h = engineHarness([term(rec({ state: "ended" }))], { live: true });
    await h.tick();
    await h.tick();
    expect(h.execs).toEqual([["sysctl", "-n", "kern.bootsessionuuid"]]);
    expect(h.engine.boot).toBe(BOOT);
  });

  test("a check of the mod (checking()) starts nothing", () => {
    const h = engineHarness([term()]);
    expect(h.timers).toHaveLength(0);
  });

  test("a restored Claude tab is resumed once: claim, type, relabel", async () => {
    const h = engineHarness([term(rec({ cwd: "/w/it's", mode: "acceptEdits" }))]);
    await h.engine.tick(h.cx);
    expect(h.sends()).toEqual([["send", "t7", `cd -- '/w/it'\\''s' && claude --resume ${ID} --permission-mode acceptEdits`]]);
    const l = h.label();
    expect(l).toMatchObject({ root: 500, boot: BOOT, agent_pid: null, state: "running", why: "resumed" });
    expect(l.tried).toMatch(new RegExp(`^500@${BOOT}#`));
    await h.engine.tick(h.cx);
    expect(h.sends()).toHaveLength(1);
  });

  test("a claim another window won is left to it", async () => {
    const h = engineHarness([term()], { claimLost: true });
    await h.engine.tick(h.cx);
    expect(h.sends()).toHaveLength(0);
  });

  test("a resume whose shell is back at once is marked missing and said", async () => {
    const h = engineHarness([term()]);
    await h.engine.tick(h.cx);
    h.engine.watching[0].deadline = 0;
    await h.engine.tick(h.cx);
    expect(h.label()).toMatchObject({ state: "missing" });
    expect(h.toasts.map((t) => t.title)).toContain("Claude Code session didn't come back");
    expect(h.toasts.map((t) => t.title)).not.toContain("Resumed 1 agent session");
  });

  test("a resume that took is announced once the watch is over", async () => {
    const h = engineHarness([term()]);
    await h.engine.tick(h.cx);
    const t = h.core.get("t7")!;
    t.foreground = { pid: 520, name: "2.1.325" };
    t.program = { shell: false };
    h.engine.watching[0].deadline = 0;
    await h.engine.tick(h.cx);
    await h.engine.tick(h.cx);
    expect(h.toasts.map((x) => x.title)).toEqual(["Resumed 1 agent session"]);
  });

  test("Codex is offered with one toast, and answered through shared state", async () => {
    const h = engineHarness([term(rec({ agent: "codex" }))]);
    await h.engine.tick(h.cx);
    await h.engine.tick(h.cx);
    expect(h.sends()).toHaveLength(0);
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0].action).toEqual({ name: "session-resume.offer" });
    expect(h.engine.offers.map((o: any) => o.address)).toEqual(["t7"]);
    h.store["session-resume.request"] = { nonce: "n1", at: Date.now(), items: [{ address: "t7", pid: 500, id: ID, action: "resume" }] };
    await h.engine.tick(h.cx);
    expect(h.sends()).toEqual([["send", "t7", `cd -- '/work/app' && codex resume --no-daemon ${ID}`]]);
    expect(h.store["session-resume.request"]).toBeNull();
  });

  test("a terminal answered in this tick is not offered from a list that trails the core", async () => {
    const h = engineHarness([term(rec({ agent: "codex" }))], { frozen: true });
    h.store["session-resume.request"] = { nonce: "n3", at: Date.now(), items: [{ address: "t7", pid: 500, id: ID, action: "resume" }] };
    await h.engine.tick(h.cx);
    expect(h.sends()).toHaveLength(1);
    expect(h.engine.offers).toHaveLength(0);
    expect(h.toasts).toHaveLength(0);
  });

  test("Dismiss marks the try so it isn't offered again", async () => {
    const h = engineHarness([term(rec({ state: "exited" }))]);
    await h.engine.tick(h.cx);
    h.store["session-resume.request"] = { nonce: "n2", at: Date.now(), items: [{ address: "t7", pid: 500, id: ID, action: "dismiss" }] };
    await h.engine.tick(h.cx);
    expect(h.label().tried).toBe(`500@${BOOT}#dismissed`);
    expect(h.engine.offers).toHaveLength(0);
    expect(h.sends()).toHaveLength(0);
  });

  test("the key command resumes an ended session in the focused terminal", async () => {
    const h = engineHarness([term(rec({ state: "ended", root: 500, boot: BOOT }))]);
    await h.engine.tick(h.cx);
    expect(h.sends()).toHaveLength(0);
    h.engine.commands.push("resume");
    await h.engine.tick(h.cx);
    expect(h.sends()).toHaveLength(1);
  });

  test("the key command explains itself when the agent is still running", async () => {
    const h = engineHarness([term(rec(), { foreground: { pid: 520, name: "2.1.325" }, program: { shell: false } })]);
    h.engine.commands.push("resume");
    await h.engine.tick(h.cx);
    expect(h.sends()).toHaveLength(0);
    expect(h.toasts[0].body).toContain("Something is running in it");
  });

  test("a failed send is reported and not retried", async () => {
    const h = engineHarness([term()], { sendFails: true });
    await h.engine.tick(h.cx);
    await h.engine.tick(h.cx);
    expect(h.sends()).toHaveLength(1);
    expect(h.toasts[0].level).toBe("error");
  });

  test("the setting off leaves everything alone", async () => {
    const h = engineHarness([term(), term(rec({ agent: "codex" }), { address: "t8" })], { shared: { "session-resume.mode": "off" } });
    await h.engine.tick(h.cx);
    expect(h.sends()).toHaveLength(0);
    expect(h.toasts).toHaveLength(0);
  });

  test("a quit seen while the app runs is written down", async () => {
    const ours = rec({ root: 500, boot: BOOT, agent_pid: 520 });
    const h = engineHarness([term(ours, { foreground: { pid: 520, name: "2.1.325" }, program: { shell: false } })]);
    await h.engine.tick(h.cx);
    const t = h.core.get("t7")!;
    t.foreground = { pid: 500, name: "zsh" };
    t.program = { shell: true };
    await h.engine.tick(h.cx);
    expect(h.label()).toMatchObject({ state: "ended", why: "observed" });
    expect(h.sends()).toHaveLength(0);
  });
});
