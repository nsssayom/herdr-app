import { afterAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import { readFile } from "node:fs/promises";

// Exercise the shipped tab bar's wheel handler without a window or a core.
type Handler = (event: unknown) => void;
class Element {
  nodes: Element[] = [];
  calls: Record<string, unknown[]> = {};
  constructor() {
    const proxy: Element = new Proxy(this, {
      get: (target, key: string) => key in target ? Reflect.get(target, key) : (...args: unknown[]) => {
        if (key === "child") target.nodes.push(args[0] as Element);
        else if (key === "children") target.nodes.push(...(args[0] as Element[]));
        else if (key === "when") { if (args[0]) (args[1] as (el: Element) => void)(proxy); }
        else target.calls[key] = args;
        return proxy;
      },
    });
    return proxy;
  }
}
const source = await readFile(new URL("../defaults/mods/tabs/main.js", import.meta.url), "utf8");
const element = () => new Element();
const commands: string[] = [];
const store: Record<string, string> = {};
const values: Record<string, unknown> = {
  View: class {}, div: element, svg: element, image: element, h_flex: element,
  ScrollHandle: { new: () => ({ scroll_to_item() {} }) },
  spaces: () => [{ id: "s1", active: true, tabs: [{ id: "t1", name: "a" }, { id: "t2", name: "b", active: true }, { id: "t3", name: "c" }] }],
  panes: () => [], focused: () => null, run(command: string) { commands.push(command); }, exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  home: () => "/home/me", notify() {}, openOverlay() {}, theme: () => ({}),
  window: () => null, shared: () => null, layout: () => null, settings: () => ({ zoom: 1 }), drag: () => null,
  localStorage: { getItem: (key: string) => store[key] ?? null, setItem(key: string, value: string) { store[key] = value; } },
};
const Tabs = new Function(...Object.keys(values), source.replace(/^import .*;\n/gm, "").replace(/^export (?!default)/gm, "").replace("export default class Tabs", "return class Tabs"))(...Object.values(values));

let now = 1_000_000;
function wheel() {
  const view = new Tabs();
  view.init();
  // The mod is plain JS: its handler's shape is the documented ScrollWheelEvent listener.
  const handler = (view.render() as Element).calls.on_scroll_wheel[0] as Handler;
  return (y: number, touch_phase = "moved", lines?: number, ms = 8) => {
    now += ms;
    setSystemTime(new Date(now));
    handler({ delta: { x: 0, y }, delta_lines: lines === undefined ? undefined : { x: 0, y: lines }, touch_phase });
  };
}
beforeEach(() => { commands.length = 0; });
// Bun runs every test file in one process: give the later ones the real clock.
afterAll(() => setSystemTime());

test("a short touchpad swipe switches one tab", () => {
  const send = wheel();
  for (let i = 0; i < 12; i++) send(-6);
  expect(commands).toEqual(["tab.next"]);
});

test("a nudge below the threshold switches nothing", () => {
  const send = wheel();
  for (let i = 0; i < 3; i++) send(-5);
  expect(commands).toEqual([]);
});

test("each notch of a smooth-scrolling mouse switches one tab", () => {
  const send = wheel();
  // macOS smooths one notch into about 28 events of 1 px.
  for (let i = 0; i < 28; i++) send(-1, "moved", undefined, 10);
  send(-1, "moved", undefined, 700);
  for (let i = 0; i < 27; i++) send(-1, "moved", undefined, 10);
  expect(commands).toEqual(["tab.next", "tab.next"]);
});

test("a long swipe keeps switching, a tab per 60 px", () => {
  const send = wheel();
  // 20 px for the first tab, then 60 px each: 400 px is seven tabs.
  for (let i = 0; i < 40; i++) send(10, "moved", undefined, 40);
  expect(commands).toEqual(Array(7).fill("tab.prev"));
});

test("a fast flick shows each tab it passes for at least 100 ms", () => {
  const send = wheel();
  // 1200 px within 240 ms: enough for twenty tabs, time for three.
  for (let i = 0; i < 30; i++) send(-40);
  expect(commands).toEqual(["tab.next", "tab.next", "tab.next"]);
});

test("a pause or a turn starts a new gesture", () => {
  const send = wheel();
  for (let i = 0; i < 12; i++) send(-6);
  send(-30, "moved", undefined, 400);
  for (let i = 0; i < 4; i++) send(-5);
  for (let i = 0; i < 12; i++) send(6, "moved", undefined, 20);
  expect(commands).toEqual(["tab.next", "tab.next", "tab.prev"]);
});

test("each wheel notch switches one tab", () => {
  const send = wheel();
  send(-20, "moved", -1);
  send(-20, "moved", -1);
  send(2, "moved", 0.1);
  expect(commands).toEqual(["tab.next", "tab.next", "tab.prev"]);
});

const label = new Function("View", `${source.replace(/^import .*;\n/gm, "").replace(/^export (?!default)/gm, "").replace("export default class Tabs", "class Tabs")}; return label;`)(class {});

const claude = { program: { name: "Claude Code", key: "claude", agent: true }, title: "my-task" };

test("a tab Herdr named after its agent follows the agent's session title", () => {
  expect(label({ name: "Claude Code", named: true }, claude)).toBe("my-task");
  expect(label({ name: "", named: false }, claude)).toBe("my-task");
  expect(label({ name: "", named: false }, { ...claude, title: "✦ [web] login" })).toBe("[web] login");
  expect(label({ name: "Claude Code", named: true }, { ...claude, title: "renamed-task" })).toBe("renamed-task");
});

test("an empty OSC title published as the terminal address keeps the program label", () => {
  for (const terminal of ["t2", "remote/t2"]) {
    const lead = { ...claude, terminal, title: terminal };
    expect(label({ name: "2", named: false }, lead)).toBe("Claude Code");
    expect(label({ name: "Claude Code", named: true }, lead)).toBe("Claude Code");
    expect(label({ name: "fix login", named: true }, lead)).toBe("fix login");
    expect(label({ name: "2", named: false }, { ...lead, title: "renamed-task" })).toBe("renamed-task");
  }
});

test("a name the person gave stays", () => {
  expect(label({ name: "fix login", named: true }, claude)).toBe("fix login");
});

test("a title that says nothing new keeps the tab's own name", () => {
  expect(label({ name: "Claude Code", named: true }, { ...claude, title: "Claude Code" })).toBe("Claude Code");
  expect(label({ name: "Claude Code", named: true }, { ...claude, title: "me@build-box" })).toBe("Claude Code");
  expect(label({ name: "", named: false }, { ...claude, title: "" })).toBe("Claude Code");
  expect(label({ name: "", named: false }, { ...claude, title: "~/src/api" })).toBe("Claude Code");
  expect(label({ name: "", named: false }, { ...claude, title: "✦ /tmp" })).toBe("Claude Code");
});

test("a shell's title never replaces its tab's name", () => {
  const shell = { program: { name: "zsh", key: "zsh" }, title: "vim notes.md" };
  expect(label({ name: "", named: false }, shell)).toBe("zsh");
  expect(label({ name: "notes", named: true }, shell)).toBe("notes");
  expect(label({ name: "", named: false }, undefined)).toBe("Terminal");
});

// The Editor button: what it runs, with the platform's default or the person's choice.
type Pane = { pane: string; tab: string; cwd?: string };
function editorBar(opts: { platform?: string; editor?: unknown; machine?: string | null; panes?: Pane[]; focused?: unknown; exec?: (cmd: string, args: string[]) => Promise<unknown> } = {}) {
  const ran: [string, string[]][] = [], toasts: Record<string, unknown>[] = [], overlays: Record<string, any>[] = [], tasks: Promise<unknown>[] = [];
  const env: Record<string, unknown> = {
    View: class {}, div: element, svg: element, image: element, h_flex: element,
    ScrollHandle: { new: () => ({ scroll_to_item() {} }) },
    spaces: () => [{ id: "s1", name: "api", folder: "/made/here", machine: opts.machine ?? null, active: true, tabs: [{ id: "t1", name: "1", active: true }] }],
    panes: () => opts.panes ?? [{ pane: "p1", tab: "t1", cwd: "/work/My \"quoted\" folder's copy" }],
    focused: () => opts.focused ?? { pane: "p1" },
    run() {}, home: () => "/Users/me",
    exec: opts.exec ?? (async (cmd: string, args: string[]) => { ran.push([cmd, args]); return { code: 0, stdout: "", stderr: "" }; }),
    notify(n: Record<string, unknown>) { toasts.push(n); return "n1"; },
    openOverlay(o: Record<string, unknown>) { overlays.push(o); return "o1"; },
    theme: () => ({}), window: () => ({ platform: opts.platform ?? "macos", buttons: false }),
    shared: (key: string) => key === "workspace.editor" ? opts.editor ?? null : key === "workspace.panels" ? ["files"] : null,
    layout: () => null, settings: () => ({ zoom: 1 }), drag: () => null,
    localStorage: { getItem: () => null, setItem() {} },
  };
  const body = `${source.replace(/^import .*;\n/gm, "").replace(/^export (?!default)/gm, "").replace("export default class Tabs", "class Tabs")}; return { Tabs, editorArgv, workFolder, installedEditors, EDITORS };`;
  const mod = new Function(...Object.keys(env), body)(...Object.values(env));
  const view = new mod.Tabs();
  view.init();
  const find = (el: Element, id: string): Element | undefined => typeof el !== "object" ? undefined : el.calls.id?.[0] === id ? el : el.nodes.map(n => find(n, id)).find(Boolean);
  const button = () => find(view.render() as Element, "open-editor");
  let stopped = 0;
  const cx = { stop_propagation() { stopped++; }, spawn(fn: (cx: unknown) => Promise<unknown>) { tasks.push(fn(cx)); }, notify() {} };
  const click = async () => { (button()!.calls.on_click[0] as Function)({}, cx); await Promise.all(tasks); };
  const rightClick = async () => {
    const [button_, handler] = button()!.calls.on_mouse_down as [string, Function];
    expect(button_).toBe("right");
    handler({}, cx);
    await Promise.all(tasks);
  };
  return { mod, button, click, rightClick, ran, toasts, overlays, stopped: () => stopped };
}
const text = (el: Element): string => el.nodes.map(n => typeof n === "string" ? n : text(n)).join("");

test("the editor gets the folder as one argument, spaces and quotes intact", async () => {
  const bar = editorBar();
  const folder = "/work/My \"quoted\" folder's copy";
  expect(bar.mod.editorArgv(["open", "-a", "Visual Studio Code", "{folder}"], folder)).toEqual(["open", "-a", "Visual Studio Code", folder]);
  expect(bar.mod.editorArgv(["code", "--reuse-window"], "/a b")).toEqual(["code", "--reuse-window", "/a b"]);
  expect(bar.mod.editorArgv(["ed", "--root={folder}"], "/a b")).toEqual(["ed", "--root=/a b"]);
  await bar.click();
  expect(bar.ran).toEqual([["open", ["-a", "Visual Studio Code", folder]]]);
  expect(bar.toasts).toEqual([]);
});

test("unset, each platform opens VS Code its own way", async () => {
  const want: Record<string, [string, string[]]> = {
    macos: ["open", ["-a", "Visual Studio Code", "/w"]],
    linux: ["code", ["/w"]],
    windows: ["code.cmd", ["/w"]],
  };
  for (const [platform, argv] of Object.entries(want)) {
    const bar = editorBar({ platform, panes: [{ pane: "p1", tab: "t1", cwd: "/w" }] });
    expect(text(bar.button()!)).toBe("VS Code");
    await bar.click();
    expect(bar.ran).toEqual([argv]);
  }
});

test("a chosen editor is named on the button and run as configured", async () => {
  const bar = editorBar({ platform: "linux", editor: { name: "Zed", argv: ["zed", "--new", "{folder}"] }, panes: [{ pane: "p1", tab: "t1", cwd: "/w x" }] });
  expect(text(bar.button()!)).toBe("Zed");
  await bar.click();
  expect(bar.ran).toEqual([["zed", ["--new", "/w x"]]]);
  // Without a name: the app `open -a` opens, else the program's.
  expect(text(editorBar({ editor: { argv: ["open", "-a", "Nova", "{folder}"] } }).button()!)).toBe("Nova");
  expect(text(editorBar({ editor: { argv: ["/opt/bin/hx"] } }).button()!)).toBe("hx");
  // Not a launcher: the default.
  for (const editor of [{ argv: [] }, { argv: "zed" }, { argv: [1] }, "zed", { name: "x" }]) expect(text(editorBar({ editor }).button()!)).toBe("VS Code");
});

test("the folder is the focused pane's in the shown space, else where the space is", async () => {
  const panes = [{ pane: "p9", tab: "elsewhere", cwd: "/other/space" }, { pane: "p1", tab: "t1", cwd: "/first/terminal" }, { pane: "p2", tab: "t1", cwd: "/focused" }];
  const run = async (focused: unknown, ps: Pane[] = panes) => { const bar = editorBar({ focused, panes: ps }); await bar.click(); return bar.ran[0][1].at(-1); };
  expect(await run({ pane: "p2" })).toBe("/focused");
  expect(await run({ pane: "p9" })).toBe("/first/terminal");
  expect(await run(null)).toBe("/first/terminal");
  expect(await run({ pane: "p2" }, [{ pane: "p2", tab: "t1" }])).toBe("/made/here");
});

test("a space on another machine dims the button and opens nothing here", async () => {
  const bar = editorBar({ machine: "vehiclesec" });
  const b = bar.button()!;
  expect(String(b.calls.tooltip[0])).toContain("vehiclesec");
  expect(b.calls.hover).toBeUndefined();
  await bar.click();
  expect(bar.ran).toEqual([]);
  expect(bar.toasts).toEqual([]);
});

test("a failed launch shows why in an error toast", async () => {
  const missing = editorBar({ exec: async () => ({ code: 1, stdout: "", stderr: "Unable to find application named 'Visual Studio Code'\n" }) });
  await missing.click();
  expect(missing.toasts).toEqual([{ title: "Couldn't open VS Code", body: "Unable to find application named 'Visual Studio Code'", level: "error" }]);
  const absent = editorBar({ platform: "linux", exec: async () => { throw new Error("cannot run code: No such file or directory (os error 2)"); } });
  await absent.click();
  expect(absent.toasts[0]).toMatchObject({ level: "error", body: "code wasn't found. Right-click VS Code to choose another editor." });
  const silent = editorBar({ exec: async () => ({ code: 3, stdout: "", stderr: "" }) });
  await silent.click();
  expect(silent.toasts[0]).toMatchObject({ level: "error", body: "open exited with code 3." });
});

test("right-click offers the editors found here, with the default to go back to", async () => {
  const seen: [string, string[]][] = [];
  const bar = editorBar({ exec: async (cmd, args) => { seen.push([cmd, args]); return { code: 1, stdout: "Safari.app\nVisual Studio Code.app\nXcode.app\nZed.app\n", stderr: "ls: /Users/me/Applications: No such file or directory" }; } });
  await bar.rightClick();
  expect(seen).toEqual([["ls", ["-1", "/Applications", "/Users/me/Applications"]]]);
  expect(bar.overlays).toHaveLength(1);
  expect(bar.overlays[0]).toMatchObject({ mod: "editor-picker", kind: "popup" });
  expect(bar.overlays[0].props.editors.map((e: { name: string }) => e.name)).toEqual(["VS Code", "Zed", "Xcode"]);
  expect(bar.overlays[0].props.editors[1].argv).toEqual(["open", "-a", "Zed", "{folder}"]);
  expect(bar.overlays[0].props.fallback).toEqual({ name: "VS Code", argv: ["open", "-a", "Visual Studio Code", "{folder}"] });
  expect(bar.ran).toEqual([]);
  // A failed look still opens the menu (custom command, the current choice).
  const failing = editorBar({ exec: async () => { throw new Error("nope"); } });
  await failing.rightClick();
  expect(failing.overlays[0].props.editors).toEqual([]);
});

test("editors are looked for without a shell string: Linux names them as arguments, Windows asks where", async () => {
  const { installedEditors } = editorBar().mod;
  const calls: [string, string[]][] = [];
  const linux = await installedEditors("linux", async (cmd: string, args: string[]) => { calls.push([cmd, args]); return { code: 0, stdout: "code\nzeditor\n", stderr: "" }; });
  expect(calls[0][0]).toBe("sh");
  expect(calls[0][1].slice(3)).toEqual(["code", "cursor", "windsurf", "zed", "zeditor", "subl"]);
  expect(linux).toEqual([{ name: "VS Code", argv: ["code", "{folder}"] }, { name: "Zed", argv: ["zeditor", "{folder}"] }]);
  const windows = await installedEditors("windows", async () => ({ code: 1, stdout: "C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd\r\n", stderr: "INFO: Could not find files" }));
  expect(windows).toEqual([{ name: "VS Code", argv: ["code.cmd", "{folder}"] }]);
});

// The chooser it opens.
const pickerSource = (await readFile(new URL("../defaults/mods/editor-picker/main.js", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "").replace(/^export (?!default)/gm, "").replace("export default class EditorPicker", "class EditorPicker");
function picker(p: Record<string, unknown>, editor: unknown = null) {
  const store: Record<string, unknown> = { "workspace.editor": editor }, closed: string[] = [];
  let value = "";
  const input = { on() {}, focus() {}, set_value(v: string) { value = v; }, value: () => value };
  const env: Record<string, unknown> = {
    View: class {}, div: element, svg: element, v_flex: element, h_flex: element,
    InputState: { new: () => input }, Input: { new: element },
    props: () => ({ overlay: "o1", ...p }), closeOverlay(id: string) { closed.push(id); }, theme: () => ({}),
    shared: (k: string) => store[k] ?? null, setShared(k: string, v: unknown) { store[k] = v; },
  };
  const mod = new Function(...Object.keys(env), `${pickerSource}; return { EditorPicker, parseCommand, formatCommand, commandName };`)(...Object.values(env));
  const view = new mod.EditorPicker();
  view.init({}, { focus_handle: () => ({ focus() {} }) });
  const cx = { notify() {} };
  return { mod, view, store, closed, cx, type(v: string) { value = v; } };
}
const vscode = { name: "VS Code", argv: ["open", "-a", "Visual Studio Code", "{folder}"] };
const zed = { name: "Zed", argv: ["open", "-a", "Zed", "{folder}"] };

test("picking an editor saves it; picking the default clears the choice", () => {
  const p = picker({ editors: [vscode, zed], fallback: vscode });
  expect(p.view.entries().map((e: { name: string }) => e.name)).toEqual(["VS Code", "Zed"]);
  p.view.pick(zed);
  expect(p.store["workspace.editor"]).toEqual(zed);
  expect(p.closed).toEqual(["o1"]);
  const back = picker({ editors: [vscode, zed], fallback: vscode }, zed);
  back.view.pick(vscode);
  expect(back.store["workspace.editor"]).toBeNull();
});

test("a custom choice not found here stays listed first", () => {
  const helix = { name: "hx", argv: ["hx", "{folder}"] };
  const p = picker({ editors: [vscode, zed], fallback: vscode }, helix);
  expect(p.view.entries()).toEqual([helix, vscode, zed]);
});

test("a typed command becomes argv without a shell, quotes keeping spaces", () => {
  const { parseCommand, formatCommand, commandName } = picker({}).mod;
  expect(parseCommand(`open -a "Sublime Text" {folder}`)).toEqual(["open", "-a", "Sublime Text", "{folder}"]);
  expect(parseCommand(`  "C:\\Program Files\\Zed\\zed.exe"   '{folder}' --x="a b" `)).toEqual(["C:\\Program Files\\Zed\\zed.exe", "{folder}", "--x=a b"]);
  expect(parseCommand(`code "" {folder}`)).toEqual(["code", "", "{folder}"]);
  for (const argv of [["open", "-a", "Sublime Text", "{folder}"], ["say", `it's "x"`], ["say", `"it's"`], ["e", ""]]) expect(parseCommand(formatCommand(argv))).toEqual(argv);
  expect(commandName(["open", "-a", "Sublime Text", "{folder}"])).toBe("Sublime Text");
  expect(commandName(["C:\\Tools\\zed.exe", "{folder}"])).toBe("zed");
  const p = picker({ fallback: vscode });
  p.view.openCustom(p.cx);
  p.type(`"/opt/my editor/bin/ed" --open {folder}`);
  p.view.save();
  expect(p.store["workspace.editor"]).toEqual({ name: "ed", argv: ["/opt/my editor/bin/ed", "--open", "{folder}"] });
  const empty = picker({ fallback: vscode });
  empty.view.openCustom(empty.cx);
  empty.type("   ");
  empty.view.save();
  expect(empty.view.error).toBeTruthy();
  expect(empty.closed).toEqual([]);
});

// Dragging: Herdr runs the drag; the bar marks what can be dragged and where it can drop.
function dragBar(drag: unknown = null) {
  const ran: [string, unknown][] = [];
  const env: Record<string, unknown> = {
    ...values, run(command: string, args: unknown) { ran.push([command, args]); }, drag: () => drag,
    spaces: () => [{ id: "s1", active: true, tabs: [{ id: "t1", name: "a" }, { id: "t2", name: "b", active: true }, { id: "t3", name: "c" }] }],
    theme: () => new Proxy({}, { get: (_, k) => String(k) }),
  };
  const mod = new Function(...Object.keys(env), source.replace(/^import .*;\n/gm, "").replace(/^export (?!default)/gm, "").replace("export default class Tabs", "return class Tabs"))(...Object.values(env));
  const view = new mod();
  view.init();
  const root = view.render() as Element;
  const find = (el: Element, id: string): Element | undefined => typeof el !== "object" ? undefined : el.calls.id?.[0] === id ? el : el.nodes.map(n => find(n, id)).find(Boolean);
  return { root, ran, view, find: (id: string) => find(root, id)! };
}
const cx = { stop_propagation() {}, notify() {} };

test("tabs are drag sources and targets; the bar's end and + make a new tab", () => {
  const bar = dragBar();
  for (const id of ["t1", "t2", "t3"]) {
    expect(bar.find(`tab-${id}`).calls.drag_move).toEqual([{ tab: id }]);
    expect(bar.find(`tab-${id}`).calls.drop_move).toEqual([{ tab: id }]);
  }
  expect(bar.find("tab-scroll").calls.drop_move).toEqual([{ tab: "new" }]);
  expect(bar.find("tab-new").calls.drop_move).toEqual([{ tab: "new" }]);
});

test("a click selects; a press released on another tab without a drag moves nothing", () => {
  const bar = dragBar();
  const down = (id: string) => (bar.find(`tab-${id}`).calls.on_mouse_down as any[]);
  const up = (id: string) => (bar.find(`tab-${id}`).calls.on_mouse_up[1] as Function)({}, cx);
  // on_mouse_down's last registration is the right-click menu: press through the view's own state.
  expect(down("t1")[0]).toBe("right");
  bar.view.pressed = 0;
  up("t1");
  expect(bar.ran).toEqual([["tab.select", { id: "t1" }]]);
  bar.ran.length = 0;
  // Herdr took the drag past 4 px and runs the move itself: the bar adds no second one.
  bar.view.pressed = 0;
  up("t3");
  expect(bar.ran).toEqual([]);
});

test("a dragged tab fades and the tab it's over shows the side it lands on", () => {
  const right = dragBar({ tab: "t1", space: "s1", machine: null, over: { tab: "t3" }, valid: true });
  expect(right.find("tab-t1").calls.opacity).toEqual([0.5]);
  const line = right.find("tab-t3").nodes.find(n => typeof n === "object" && n.calls.w?.[0] === 2)!;
  expect(line.calls.right).toEqual([-3]);
  const left = dragBar({ tab: "t3", space: "s1", machine: null, over: { tab: "t1" }, valid: true });
  expect(left.find("tab-t1").nodes.find(n => typeof n === "object" && n.calls.w?.[0] === 2)!.calls.left).toEqual([-3]);
  // Not a place it can go: nothing lit.
  const refused = dragBar({ tab: "t1", space: "s1", machine: null, over: { tab: "t3" }, valid: false });
  expect(refused.find("tab-t3").nodes.some(n => typeof n === "object" && n.calls.w?.[0] === 2)).toBe(false);
});

test("a pane over a tab lights it; over the bar's end a New tab slot appears", () => {
  const into = dragBar({ pane: "p4", tab: "t2", space: "s1", machine: null, over: { tab: "t3" }, valid: true });
  expect(into.find("tab-t3").calls.border_color).toEqual(["accent"]);
  expect(into.find("tab-t2").calls.opacity).toBeUndefined();
  const out = dragBar({ pane: "p4", tab: "t2", space: "s1", machine: null, over: { tab: "new" }, valid: true });
  expect(text(out.find("tab-drop-new"))).toBe("New tab");
  expect(out.find("tab-new").calls.bg).toEqual(["selected"]);
  expect(dragBar({ pane: "p4", tab: "t2", space: "s1", machine: null, over: { tab: "new" }, valid: false }).find("tab-drop-new")).toBeUndefined();
  expect(dragBar().find("tab-drop-new")).toBeUndefined();
});
