import { View, div, svg, image } from "gpui-kit";
import { h_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, focused, run, exec, home, notify, openOverlay, theme, window, shared, layout, settings, drag } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Same as the agents mod: drops a status glyph, keeps a leading bracket or quote.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(/^\[ [!.] \] /, "").trim();

// A tab Herdr named (unnamed, or after its program) follows its agent's live
// title, as the agents list does; a name the person gave stays.
function label(tab, lead) {
  const prog = lead?.program?.name;
  const base = tab.named ? tab.name : prog ?? "Terminal";
  if (!lead?.program?.agent) return base;
  const live = clean(lead.title);
  // clean() would strip a path's leading ~ or /: test the title with only its status glyph gone.
  const path = /^[~/]|^[A-Za-z]:\\/.test((lead.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== lead.terminal && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== lead.program.key;
  return (tab.name === prog || !tab.named) && telling ? live : base;
}

// The Editor button opens the folder you're working in with an editor app. Which one:
// shared "workspace.editor", {name, argv} ("{folder}" in argv is the folder, else it goes
// last; run without a shell), chosen from the button's right-click menu (editor-picker);
// unset, VS Code. On macOS by app, so VS Code's `code` command needn't be installed.
// The menu offers the editors below that this computer has; the first is the default.
const app = (name, file = name) => ({ name, app: `${file}.app`, argv: ["open", "-a", file, "{folder}"] });
const bin = (name, command) => ({ name, bin: command, argv: [command, "{folder}"] });
export const EDITORS = {
  macos: [app("VS Code", "Visual Studio Code"), app("Cursor"), app("Windsurf"), app("Zed"), app("Sublime Text"), app("Xcode"),
    app("IntelliJ IDEA"), app("IntelliJ IDEA CE"), app("PyCharm"), app("PyCharm CE"), app("WebStorm"), app("RustRover"),
    app("CLion"), app("GoLand"), app("Android Studio")],
  linux: [bin("VS Code", "code"), bin("Cursor", "cursor"), bin("Windsurf", "windsurf"), bin("Zed", "zed"), bin("Zed", "zeditor"), bin("Sublime Text", "subl")],
  // .cmd launchers return at once; the editors' own .exe would stay running.
  windows: [bin("VS Code", "code.cmd"), bin("Cursor", "cursor.cmd"), bin("Windsurf", "windsurf.cmd"), bin("Zed", "zed.exe"), bin("Sublime Text", "subl.exe")],
};
const fallback = (platform) => {
  const { name, argv } = (EDITORS[platform] ?? EDITORS.linux)[0];
  return { name, argv };
};

export function editor(platform) {
  const own = shared("workspace.editor");
  const argv = own?.argv;
  if (Array.isArray(argv) && argv.length && argv.every(a => typeof a === "string") && argv[0].trim()) {
    const named = typeof own.name === "string" && own.name.trim();
    return { name: named || (argv[0] === "open" && argv[1] === "-a" && argv[2] ? argv[2] : argv[0].split(/[\\/]/).pop()), argv };
  }
  return fallback(platform);
}

// Which of EDITORS this computer has: one look, never through a shell string.
export async function installedEditors(platform, run = exec, where = home()) {
  const list = EDITORS[platform] ?? EDITORS.linux;
  const found = (have) => list.filter(e => have.has(e.app ?? e.bin)).map(({ name, argv }) => ({ name, argv }));
  if (platform === "macos") {
    // ls prints what it can list even when ~/Applications is missing (and exits 1).
    const r = await run("ls", ["-1", "/Applications", `${where}/Applications`]);
    return found(new Set(r.stdout.split("\n").map(s => s.trim())));
  }
  if (platform === "windows") {
    const r = await run("where", list.map(e => e.bin));
    const have = new Set(r.stdout.split(/\r?\n/).map(s => s.trim().split(/[\\/]/).pop().toLowerCase()));
    return list.filter(e => have.has(e.bin.toLowerCase())).map(({ name, argv }) => ({ name, argv }));
  }
  const r = await run("sh", ["-c", 'for c do command -v "$c" >/dev/null 2>&1 && printf "%s\\n" "$c"; done', "sh", ...list.map(e => e.bin)]);
  return found(new Set(r.stdout.split("\n").map(s => s.trim())));
}

export function editorArgv(argv, folder) {
  const out = argv.map(a => a.split("{folder}").join(folder));
  return argv.some(a => a.includes("{folder}")) ? out : [...out, folder];
}

// Where you're working: the focused pane's live folder when it's in the shown space,
// else where the space is (its first terminal's folder, as the menu's place()).
export function workFolder(space, f, ps) {
  const tabs = new Set((space?.tabs ?? []).map(c => c.id));
  const pane = f?.pane ? ps.find(p => p.pane === f.pane && tabs.has(p.tab)) : null;
  return pane?.cwd || ps.find(p => tabs.has(p.tab) && p.cwd)?.cwd || space?.folder || null;
}

export default class Tabs extends View {
  init() {
    this.pressed = null;
    this.scroll = ScrollHandle.new();
    try { this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}"); } catch { this.panels = {}; }
    if (!this.panels || typeof this.panels !== "object" || Array.isArray(this.panels)) this.panels = {};
    this.swipe = { acc: 0, steps: 0, at: 0, last: 0 };
  }

  // One tab per wheel notch. A touchpad or smooth-scrolling mouse sends many
  // small events per gesture: a short swipe or one smoothed notch (about
  // 25 px) switches one tab, a longer swipe keeps going a tab per 60 px, at
  // most one every 100 ms so each shows.
  wheel(e) {
    if (e.delta_lines) {
      if (e.delta_lines.y) run(e.delta_lines.y > 0 ? "tab.prev" : "tab.next");
      return;
    }
    const s = this.swipe, now = Date.now();
    // Phases often arrive only as moves (a macOS touchpad included): a pause
    // or a turn starts a new gesture.
    if (e.touch_phase === "started" || now - s.at > 250 || e.delta.y * s.acc < 0) Object.assign(s, { acc: 0, steps: 0 });
    s.at = now;
    s.acc += e.delta.y;
    const need = s.steps ? 60 : 20;
    if (Math.abs(s.acc) < need || now - s.last < 100) return;
    s.acc -= Math.sign(s.acc) * need;
    s.steps++;
    s.last = now;
    run(e.delta.y > 0 ? "tab.prev" : "tab.next");
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  openEditor(space, tool, cx) {
    const folder = workFolder(space, focused(), panes());
    const failed = (body) => notify({ title: `Couldn't open ${tool.name}`, body, level: "error" });
    if (!folder) return failed(`${space.name} has no folder yet.`);
    const [command, ...args] = editorArgv(tool.argv, folder);
    cx.spawn(async () => {
      try {
        const r = await exec(command, args);
        if (r.code !== 0) failed((r.stderr || r.stdout).trim().split("\n").pop() || `${command} exited with code ${r.code}.`);
      } catch (e) {
        const why = String(e?.message ?? e);
        failed(why.startsWith("cannot run") ? `${command} wasn't found. Right-click ${tool.name} to choose another editor.` : why);
      }
    });
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const active = shown.findIndex(tab => tab.active);
    const selected = shown[active]?.id;
    if (selected !== this.selected || active !== this.selectedIndex) {
      this.selected = selected;
      this.selectedIndex = active;
      if (active >= 0) this.scroll.scroll_to_item(active);
    }
    const stop = (_e, cx) => cx.stop_propagation();
    // A tab or pane being dragged (Herdr runs the drag and the drop): light the place it would go.
    const d = drag();
    const dragged = d && !d.pane ? d.tab : null;
    const overNew = d?.over?.tab === "new" && !d.over.space;
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const lead = panes().find(p => p.tab === c.id && p.program?.agent) ?? panes().find(p => p.tab === c.id);
      const program = lead?.program;
      const name = label(c, lead);
      const over = d?.over?.tab === c.id && !d.over.space && d.valid;
      const from = dragged ? shown.findIndex(x => x.id === dragged) : -1;
      return h_flex().id(`tab-${c.id}`).relative().h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        // A rename or status dot on this or an earlier tab can push the active one out.
        .when(i <= active, el => el.on_size_change((_size, cx) => { this.scroll.scroll_to_item(active); cx.notify(); }))
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        // Dragged past 4 px it's Herdr's: onto another tab (there), a space, or the panes (a split).
        .drag_move({ tab: c.id }).drop_move({ tab: c.id })
        .when(dragged === c.id, el => el.opacity(0.5))
        // A tab dropped here takes this one's place: the line shows which side it lands.
        .when(over && dragged && from !== i, el => el.child(div().absolute().top(4).bottom(4).w(2).rounded(1).bg(t.accent)
          .when(from < i, line => line.right(-3)).when(from > i, line => line.left(-3))))
        // A pane dropped here goes into this tab (held a moment, the tab shows).
        .when(over && Boolean(d.pane), el => el.border_color(t.accent).bg(t.selected))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from === i) run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label);
    };
    const platform = w?.platform ?? "linux";
    const editorButton = () => {
      const tool = editor(platform);
      // A space on another machine has its folders there: an editor here can't open them.
      const away = space.machine;
      // The menu lists the editors found here: looked for on each opening (one quick run).
      const choose = (_e, cx) => {
        cx.stop_propagation();
        cx.spawn(async () => {
          const editors = await installedEditors(platform).catch(() => []);
          openOverlay({ mod: "editor-picker", kind: "popup", width: 260, height: 420, props: { editors, fallback: fallback(platform) } });
        });
      };
      return h_flex().id("open-editor").h(26).px(8).gap(5).flex_none().items_center().rounded(6).text_size(12).bg(t.chrome)
        .text_color(away ? t.dim : t.muted)
        .when(!away, el => el.hover(s => s.bg(t.hover)).active(s => s.bg(t.selected)))
        .tooltip(away ? `${space.name} is on ${away}: its folders aren't on this computer, so an editor here can't open them.` : `Open this folder in ${tool.name}. Right-click to choose the editor.`)
        .on_mouse_down("left", stop).on_mouse_down("right", choose)
        .on_click((_e, cx) => { if (!away) this.openEditor(space, tool, cx); })
        .child(svg("mods/tabs/code.svg").size(14)).child(div().max_w(110).truncate().child(tool.name));
    };
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => this.wheel(e))
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().track_scroll(this.scroll)
        .on_size_change((_size, cx) => { if (active >= 0) { this.scroll.scroll_to_item(active); cx.notify(); } })
        .drop_move({ tab: "new" })
        .children(shown.map(item))
        // The bar's empty end: a pane goes out into a new tab, a tab goes last.
        .when(overNew && d.valid, el => el.child(d.pane
          ? h_flex().id("tab-drop-new").h(29).px(10).gap(6).rounded(7).items_center().flex_none().text_size(12.8)
            .border(1).border_color(t.accent).bg(t.selected).text_color(t.foreground)
            .child(svg("mods/workspace-chrome/plus.svg").size(12)).child("New tab")
          : div().w(2).h(21).rounded(1).flex_none().bg(t.accent))))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })).drop_move({ tab: "new" })
        .when(overNew && d.valid, el => el.bg(t.selected).text_color(t.foreground)))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .when(Boolean(space), el => el.child(editorButton()))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
