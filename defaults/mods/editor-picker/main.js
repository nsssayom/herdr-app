// Chooses the editor the tab bar's Editor button opens folders with: the editors
// found on this computer, or a command of your own. Opened as a popup by the tabs
// mod with props { editors: [{name, argv}] (found here), fallback: {name, argv} (the
// platform's default, VS Code) }. Saves shared "workspace.editor" = {name, argv};
// "{folder}" in argv is the folder (else it goes last), run without a shell.
// null: back to the default.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, theme, shared, setShared } from "herdr";

// A command line typed by the person, as argv: words split on spaces, "double" or
// 'single' quotes keep spaces together. No escapes: Windows paths keep their backslashes.
export function parseCommand(text) {
  const argv = [];
  let word = null, quote = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      word ??= "";
    } else if (/\s/.test(ch)) {
      if (word !== null) argv.push(word);
      word = null;
    } else word = (word ?? "") + ch;
  }
  if (word !== null) argv.push(word);
  return argv;
}

// The other way: each word quoted only as much as it needs (both quotes: in turns).
export function formatCommand(argv) {
  const quote = (a) => {
    if (a && !/[\s"']/.test(a)) return a;
    if (!a.includes('"')) return `"${a}"`;
    if (!a.includes("'")) return `'${a}'`;
    return a.split(/("+)/).filter(Boolean).map(part => part.startsWith('"') ? `'${part}'` : `"${part}"`).join("");
  };
  return argv.map(quote).join(" ");
}

// What to call a command: the app `open -a` opens, else its program's name.
export function commandName(argv) {
  if (argv[0] === "open" && argv[1] === "-a" && argv[2]) return argv[2].replace(/\.app$/, "");
  return argv[0].split(/[\\/]/).pop().replace(/\.(exe|cmd|bat|app)$/i, "");
}

const MOST = 8;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export default class EditorPicker extends View {
  init(_props, cx) {
    this.at = null; // the highlighted row; null: the current choice's
    this.custom = false;
    this.error = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.input = InputState.new({ placeholder: "zed {folder}" });
    this.input.on("submit", (_e, cx) => { this.save(); cx.notify(); });
  }

  // What the tab bar opens when nothing is chosen (VS Code).
  fallback() {
    return props()?.fallback ?? { name: "VS Code", argv: ["code", "{folder}"] };
  }

  current() {
    const own = shared("workspace.editor");
    return Array.isArray(own?.argv) && own.argv.length ? { name: own.name || commandName(own.argv), argv: own.argv } : this.fallback();
  }

  // The current choice first when it isn't one found here, then what was found.
  entries() {
    const current = this.current(), found = (props()?.editors ?? []).filter(e => Array.isArray(e?.argv) && e.argv.length).slice(0, MOST);
    const list = found.some(e => same(e.argv, current.argv)) ? found : [current, ...found];
    return list.filter((e, i) => list.findIndex(x => same(x.argv, e.argv)) === i);
  }

  pick(entry) {
    setShared("workspace.editor", same(entry.argv, this.fallback().argv) ? null : { name: entry.name, argv: entry.argv });
    closeOverlay(props()?.overlay);
  }

  openCustom(cx) {
    this.custom = true;
    this.error = null;
    const current = this.current();
    this.input.set_value(same(current.argv, this.fallback().argv) ? "" : formatCommand(current.argv));
    this.input.focus();
    cx.notify();
  }

  save() {
    const argv = parseCommand(this.input.value());
    if (!argv.length) {
      this.error = "Type the command that opens a folder, such as zed {folder}.";
      return;
    }
    this.pick({ name: commandName(argv), argv });
  }

  render() {
    const t = theme();
    const list = this.entries();
    const count = list.length + 1;
    const current = this.current();
    const at = this.at ?? Math.max(0, list.findIndex(e => same(e.argv, current.argv)));
    const row = (id, i, icon, label, on, action) => h_flex().id(id).h(31).px(8).gap(9).rounded(7).items_center()
      .text_color(t.foreground)
      .when(i === at && !this.custom, el => el.bg(t.selected))
      .hover(s => s.bg(t.hover))
      .on_click(action)
      .child(svg(icon).size(14).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().child(label))
      .when(on, el => el.child(svg("mods/workspace-chrome/check.svg").size(13).flex_none().text_color(t.accent)));
    return v_flex()
      .id("editor-picker")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { closeOverlay(props()?.overlay); return; }
        if (this.custom) return;
        if (e.key === "down") this.at = (at + 1) % count;
        else if (e.key === "up") this.at = (at + count - 1) % count;
        else if (e.key === "enter") { if (at < list.length) this.pick(list[at]); else this.openCustom(cx); }
        else return;
        cx.notify();
      })
      .child(div().px(8).pt(4).pb(5).text_size(11.5).text_color(t.dim).child("Open folders with"))
      .children(list.map((e, i) => row(`editor-${i}`, i, "mods/tabs/code.svg", e.name, same(e.argv, current.argv), () => this.pick(e))))
      .child(div().mx(7).my(4).h(1).bg(t.border))
      .child(row("editor-custom", list.length, "mods/workspace-chrome/square-pen.svg", "Custom command…", false, (_e, cx) => this.openCustom(cx)))
      .when(this.custom, el => el.child(v_flex().px(8).pt(4).pb(4).gap(6)
        .child(Input.new(this.input).h(32).px(9).rounded(8).border_1().border_color(t.accent).bg(t.background).text_size(12.5).text_color(t.foreground))
        .child(div().text_size(11).text_color(this.error ? t.blocked : t.dim)
          .child(this.error ?? "{folder} is replaced by the folder. Runs without a shell; quote words with spaces."))
        .child(h_flex().justify_end()
          .child(h_flex().id("editor-save").h(28).px(12).items_center().rounded(7).bg(t.solid).text_color(t.solid_foreground)
            .text_size(12).font_medium().cursor_pointer().hover(s => s.opacity(0.88))
            .on_click((_e, cx) => { this.save(); cx.notify(); }).child("Save")))));
  }
}
