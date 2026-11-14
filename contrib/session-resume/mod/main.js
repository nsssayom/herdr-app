// session-resume: after a restart, bring each tab's Claude Code or Codex
// session back in its own terminal.
//
// session-hook.py (the agents' SessionStart/SessionEnd hook) keeps a
// `herdr.session` label on each agent's terminal. This mod reads those labels
// live through terminals(). When a kept terminal comes back as a plain shell
// (a reboot, a lost core), it types the resume command into it, or offers to.
//
// One folder, two roles:
// - the engine: a floating block in the layout. It shows a small chip while
//   sessions wait for the person, nothing otherwise. Keys: `session-resume.resume`
//   (resume the focused terminal's session now), `session-resume.offer` (the dialog).
// - the dialog (opened by the engine with props().overlay): per-tab Resume and
//   Dismiss, and the setting. It asks the engine through shared state, because
//   a closing dialog's tasks are cancelled.
//
// Every decision is in plan.js; this file gathers facts and carries them out.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import * as herdr from "herdr";
import {
  LABEL, CHOICES, DEFAULTS, parseRecord, serialize, assess, assessManual, planAll, observe, atBareShell,
  markTried, markResumed, markMissing, markDismissed, judgeResume, stillOffered, freshRequest, placeOf,
  offerText, agentName, bootProbes, EXISTS_SCRIPT, parseExists, choiceFor,
} from "./plan.js";

const {
  hc, exec, terminals, spaces, focused, notify, openOverlay, closeOverlay, props,
  shared, setShared, nextCommand, theme, window: appWindow,
} = herdr;
// `checking` is newer than some installed apps (0.1.15 lacks it): a check there runs init for real.
const checking = () => typeof herdr.checking === "function" && herdr.checking();

const SETTING = "session-resume.mode";
const REQUEST = "session-resume.request";
const TICK_MS = 1500;
const GAP_MS = 2000; // between two automatic resumes
const CLAIM_MS = 400; // before reading our `tried` mark back
const WATCH_MS = 10_000; // a resume whose shell is back this soon failed
const EXISTS_TTL_MS = 15_000;

const nonce = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

async function readBoot() {
  for (const probe of bootProbes(appWindow().platform)) {
    try {
      const r = await exec(probe.cmd, probe.args, { timeout: 5000 });
      const id = r.code === 0 ? probe.parse(r.stdout) : null;
      if (id) return id;
    } catch {
      // the next probe
    }
  }
  return null;
}

/** The core's own view of one terminal now (terminals() can trail it a little). */
async function fresh(address) {
  try {
    const r = await hc(["--json", "get", address]);
    return r.code === 0 ? JSON.parse(r.stdout) : null;
  } catch {
    return null;
  }
}

async function writeLabel(address, rec) {
  const r = await hc(["label", address, `${LABEL}=${serialize(rec)}`]);
  return r.code === 0;
}

/** Writes `next` only if the label is still exactly `was` (same session, state and time). */
async function writeIfUnchanged(address, was, next) {
  const t = await fresh(address);
  const { rec } = parseRecord(t?.labels?.[LABEL]);
  if (!rec || rec.id !== was.id || rec.at !== was.at || rec.state !== was.state) return false;
  return writeLabel(address, next);
}

export default class SessionResume extends View {
  init(_props, cx) {
    this.dialog = Boolean(props()?.overlay);
    if (this.dialog) return this.initDialog(cx);
    this.boot = undefined;
    this.memory = {};
    this.exists = {};
    this.offers = [];
    this.watching = [];
    this.commands = [];
    this.toasted = new Set();
    this.resumed = 0;
    this.nextAutoAt = 0;
    this.seenRequest = null;
    if (checking()) return;
    cx.spawn(async (cx) => {
      for (;;) {
        this.commands.push(await nextCommand());
        cx.notify(); // also ends this loop once a newer build of the mod is loaded
      }
    });
    cx.spawn(async (cx) => {
      this.boot = await readBoot();
      for (;;) {
        try {
          await this.tick(cx);
        } catch (e) {
          console.log(`session-resume: ${e?.message ?? e}`);
        }
        await cx.sleep(TICK_MS);
      }
    });
  }

  // ---- engine ----------------------------------------------------------------

  ctx() {
    const now = Date.now();
    return {
      boot: this.boot,
      setting: shared(SETTING),
      exists: (p) => {
        const e = this.exists[p];
        return e && now - e.at < EXISTS_TTL_MS ? e.ok : undefined;
      },
    };
  }

  async checkPaths(paths) {
    if (!paths.length) return;
    let found = {};
    try {
      const r = await exec("/bin/sh", ["-c", EXISTS_SCRIPT, "sh", ...paths], { timeout: 5000 });
      found = parseExists(paths, r.stdout);
    } catch {
      // unknown counts as missing: nothing is typed on a guess
    }
    const at = Date.now();
    for (const p of paths) this.exists[p] = { ok: found[p] === true, at };
  }

