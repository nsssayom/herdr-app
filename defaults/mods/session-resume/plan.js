// session-resume: every decision, as plain functions of plain data.
//
// No `herdr` or `gpui-kit` imports, so the tests run it under Bun as is.
// main.js gathers the facts (terminals(), the boot id, which paths exist),
// asks these functions what to do, and carries it out.
//
// The label `herdr.session` is written by contrib/session-resume/session-hook.py
// (see its README and docs/labels.md):
// {"v":1,"agent","id","cwd","transcript","mode","root","boot","agent_pid",
//  "state","why","at","tried"}

export const LABEL = "herdr.session";
export const AGENTS = ["claude", "codex"];
export const STATES = ["running", "lost", "ended", "exited", "missing"];
export const BYPASS = "bypassPermissions";
/** Permission modes a resume may pass on. Anything else (bypass included) resumes in the default mode. */
export const SAFE_MODES = ["acceptEdits", "plan", "auto", "dontAsk"];
export const DEFAULTS = { claude: "auto", codex: "ask" };
export const CHOICES = ["auto", "ask", "off"];
export const SHELLS = ["sh", "bash", "zsh", "fish", "dash", "ksh", "mksh", "tcsh", "csh", "nu", "xonsh", "elvish", "pwsh", "yash", "oksh"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WORD = /^[A-Za-z_]{1,32}$/;
// Control characters would break the typed command line; a path never needs them.
const CONTROL = /[\u0000-\u001f\u007f]/;
const BOOT = /^[A-Za-z0-9-]{1,64}$/;

const isAbs = (p) => typeof p === "string" && p.startsWith("/") && p.length < 4096 && !CONTROL.test(p);
const isPid = (n) => Number.isInteger(n) && n > 0;

/** POSIX single quotes: the shell takes everything inside literally. */
export function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * The label's record, checked field by field, or null with why.
 * Nothing outside these shapes is ever used: the typed command is rebuilt
 * from these fields alone.
 */
export function parseRecord(raw) {
  let rec;
  try {
    rec = typeof raw === "string" ? JSON.parse(raw) : null;
  } catch {
    return { rec: null, why: "the label is not JSON" };
  }
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return { rec: null, why: "no session label" };
  if (rec.v !== 1) return { rec: null, why: "an unknown label version" };
  if (!AGENTS.includes(rec.agent)) return { rec: null, why: "an unknown agent" };
  if (typeof rec.id !== "string" || !UUID.test(rec.id)) return { rec: null, why: "a session id that is not a UUID" };
  if (!isAbs(rec.cwd)) return { rec: null, why: "a folder that is not an absolute path" };
  if (rec.transcript != null && !isAbs(rec.transcript)) return { rec: null, why: "a transcript that is not an absolute path" };
  if (rec.mode != null && (typeof rec.mode !== "string" || !WORD.test(rec.mode))) return { rec: null, why: "a strange permission mode" };
  if (!isPid(rec.root)) return { rec: null, why: "no terminal process" };
  if (rec.boot != null && (typeof rec.boot !== "string" || !BOOT.test(rec.boot))) return { rec: null, why: "a strange boot id" };
  if (rec.agent_pid != null && !isPid(rec.agent_pid)) return { rec: null, why: "a strange agent process" };
  if (!STATES.includes(rec.state)) return { rec: null, why: "an unknown state" };
  if (rec.tried != null && typeof rec.tried !== "string") return { rec: null, why: "a strange tried mark" };
  return { rec, why: null };
}

/** What is typed into the shell to bring the session back. Never a bypass flag. */
export function resumeCommand(rec) {
  const cd = `cd -- ${shQuote(rec.cwd)} && `;
  if (rec.agent === "claude") {
    const mode = SAFE_MODES.includes(rec.mode) ? ` --permission-mode ${rec.mode}` : "";
    return `${cd}claude --resume ${rec.id}${mode}`;
  }
  if (rec.agent === "codex") return `${cd}codex resume --no-daemon ${rec.id}`;
  return null;
}

/** The person's choice for this agent: shared("session-resume.mode") is "auto" | "ask" | "off" or {claude, codex}. */
export function choiceFor(setting, agent) {
  if (CHOICES.includes(setting)) return setting;
  if (setting && typeof setting === "object" && CHOICES.includes(setting[agent])) return setting[agent];
  return DEFAULTS[agent] ?? "off";
}

const base = (name) => String(name ?? "").split("/").pop().replace(/^-/, "");

/** A shell is in front: by the program table, else by its process name. */
export function shellInFront(t) {
  const fg = t?.foreground;
  if (!fg) return false;
  return SHELLS.includes(base(fg.name)) || (t.program?.shell === true && base(fg.name) !== "");
}

/** The terminal's own root shell is in front, waiting at its prompt (nothing running in it). */
export function atBareShell(t) {
  return Boolean(t?.foreground) && isPid(t.pid) && t.foreground.pid === t.pid && shellInFront(t);
}

/** This terminal came back without its program: a recovery shell (new pid), or another boot. */
export function restored(rec, t, boot) {
  if (t.pid !== rec.root) return true;
  return Boolean(boot && rec.boot && boot !== rec.boot);
}

/** Which incarnation of the terminal a try belongs to. */
export const tryKey = (t, boot) => `${t.pid}@${boot ?? "?"}`;
export const triedNow = (rec, t, boot) => typeof rec.tried === "string" && rec.tried.split("#")[0] === tryKey(t, boot);

export const isLocal = (t) => typeof t?.address === "string" && t.address !== "" && !t.address.includes("/");

/** Some local terminal carries a session label: without the hook none ever does, and the mod stays idle. */
export const anyRecorded = (terminals) => (terminals ?? []).some((t) => isLocal(t) && typeof t?.labels?.[LABEL] === "string");

/** Herdr shows it: kept, live, in a space's tab. */
function inHerdr(t) {
  if (t?.state !== "live") return "not live";
  if (!t.keep) return "not kept";
  const l = t.labels ?? {};
  if (!l["herdr.space"] || !l["herdr.tab"]) return "not in a Herdr tab";
  return null;
}

/** The paths a record needs checked before anything is typed. */
export const pathsOf = (rec) => [rec.cwd, rec.transcript].filter(Boolean);

function filesOk(rec, exists) {
  // An agent writes its transcript with the first message: without one there is nothing to resume.
  if (rec.transcript == null) return "no transcript was recorded";
  for (const p of [rec.cwd, rec.transcript]) {
    const e = exists(p);
    if (e === undefined) return "unchecked";
    if (!e) return p === rec.cwd ? "its folder is gone" : "its transcript is gone";
  }
  return null;
}

/**
 * What to do with one terminal after a restore:
 * `auto` (resume now), `offer` (ask the person), `none`; or `check` when the
 * files have not been looked at yet (`paths` says which).
 * ctx: { boot, setting, exists(path) -> true | false | undefined }
 */
export function assess(t, ctx) {
  const none = (why, extra) => ({ kind: "none", why, ...extra });
  if (!isLocal(t)) return none("on another machine");
  const outside = inHerdr(t);
  if (outside) return none(outside);
  const { rec, why } = parseRecord(t.labels?.[LABEL]);
  if (!rec) return none(why);
  if (!restored(rec, t, ctx.boot)) return none("not restored", { rec });
  if (!atBareShell(t)) return none("not at its shell", { rec });
  if (triedNow(rec, t, ctx.boot)) return none("already tried", { rec });
  const choice = choiceFor(ctx.setting, rec.agent);
  if (choice === "off") return none("off for this agent", { rec });
  let kind;
  if (rec.state === "running" || rec.state === "lost") {
    kind = choice === "auto" && rec.mode !== BYPASS ? "auto" : "offer";
  } else if (rec.state === "exited") {
    kind = "offer";
  } else {
    return none(`the session ${rec.state === "ended" ? "was quit" : "could not be resumed"}`, { rec });
  }
  const files = filesOk(rec, ctx.exists);
  if (files === "unchecked") return { kind: "check", paths: pathsOf(rec), rec };
  if (files) return none(files, { rec });
  return { kind, rec, cmd: resumeCommand(rec), bypass: rec.mode === BYPASS };
}

/**
 * The key command (and the dialog's buttons): resume this terminal whatever the
 * label's state, restored or not, as long as it is safe to type into it.
 */
export function assessManual(t, ctx) {
  const no = (why) => ({ kind: "none", why });
  if (!isLocal(t)) return no("it is on another machine");
  if (t?.state !== "live") return no("it is not live");
  const { rec, why } = parseRecord(t.labels?.[LABEL]);
  if (!rec) return no(why === "no session label" ? "no session was recorded in this terminal" : `its label has ${why}`);
  if (!atBareShell(t)) return no("something is running in it; resume from its shell prompt");
  const files = filesOk(rec, ctx.exists);
  if (files === "unchecked") return { kind: "check", paths: pathsOf(rec), rec };
  if (files) return no(files);
  return { kind: "manual", rec, cmd: resumeCommand(rec), bypass: rec.mode === BYPASS };
}

/** Every terminal at once: the ones to resume now, to offer, and the paths still to check. */
export function planAll(terminals, ctx) {
  const out = { auto: [], offer: [], check: [] };
  for (const t of terminals ?? []) {
    const a = assess(t, ctx);
    if (a.kind === "auto") out.auto.push({ address: t.address, pid: t.pid, ...a });
    else if (a.kind === "offer") out.offer.push({ address: t.address, pid: t.pid, ...a });
    else if (a.kind === "check") out.check.push(...a.paths);
  }
  out.check = [...new Set(out.check)];
  return out;
}

// ---- label changes ---------------------------------------------------------

export const serialize = (rec) => JSON.stringify(rec);

/** Claims this try; only the client whose mark is read back goes on. */
export const markTried = (rec, t, boot, nonce) => ({ ...rec, tried: `${tryKey(t, boot)}#${nonce}` });
/** Not offered again for this incarnation of the terminal. */
export const markDismissed = (rec, t, boot, now) => ({ ...rec, tried: `${tryKey(t, boot)}#dismissed`, at: now });
/**
 * After typing the command: the session belongs to this shell now. The agent's
 * process isn't known until its hook reports (Codex only does at its first turn).
 */
export const markResumed = (rec, t, boot, now) =>
  ({ ...rec, root: t.pid, boot: boot ?? rec.boot ?? null, agent_pid: null, state: "running", why: "resumed", at: now });
export const markMissing = (rec, now) => ({ ...rec, state: "missing", why: "exited at once", at: now });
export const markObservedQuit = (rec, now) => ({ ...rec, state: "ended", why: "observed", at: now });

/**
 * After a resume was typed: `wait`, `ok`, or `missing` (the shell came back
 * at once and no hook reported since). `sent` = { rec (as written), pid, deadline }.
 */
export function judgeResume(t, sent, now) {
  if (!t || t.state !== "live" || t.pid !== sent.pid) return "ok"; // gone or replaced: not ours to judge
  const { rec } = parseRecord(t.labels?.[LABEL]);
  if (!rec || rec.id !== sent.rec.id || rec.at !== sent.rec.at) return "ok"; // a hook (or someone) wrote since
  if (now < sent.deadline) return "wait";
  return atBareShell(t) ? "missing" : "ok";
}

// ---- quit observer -----------------------------------------------------------

/**
 * While the app runs: remember terminals whose agent is in front; when the same
 * terminal (same root pid, same boot) shows its shell again, the person quit it.
 * Returns the memory to keep and the labels to write. Codex reports `other` for
 * every end, so this is what tells its quits from a shutdown.
 */
export function observe(memory, terminals, boot, now) {
  const next = {};
  const quits = [];
  for (const t of terminals ?? []) {
    if (!isLocal(t) || t.state !== "live") continue;
    const { rec } = parseRecord(t.labels?.[LABEL]);
    if (!rec || !["running", "lost", "exited"].includes(rec.state)) continue;
    if (restored(rec, t, boot) || rec.agent_pid === t.pid) continue; // not this incarnation, or the agent is the root
    const fg = t.foreground;
    const front = fg && fg.pid !== t.pid && (rec.agent_pid == null || fg.pid === rec.agent_pid);
    const seen = memory?.[t.address];
    if (front) {
      next[t.address] = { id: rec.id, root: t.pid, boot: boot ?? null };
    } else if (seen && seen.id === rec.id && seen.root === t.pid && atBareShell(t)) {
      quits.push({ address: t.address, rec: markObservedQuit(rec, now), was: rec });
    } else if (seen) {
      next[t.address] = seen; // something else in front for now
    }
  }
  return { memory: next, quits };
}

// ---- the person's view -------------------------------------------------------

/** Where a terminal is, by names: "space › tab". */
export function placeOf(t, spaces) {
  const sid = t?.labels?.["herdr.space"];
  const tid = t?.labels?.["herdr.tab"];
  const space = (spaces ?? []).find((s) => s.id === sid);
  const tab = space?.tabs?.find((x) => x.id === tid);
  if (!space) return t?.address ?? "";
  return tab ? `${space.name} › ${tab.name}` : space.name;
}

export const agentName = (agent) => (agent === "claude" ? "Claude Code" : agent === "codex" ? "Codex" : agent);

/** One dialog row's text. */
export function offerText(o) {
  const why = o.bypass
    ? "It ran with permissions bypassed: it resumes in the default mode, never bypassed."
    : o.rec.state === "exited"
      ? "Its agent ended while Herdr wasn't watching: maybe quit, maybe a shutdown."
      : o.rec.agent === "codex" ? "Codex sessions are resumed when you ask (setting: session-resume.mode)." : "";
  return { title: `${agentName(o.rec.agent)} · ${o.rec.id.slice(0, 8)}`, folder: o.rec.cwd, why, cmd: o.cmd };
}

/** Still worth offering: the same incarnation, the same session, not tried. */
export function stillOffered(o, terminals, boot) {
  const t = (terminals ?? []).find((x) => x.address === o.address);
  if (!t || t.pid !== o.pid || t.state !== "live") return false;
  const { rec } = parseRecord(t.labels?.[LABEL]);
  return Boolean(rec && rec.id === o.rec.id && !triedNow(rec, t, boot));
}

/** A request from the dialog to the engine copy, through shared state: honoured once, while fresh. */
export function freshRequest(req, seen, now) {
  if (!req || typeof req !== "object" || typeof req.nonce !== "string" || req.nonce === seen) return null;
  if (typeof req.at !== "number" || now - req.at > 60_000 || req.at - now > 5_000) return null;
  if (!Array.isArray(req.items)) return null;
  const items = req.items.filter((i) => i && typeof i.address === "string" && isPid(i.pid) && typeof i.id === "string"
    && (i.action === "resume" || i.action === "dismiss"));
  return { nonce: req.nonce, items };
}

// ---- this machine ------------------------------------------------------------

/** How main.js reads the boot id: the same values session-hook.py records. */
export function bootProbes(platform) {
  if (platform === "macos") {
    return [
      { cmd: "sysctl", args: ["-n", "kern.bootsessionuuid"], parse: (out) => out.trim() || null },
      { cmd: "sysctl", args: ["-n", "kern.boottime"], parse: (out) => /sec = (\d+)/.exec(out)?.[1] ?? null },
    ];
  }
  if (platform === "linux") {
    return [{ cmd: "cat", args: ["/proc/sys/kernel/random/boot_id"], parse: (out) => out.trim() || null }];
  }
  return [];
}

/** One `sh` call answers for every path: a line of 1 or 0 per path. */
export const EXISTS_SCRIPT = 'for p do if [ -e "$p" ]; then echo 1; else echo 0; fi; done';
export function parseExists(paths, stdout) {
  const lines = String(stdout).split("\n");
  const out = {};
  paths.forEach((p, i) => {
    if (lines[i] === "1") out[p] = true;
    else if (lines[i] === "0") out[p] = false;
  });
  return out;
}
