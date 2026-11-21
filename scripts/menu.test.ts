import { beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

// Exercise the shipped context menu's items, clicks and keys without a window or a core.
class Element {
  nodes: unknown[] = [];
  calls: Record<string, unknown[]> = {};
  constructor(...args: unknown[]) {
    this.calls.new = args;
    const proxy: Element = new Proxy(this, {
      get: (target, key: string) => key in target ? Reflect.get(target, key) : (...args: unknown[]) => {
        if (key === "child") target.nodes.push(args[0]);
        else if (key === "children") target.nodes.push(...(args[0] as unknown[]));
        else if (key === "when") { if (args[0]) (args[1] as (el: Element) => void)(proxy); }
        else target.calls[key] = args;
        return proxy;
      },
    });
    return proxy;
  }
}
const source = await readFile(new URL("../defaults/mods/menu/main.js", import.meta.url), "utf8");
const element = (...args: unknown[]) => new Element(...args);

type Tab = { id: string; active?: boolean };
type Space = { id: string; name: string; machine: string | null; active?: boolean; tabs: Tab[] };
const state: { spaces: Space[]; panes: { pane: string; tab: string }[]; keys: { section: string; keys: string; action: string }[]; props: Record<string, unknown> } =
  { spaces: [], panes: [], keys: [], props: {} };
const ran: [string, unknown][] = [];
const opened: Record<string, any>[] = [];
const closed: unknown[] = [];
const values: Record<string, unknown> = {
  View: class {}, div: element, svg: element, v_flex: element, h_flex: element,
  run(name: string, args: unknown) { ran.push([name, args]); return null; },
  props: () => state.props, closeOverlay(id: unknown) { closed.push(id); }, openOverlay(spec: Record<string, any>) { opened.push(spec); return "o2"; },
  theme: () => ({}), keys: () => state.keys, terminals: () => [], spaces: () => state.spaces, panes: () => state.panes,
  exec: async () => ({ code: 1, stdout: "", stderr: "" }),
};
const Menu = new Function(...Object.keys(values), source.replace(/^import .*;\n/gm, "").replace("export default class Menu", "return class Menu"))(...Object.values(values));
const cx = { focus_handle: () => ({ focus() {} }), spawn() {}, notify() {} };

// The menu as drawn: each row's label, icon, hint, the line above it, and its click.
function open(props: Record<string, unknown>) {
  state.props = { overlay: "o1", ...props };
  const view = new Menu();
  view.init(state.props, cx);
  const draw = () => {
    const root = view.render(cx) as Element;
    const rows = (root.nodes as Element[]).map((item) => {
      const row = item.nodes.at(-1) as Element;
      const [icon, label, hint] = row.nodes as Element[];
      return { label: label.nodes[0] as string, icon: icon.calls.new[0] as string, hint: hint.nodes[0] as string, line: item.nodes.length > 1, click: () => (row.calls.on_click[0] as (e: unknown, c: unknown) => void)(null, cx) };
    });
    const key = (k: string) => (root.calls.on_key_down[0] as (e: unknown, c: unknown) => void)({ key: k }, cx);
    return { rows, labels: rows.map((r) => r.label), key };
  };
  return draw;
}
const row = (draw: ReturnType<typeof open>, label: string) => {
  const found = draw().rows.find((r) => r.label === label);
  if (!found) throw new Error(`no ${label}`);
  return found;
};

beforeEach(() => {
  ran.length = 0; opened.length = 0; closed.length = 0; state.keys = [];
  state.spaces = [
    { id: "s1", name: "api", machine: null, active: true, tabs: [{ id: "t1" }, { id: "t2", active: true }] },
    { id: "s2", name: "web", machine: null, tabs: [{ id: "t3", active: true }] },
    { id: "vps/s3", name: "box", machine: "vps", tabs: [{ id: "vps/t4", active: true }] },
    { id: "vps/s4", name: "logs", machine: "vps", tabs: [{ id: "vps/t5", active: true }] },
  ];
  state.panes = [{ pane: "p1", tab: "t1" }, { pane: "p2", tab: "t2" }, { pane: "p3", tab: "t2" }, { pane: "p4", tab: "t3" }];
});

test("a tab elsewhere can move to another space or join the shown tab", () => {
  const draw = open({ tab: "tab", target: { id: "t1", space: "s1" } });
  expect(draw().labels).toEqual(["Rename", "New tab", "Move to space…", "Move beside current tab", "Move below current tab", "Close"]);
  // The moves are a group of their own.
  expect(draw().rows.map((r) => r.line)).toEqual([false, false, true, false, false, true]);
  row(draw, "Move beside current tab").click();
  row(draw, "Move below current tab").click();
  expect(ran).toEqual([["tab.join", { id: "t1", direction: "right" }], ["tab.join", { id: "t1", direction: "down" }]]);
});

test("the shown tab can't join itself", () => {
  const draw = open({ tab: "tab", target: { id: "t2", space: "s1" } });
  expect(draw().labels).toEqual(["Rename", "New tab", "Move to space…", "Close"]);
});

test("a tab in another shown space's tab bar joins the shown tab too", () => {
  const draw = open({ tab: "tab", target: { id: "t3", space: "s2" } });
  expect(draw().labels).toContain("Move beside current tab");
});

test("with one space there is nowhere to move a tab", () => {
  state.spaces = [state.spaces[0]];
  expect(open({ tab: "tab", target: { id: "t1", space: "s1" } })().labels).toEqual(["Rename", "New tab", "Move beside current tab", "Move below current tab", "Close"]);
  expect(open({ tab: "tab", target: { id: "t2", space: "s1" } })().labels).toEqual(["Rename", "New tab", "Close"]);
});

test("a tab on another machine moves only among that machine's spaces and doesn't join a local tab", () => {
  const draw = open({ tab: "tab", target: { id: "vps/t4", space: "vps/s3" } });
  expect(draw().labels).toEqual(["Rename", "New tab", "Move to space…", "Close"]);
  row(draw, "Move to space…").click();
  expect(opened[0].props).toEqual({ tab: "move-tab", target: { id: "vps/t4", space: "vps/s3" } });
  expect(open(opened[0].props)().labels).toEqual(["logs"]);
  // Alone on its machine: nowhere to go.
  state.spaces = state.spaces.slice(0, 3);
  expect(open({ tab: "tab", target: { id: "vps/t4", space: "vps/s3" } })().labels).toEqual(["Rename", "New tab", "Close"]);
});

test("Move to space… opens a second menu of this machine's other spaces by name", () => {
  const draw = open({ tab: "tab", target: { id: "t1", space: "s1" } });
  row(draw, "Move to space…").click();
  expect(closed).toEqual(["o1"]);
  expect(ran).toEqual([]);
  expect(opened).toEqual([{ mod: "menu", kind: "popup", width: 200, props: { tab: "move-tab", target: { id: "t1", space: "s1" } } }]);
  state.spaces.push({ id: "s5", name: "a very long space name that does not fit", machine: null, tabs: [] });
  const spaces = open(opened[0].props);
  expect(spaces().labels).toEqual(["web", "a very long space name that does not fit"]);
  expect(spaces().rows.every((r) => !r.line)).toBe(true);
  row(spaces, "web").click();
  expect(ran).toEqual([["tab.move", { id: "t1", space: "s2" }]]);
});

test("the tab bar's target without a space still finds the tab's space", () => {
  const draw = open({ tab: "move-tab", target: { id: "t3" } });
  expect(draw().labels).toEqual(["api"]);
});

test("the keyboard chooses in both menus", () => {
  const first = open({ tab: "tab", target: { id: "t1", space: "s1" } });
  first().key("down");
  first().key("down");
  first().key("enter");
  expect(opened[0].props.tab).toBe("move-tab");
  state.spaces.push({ id: "s5", name: "docs", machine: null, tabs: [] });
  const second = open(opened[0].props);
  second().key("up");
  second().key("enter");
  expect(ran).toEqual([["tab.move", { id: "t1", space: "s5" }]]);
  second().key("escape");
  expect(closed.at(-1)).toBe("o1");
  // Spaces gone while it's open: nothing to choose, keys do nothing.
  state.spaces = [state.spaces[0]];
  const empty = open({ tab: "move-tab", target: { id: "t1", space: "s1" } });
  expect(empty().labels).toEqual([]);
  for (const k of ["down", "up", "enter"]) empty().key(k);
  expect(ran.length).toBe(1);
});

test("a pane goes out into a tab of its own only from a tab with others", () => {
  const draw = open({ tab: "pane", target: { pane: "p3" } });
  expect(draw().labels).toEqual(["Rename", "Split right", "Split down", "Zoom", "Move to new tab", "Close pane"]);
  row(draw, "Move to new tab").click();
  expect(ran).toEqual([["pane.move", { tab: "new", pane: "p3" }]]);
  expect(open({ tab: "pane", target: { pane: "p1" } })().labels).not.toContain("Move to new tab");
  // A terminal block outside a tab has no pane to move.
  expect(open({ tab: "pane", target: { pane: "block-1" } })().labels).toEqual([]);
});

test("hints show only keys that do what the item does", () => {
  state.keys = [
    { section: "global", keys: "cmd-j", action: "tab.join" },
    { section: "global", keys: "cmd-m", action: "tab.move" },
    { section: "global", keys: "cmd-p", action: "pane.move" },
    { section: "global", keys: "cmd-d", action: "pane.split:right" },
    { section: "global", keys: "cmd-z", action: "pane.zoom" },
  ];
  const tab = open({ tab: "tab", target: { id: "t1", space: "s1" } });
  expect(tab().rows.filter((r) => r.label.startsWith("Move")).map((r) => r.hint)).toEqual(["", "", ""]);
  expect(open({ tab: "move-tab", target: { id: "t1", space: "s1" } })().rows[0].hint).toBe("");
  const pane = () => open({ tab: "pane", target: { pane: "p3" } })().rows;
  expect(pane().map((r) => r.hint)).toEqual(["", "cmd-d", "", "cmd-z", "", ""]);
  state.keys.push({ section: "global", keys: "cmd-shift-t", action: "pane.move:new" });
  expect(pane().find((r) => r.label === "Move to new tab")!.hint).toBe("cmd-shift-t");
});

test("every icon the menus draw is shipped", () => {
  state.keys = [];
  const shown = [
    open({ tab: "tab", target: { id: "t1", space: "s1" } }),
    open({ tab: "move-tab", target: { id: "t1", space: "s1" } }),
    open({ tab: "pane", target: { pane: "p3" } }),
    open({ tab: "global" }),
  ].flatMap((draw) => draw().rows);
  expect(row(open({ tab: "tab", target: { id: "t1", space: "s1" } }), "Move below current tab").icon).toBe("mods/workspace-chrome/panel-bottom.svg");
  expect(row(open({ tab: "pane", target: { pane: "p3" } }), "Split down").icon).toBe("mods/workspace-chrome/panel-bottom.svg");
  for (const r of shown) expect(existsSync(new URL(`../defaults/${r.icon}`, import.meta.url))).toBe(true);
});