  async tick(cx) {
    const before = this.offers.map((o) => o.address).join();
    // Terminals acted on in this tick: terminals() may not show their new label yet.
    this.acted = new Set();
    for (const c of this.commands.splice(0)) {
      if (c === "resume") await this.resume(cx, focused()?.terminal, true);
      else if (c === "offer") this.openDialog();
    }
    const req = freshRequest(shared(REQUEST), this.seenRequest, Date.now());
    if (req) {
      this.seenRequest = req.nonce;
      setShared(REQUEST, null);
      for (const item of req.items) await this.answer(cx, item);
    }
    await this.checkWatches();

    const list = terminals();
    const seen = observe(this.memory, list, this.boot, Date.now());
    this.memory = seen.memory;
    for (const q of seen.quits) await writeIfUnchanged(q.address, q.was, q.rec);

    let plan = planAll(list, this.ctx());
    if (plan.check.length) {
      await this.checkPaths(plan.check);
      plan = planAll(terminals(), this.ctx());
    }
    plan.auto = plan.auto.filter((o) => !this.acted.has(o.address));
    if (plan.auto.length && Date.now() >= this.nextAutoAt) {
      if (await this.resume(cx, plan.auto[0].address, false)) this.resumed += 1;
      this.nextAutoAt = Date.now() + GAP_MS;
    } else if (!plan.auto.length && this.resumed && !this.watching.length) {
      notify({ title: `Resumed ${this.resumed} agent session${this.resumed === 1 ? "" : "s"}`, level: "success", timeout: 4000 });
      this.resumed = 0;
    }
    this.offers = plan.offer.filter((o) => !this.acted.has(o.address));
    const unseen = this.offers.filter((o) => !this.toasted.has(`${o.address}:${o.pid}`));
    if (unseen.length) {
      for (const o of unseen) this.toasted.add(`${o.address}:${o.pid}`);
      const n = this.offers.length;
      notify({
        title: `Resume ${n} session${n === 1 ? "" : "s"}?`,
        body: "Agents that ran in these tabs before the restart are waiting. Click to choose.",
        level: "info",
        action: { name: "session-resume.offer" },
      });
    }
    if (this.offers.map((o) => o.address).join() !== before) cx.notify();
  }

  /** Types the resume command into one terminal. Returns true if it was typed. */
  async resume(cx, address, manual) {
    if (!address) {
      if (manual) notify({ title: "No terminal to resume", body: "Focus the terminal first.", level: "warning" });
      return false;
    }
    const why = (text) => {
      if (manual) notify({ title: "Not resumed", body: text, level: "warning" });
      return false;
    };
    const judge = (t) => (manual ? assessManual(t, this.ctx()) : assess(t, this.ctx()));
    const t = await fresh(address);
    if (!t) return why("Herdr couldn't read that terminal.");
    let a = judge(t);
    if (a.kind === "check") {
      await this.checkPaths(a.paths);
      a = judge(t);
    }
    if (a.kind !== (manual ? "manual" : "auto")) {
      const text = a.why ?? "this session can't be resumed here";
      return why(`${text[0].toUpperCase()}${text.slice(1)}.`);
    }

    // Claim this try; if another Herdr window claimed it meanwhile, leave it to that one.
    this.acted?.add(address);
    const claimed = markTried(a.rec, t, this.boot, nonce());
    if (!(await writeLabel(address, claimed))) return why("Herdr couldn't write the terminal's label.");
    await cx.sleep(CLAIM_MS);
    const t2 = await fresh(address);
    const { rec: back } = parseRecord(t2?.labels?.[LABEL]);
    if (!back || back.tried !== claimed.tried || t2.pid !== t.pid || !atBareShell(t2)) return false;

    const sent = await hc(["send", address, a.cmd]);
    if (sent.code !== 0) {
      notify({ title: "Couldn't type the resume command", body: (sent.stderr || sent.stdout).trim().slice(0, 300), level: "error" });
      return false;
    }
    const written = markResumed(claimed, t2, this.boot, Date.now());
    await writeLabel(address, written);
    this.watching.push({ address, pid: t2.pid, rec: written, deadline: Date.now() + WATCH_MS, auto: !manual });
    return true;
  }

  /** A resume whose shell is back in front at once, with no hook since, didn't take. */
  async checkWatches() {
    const keep = [];
    for (const w of this.watching) {
      const listed = terminals().find((x) => x.address === w.address);
      let verdict = judgeResume(listed, w, Date.now());
      if (verdict === "missing") verdict = judgeResume(await fresh(w.address), w, Date.now());
      if (verdict === "wait") keep.push(w);
      else if (verdict === "missing") {
        await writeIfUnchanged(w.address, w.rec, markMissing(w.rec, Date.now()));
        if (w.auto && this.resumed) this.resumed -= 1;
        notify({
          title: `${agentName(w.rec.agent)} session didn't come back`,
          body: `In ${placeOf(listed, spaces())} it exited at once (its history may be gone). The tab is at its shell.`,
          level: "warning",
        });
      }
    }
    this.watching = keep;
  }

  /** The dialog's Resume / Dismiss, checked against the terminal as it is now. */
  async answer(cx, item) {
    const t = terminals().find((x) => x.address === item.address);
    const { rec } = parseRecord(t?.labels?.[LABEL]);
    if (!t || t.pid !== item.pid || !rec || rec.id !== item.id) return;
    if (item.action === "resume") await this.resume(cx, item.address, true);
    else if (await writeIfUnchanged(item.address, rec, markDismissed(rec, t, this.boot, Date.now()))) this.acted?.add(item.address);
  }

  openDialog() {
    const offers = this.offers.map((o) => ({ address: o.address, pid: o.pid, rec: o.rec, cmd: o.cmd, bypass: o.bypass }));
    openOverlay({
      mod: "session-resume",
      kind: "dialog",
      width: 560,
      height: Math.min(620, 190 + Math.max(1, offers.length) * 96),
      props: { offers, boot: this.boot ?? null },
    });
  }

  // ---- dialog ----------------------------------------------------------------

  initDialog(cx) {
    this.done = new Set();
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(120, () => this.handle.focus());
  }

  ask(items) {
    for (const i of items) this.done.add(i.address);
    setShared(REQUEST, { nonce: nonce(), at: Date.now(), items });
  }

  renderDialog() {
    const t = theme();
    const p = props() ?? {};
    const list = terminals();
    const rows = (p.offers ?? []).filter((o) => !this.done.has(o.address) && stillOffered(o, list, p.boot));
    const item = (o, action) => ({ address: o.address, pid: o.pid, id: o.rec.id, action });
    const button = (id, label, solid, onClick) => h_flex().id(id).flex_none().h(28).px(12).items_center().rounded(7)
      .text_size(12).cursor_pointer().border_1()
      .border_color(solid ? t.solid : t.input).bg(solid ? t.solid : t.raised).text_color(solid ? t.solid_foreground : t.foreground)
      .hover((s) => s.opacity(0.88)).on_click(onClick).child(label);
    const choice = (agent) => {
      const current = choiceFor(shared(SETTING), agent);
      return h_flex().gap(6).items_center().text_size(12)
        .child(div().w(92).text_color(t.muted).child(agentName(agent)))
        .children(CHOICES.map((c) => h_flex().id(`set-${agent}-${c}`).h(24).px(9).items_center().rounded(6).cursor_pointer()
          .bg(c === current ? t.selected : t.raised).text_color(c === current ? t.foreground : t.muted)
          .on_click(() => {
            const s = shared(SETTING);
            const now = { ...DEFAULTS, ...(s && typeof s === "object" ? s : CHOICES.includes(s) ? { claude: s, codex: s } : {}) };
            setShared(SETTING, { ...now, [agent]: c });
          })
          .child(c === "auto" ? "Resume" : c === "ask" ? "Ask" : "Off")));
    };
    const row = (o) => {
      const text = offerText(o);
      const term = list.find((x) => x.address === o.address);
      return v_flex().gap(4).p(10).rounded(8).bg(t.surface).border_1().border_color(t.border)
        .child(h_flex().gap(8).items_center()
          .child(v_flex().flex_1().min_w(0)
            .child(div().truncate().text_size(13).font_semibold().text_color(t.foreground).child(`${placeOf(term, spaces())} · ${text.title}`))
            .child(div().truncate().text_size(11).text_color(t.dim).child(text.folder)))
          .child(button(`dismiss-${o.address}`, "Dismiss", false, () => this.ask([item(o, "dismiss")])))
          .child(button(`resume-${o.address}`, "Resume", true, () => this.ask([item(o, "resume")]))))
        .when(Boolean(text.why), (el) => el.child(div().text_size(11).text_color(o.bypass ? t.blocked : t.muted).child(text.why)));
    };
    return v_flex().id("session-resume-dialog").track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        closeOverlay(p.overlay);
        cx.stop_propagation();
      })
      .size_full().min_h(0).p(18).gap(12).bg(t.popover).text_size(13)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Resume agent sessions"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(v_flex().flex_1().min_h(0).gap(8).overflow_y_scrollbar()
        .when(rows.length === 0, (el) => el.child(div().text_color(t.muted).child("Nothing is waiting to be resumed.")))
        .children(rows.map(row)))
      .child(v_flex().gap(6).pt(8).border_t_1().border_color(t.border)
        .child(div().text_size(11).text_color(t.dim).child("After a restart"))
        .child(choice("claude"))
        .child(choice("codex")))
      .child(h_flex().justify_end().gap(8)
        .child(button("close", "Close", false, () => closeOverlay(p.overlay)))
        .when(rows.length > 1, (el) => el.child(button("resume-all", `Resume all ${rows.length}`, true,
          () => this.ask(rows.map((o) => item(o, "resume")))))));
  }

  // ---- view ------------------------------------------------------------------

  render() {
    if (this.dialog) return this.renderDialog();
    const n = this.offers?.length ?? 0;
    if (!n) return div(); // nothing waiting: the floating block hides
    const t = theme();
    return h_flex().id("session-resume-chip").h(26).px(10).gap(7).items_center().cursor_pointer()
      .text_size(12).text_color(t.foreground).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => this.openDialog())
      .child(div().size(7).rounded(4).bg(t.accent))
      .child(`Resume ${n} session${n === 1 ? "" : "s"}`);
  }
}
