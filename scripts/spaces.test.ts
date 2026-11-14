import { test, expect, spyOn } from "bun:test";
import { readFile } from "node:fs/promises";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const source = (await readFile(new URL("../defaults/mods/spaces/main.js", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "").replace("export default class Spaces", "class Spaces").replace(/^export /gm, "");

type Space = { id: string; folder: string; machine?: string | null; active?: boolean };
function harness(replies: unknown[] = [], storage = new Map<string, string>(), snapshot: Space[] = [], execGit?: (...args: any[]) => Promise<unknown>, watch?: (repo: string) => Promise<string[]>) {
  const calls: string[][] = [];
  const tasks: Promise<unknown>[] = [];
  const availability = [{ name: null as string | null, layout: "ready" }];
  const moves: { id: string; index: number }[] = [];
  const handlers: Record<string, (...args: any[]) => void> = {};
  const env = { layout: null as unknown, drag: null as unknown };
  // The list's scroll position: the requests the view makes are what the sidebar would scroll by.
  const ScrollHandle = { new: () => ({ calls: [] as number[], scroll_to_item(index: number) { this.calls.push(index); } }) };
  const theme = () => new Proxy({}, { get: () => "#000000" });
  const tracked: unknown[] = [];
  const element: any = new Proxy({}, { get: (_, method) => (...args: any[]) => {
    if (String(method).startsWith("on_")) handlers[String(method)] = args.at(-1);
    if (method === "track_scroll") tracked.push(args[0]);
    return element;
  } });
  const Spaces = new Function("View", "hc", "localStorage", "spaces", "panes", "run", "v_flex", "h_flex", "div", "svg", "shared", "machines", "exec", "window", "watchFolder", "ScrollHandle", "theme", "layout", "setShared", "drag", `${source}; return Spaces;`)(
    class {},
    async (args: string[]) => {
      calls.push(args);
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return reply ?? { code: 0, stdout: "{}", stderr: "" };
    },
    { setItem(key: string, value: string) { storage.set(key, value); }, getItem(key: string) { return storage.get(key) ?? null; } },
    () => snapshot, () => [],
    (name: string, args: { id: string; index: number }) => {
      expect(name).toBe("space.move");
      moves.push(args);
    },
    ...Array(4).fill(() => element), () => null, () => availability, execGit, () => ({ active: true }), watch,
    ScrollHandle, theme, () => env.layout, () => {}, () => env.drag,
  );
  const view = new Spaces();
  view.reconnecting = {};
  view.folded = new Set(["cloud"]);
  view.refreshMachines = () => {};
  const cx = { timer: { every() {} }, notify() {}, spawn(fn: (cx: unknown) => Promise<unknown>) { tasks.push(fn(cx)); } };
  return { view, calls, tasks, cx, storage, moves, handlers, snapshot, availability, env, tracked };
}

test("git grouping reads refs for normal, detached, unborn and bare worktrees", async () => {
  // Git answers with real paths, and the temp folder is behind a link on macOS (/var -> /private/var).
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-spaces-")));
  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" } });
    if (result.exitCode) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  const execGit = async (_command: string, args: string[], { cwd }: { cwd: string }) => {
    const result = Bun.spawnSync(["git", ...args], { cwd });
    return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  };
  const h = harness([], new Map(), [], execGit);
  Object.assign(h.view, { git: {}, checked: {}, unsure: new Set() });
  h.view.watch = () => {};
  const check = async (folder: string) => {
    const key = JSON.stringify([null, folder]);
    await h.view.check(key, h.cx);
    return h.view.git[key];
  };
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-b", "main");
    expect(await check(repo)).toMatchObject({ branch: "main", ahead: 0, behind: 0, linked: false });
    git(repo, "commit", "--allow-empty", "-m", "base");
    git(repo, "branch", "upstream");
    git(repo, "branch", "--set-upstream-to=upstream");
    git(repo, "commit", "--allow-empty", "-m", "ahead");
    git(repo, "checkout", "upstream");
    git(repo, "commit", "--allow-empty", "-m", "behind");
    git(repo, "checkout", "main");
    git(repo, "tag", "main");
    expect(await check(repo)).toMatchObject({ name: "repo", branch: "main", ahead: 1, behind: 1, linked: false });
    const tree = join(root, "tree");
    git(repo, "worktree", "add", "-b", "topic", tree);
    expect(await check(tree)).toMatchObject({ branch: "topic", ahead: 0, behind: 0, linked: true, repo: JSON.stringify([null, join(repo, ".git")]) });
    git(tree, "checkout", "--detach");
    expect(await check(tree)).toMatchObject({ branch: "(detached)", ahead: 0, behind: 0 });
    expect(await check(root)).toBeNull();
    expect(h.view.unsure.has(JSON.stringify([null, root]))).toBe(false);
    const bare = join(root, "bare.git"), bareTree = join(root, "bare-tree");
    git(root, "clone", "--bare", repo, bare);
    expect(await check(bare)).toBeNull();
    git(bare, "worktree", "add", "-b", "bare-topic", bareTree);
    expect(await check(bareTree)).toMatchObject({ name: "bare", branch: "bare-topic", linked: true, repo: JSON.stringify([null, bare]) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(["--show-toplevel", "--git-common-dir"])("a failed %s keeps worktrees nested until git can answer again", async (failedRead) => {
  let failure: string | null = null;
  const snapshot = [{ id: "main", folder: "/repo" }, { id: "tree", folder: "/tree" }];
  const h = harness([], new Map(), snapshot, async (_command: string, args: string[], { cwd }: { cwd: string }) => {
    if (cwd === "/repo" && args.includes(failedRead) && failure) return { code: 128, stdout: "", stderr: failure };
    const stdout = args.includes("--show-toplevel") ? cwd + "\n"
      : args.includes("--git-common-dir") ? "/repo/.git\n"
      : args[0] === "symbolic-ref" ? "refs/heads/main\n" : "0 0\n";
    return { code: 0, stdout, stderr: "" };
  });
  h.view.init({}, h.cx);
  h.view.watch = () => {};
  const main = JSON.stringify([null, "/repo"]);
  const tree = JSON.stringify([null, "/tree"]);
  await h.view.check(main, h.cx);
  await h.view.check(tree, h.cx);
  const nesting = () => h.view.ordered().map((r: any) => [r.w.id, r.tree]);
  expect(nesting()).toEqual([["main", null], ["tree", "└─"]]);
  const cached = h.view.git[main];

  failure = "fatal: unable to create thread: Too many open files";
  await h.view.check(main, h.cx);
  expect(nesting()).toEqual([["main", null], ["tree", "└─"]]);
  expect(h.view.git[main]).toBe(cached);
  expect(h.view.unsure.has(main)).toBe(true);
  expect(h.view.due(Date.now() + 60001, snapshot, []).has(main)).toBe(true);

  failure = null;
  await h.view.check(main, h.cx);
  expect(h.view.unsure.has(main)).toBe(false);
  expect(nesting()).toEqual([["main", null], ["tree", "└─"]]);

  failure = "fatal: not a git repository (or any of the parent directories): .git";
  await h.view.check(main, h.cx);
  expect(h.view.git[main]).toBeNull();
  expect(h.view.unsure.has(main)).toBe(false);
  expect(nesting()).toEqual([["main", null], ["tree", null]]);
});

test("closing spaces forgets old git state but keeps a shown worktree", () => {
  const h = harness();
  Object.assign(h.view, { git: {}, checked: {}, unsure: new Set(), watching: new Map(), at: {}, busy: {}, ready: {} });
  const key = (folder: string) => JSON.stringify([null, folder]);
  for (let i = 0; i < 75; i++) {
    const folder = "/repo-" + i, repo = folder + "/.git";
    h.view.git[key(folder)] = { repo: key(repo) };
    h.view.checked[key(folder)] = 1;
    h.view.unsure.add(key(folder));
    h.view.due(100, [{ id: "current", folder }], []);
    expect(Object.keys(h.view.git)).toEqual([key(folder)]);
    expect([...h.view.unsure]).toEqual([key(folder)]);
    expect(Object.keys(h.view.checked)).toEqual([key(folder)]);
  }
  const repo = "/repo-74/.git";
  h.view.git[key("/worktree")] = { repo: key(repo) };
  h.view.due(100, [{ id: "tree", folder: "/worktree" }], []);
  h.view.due(100, [], []);
  expect(h.view.git).toEqual({});
  expect(h.view.checked).toEqual({});
  expect(h.view.unsure.size).toBe(0);
  expect(h.view.watching.size).toBe(0);
});

test("closing 75 quiet repos cancels each watch, preserving a shown worktree and reopened watch", async () => {
  const pending = new Set<Promise<string[]>>();
  let cancelled = 0;
  const h = harness([], new Map(), [], undefined, () => {
    let settle!: (paths: string[]) => void;
    const promise = Object.assign(new Promise<string[]>(resolve => { settle = resolve; }), {
      cancel() { if (pending.delete(promise)) { cancelled++; settle([]); } },
    });
    pending.add(promise);
    return promise;
  });
  Object.assign(h.view, { git: {}, watching: new Map(), checked: {}, unsure: new Set(), at: {}, busy: {}, ready: {} });
  let refreshes = 0;
  h.view.refreshGit = () => refreshes++;
  const key = (folder: string) => JSON.stringify([null, folder]);
  for (let i = 0; i < 75; i++) {
    const repo = "/repo-" + i + "/.git", folder = "/repo-" + i;
    h.view.git[key(folder)] = { repo: key(repo) };
    h.view.git[key("/worktree")] = { repo: key(repo) };
    h.view.watch(repo, h.cx);
    h.view.watch(repo, h.cx);
    expect(pending.size).toBe(1);
    h.view.due(100, [{ id: "tree", folder: "/worktree" }], []);
    expect(pending.size).toBe(1);
    h.view.due(100, [], []);
    expect(pending.size).toBe(0);
  }
  // Reopen before the old cancelled continuation runs.
  const repo = "/repo-74/.git";
  h.view.git[key("/repo-74")] = { repo: key(repo) };
  h.view.watch(repo, h.cx);
  await Promise.resolve();
  expect(h.view.watching.has(repo)).toBe(true);
  expect(pending.size).toBe(1);
  h.view.due(100, [], []);
  await Promise.all(h.tasks);
  expect(cancelled).toBe(76);
  expect(refreshes).toBe(0);
  expect(h.view.watching.size).toBe(0);
});

const machine = { name: "cloud", id: "old", target: "user@host", session: null, via: false };

test("Connect removes then pairs the same SSH machine, ignoring repeat clicks", async () => {
  const { view, calls, tasks, cx } = harness();
  view.reconnect(machine, cx);
  view.reconnect(machine, cx);
  await Promise.all(tasks);
  expect(calls).toEqual([
    ["machine", "rm", "cloud", "--json"],
    ["machine", "add", "user@host", "--name", "cloud", "--json"],
  ]);
  expect(view.reconnecting).toEqual({});
  expect(view.folded.has("cloud")).toBe(false);
});

test("Connect preserves a via command and nondefault core session", async () => {
  const { view, calls, tasks, cx } = harness();
  view.reconnect({ ...machine, via: true, target: "ssh -p 2222 host", session: "work" }, cx);
  await Promise.all(tasks);
  expect(calls[1]).toEqual([
    "machine", "add", "--via", "ssh -p 2222 host", "--name", "cloud", "--session", "work", "--json",
  ]);
});

test("a failed removal never adds, and a failed add remains retryable without another removal", async () => {
  const failure = { code: 1, stdout: "", stderr: '{"error":{"message":"no connection"}}' };
  const removed = harness([failure]);
  removed.view.reconnect(machine, removed.cx);
  await Promise.all(removed.tasks);
  expect(removed.calls).toHaveLength(1);
  expect(removed.view.reconnecting.cloud.error).toBe("no connection");
  expect(removed.view.reconnecting.cloud.removed).toBe(false);

  const added = harness([{ code: 0 }, failure]);
  added.view.reconnect(machine, added.cx);
  await Promise.all(added.tasks);
  expect(added.view.reconnecting.cloud.machine).toEqual(machine);
  expect(added.view.reconnecting.cloud.busy).toBe(false);
  added.view.reconnect(machine, added.cx);
  await Promise.all(added.tasks);
  expect(added.calls.map(c => c[1])).toEqual(["rm", "add", "add"]);
  expect(added.view.reconnecting).toEqual({});
});

test("temporary reconnects remain temporary", async () => {
  const { view, calls, tasks, cx } = harness();
  view.reconnect({ ...machine, temporary: true }, cx);
  await Promise.all(tasks);
  expect(calls[1]).toContain("--temp");
});

test("failed pairing survives a sidebar restart and retries without removal", async () => {
  const failed = harness([{ code: 0 }, { code: 1, stderr: "core too old" }]);
  failed.view.reconnect(machine, failed.cx);
  await Promise.all(failed.tasks);
  const restarted = harness([], failed.storage);
  restarted.view.init({}, restarted.cx);
  expect(restarted.view.reconnecting.cloud.machine).toEqual(machine);
  expect(restarted.view.reconnecting.cloud.error).toBe("core too old");
  expect(restarted.view.reconnecting.cloud.busy).toBe(false);
  restarted.view.reconnect(machine, restarted.cx);
  await Promise.all(restarted.tasks);
  expect(restarted.calls.map(c => c[1])).toEqual(["add"]);
  const completed = harness([], failed.storage);
  completed.view.init({}, completed.cx);
  expect(completed.view.reconnecting).toEqual({});
});

test("unexpected transport failures clear the busy state", async () => {
  const { view, tasks, cx } = harness([new Error("offline")]);
  view.reconnect(machine, cx);
  await Promise.all(tasks);
  expect(view.reconnecting.cloud.busy).toBe(false);
  expect(view.reconnecting.cloud.error).toBe("offline");
});

function orderedHarness(ids: string[]) {
  const h = harness([], new Map(), ids.map(id => ({ id, folder: "/" + id })));
  h.view.git = {};
  h.view.shown = new Set(ids);
  h.view.born = {};
  h.view.pressed = null;
  h.view.over = null;
  const git = (id: string, repo: string, linked: boolean) => {
    const s = h.snapshot.find(s => s.id === id)!;
    h.view.git[JSON.stringify([s.machine ?? null, s.folder])] = { repo, linked };
  };
  const flush = () => {
    for (const { id, index } of h.moves.splice(0)) {
      const from = h.snapshot.findIndex(s => s.id === id);
      h.snapshot.splice(index - 1, 0, h.snapshot.splice(from, 1)[0]);
    }
  };
  const rows = () => h.view.ordered();
  const order = () => h.snapshot.map(s => s.id);
  return { ...h, git, flush, rows, order };
}

test("the sidebar reconciles a full batch once, then the core echo is a no-op", () => {
  const h = orderedHarness(["other", "a", "main", "tail", "b"]);
  h.git("main", "repo", false);
  h.git("a", "repo", true);
  h.git("b", "repo", true);
  expect(h.rows().map((r: any) => r.w.id)).toEqual(["other", "main", "a", "b", "tail"]);
  expect(h.moves).toEqual([{ id: "main", index: 2 }, { id: "b", index: 4 }]);
  h.rows();
  expect(h.moves).toHaveLength(2);
  h.flush();
  h.rows();
  expect(h.moves).toEqual([]);
  expect(h.order()).toEqual(["other", "main", "a", "b", "tail"]);
});

test("unshown spaces are preserved and orphan worktrees stay in model order", () => {
  const h = orderedHarness(["new", "orphan", "a", "main"]);
  h.view.shown.delete("new");
  h.view.born.new = Date.now();
  h.git("orphan", "elsewhere", true);
  h.git("main", "repo", false);
  h.git("a", "repo", true);
  expect(h.rows().map((r: any) => r.w.id)).toEqual(["orphan", "main", "a"]);
  h.flush();
  expect(h.order()).toEqual(["new", "orphan", "main", "a"]);
});

test("machines and duplicate main-checkout spaces keep their own order", () => {
  const h = orderedHarness(["a", "main", "main2", "remote-a", "remote-main"]);
  for (const s of h.snapshot) if (s.id.startsWith("remote-")) s.machine = "cloud";
  h.git("main", "local-repo", false);
  h.git("main2", "local-repo", false);
  h.git("a", "local-repo", true);
  h.git("remote-main", "remote-repo", false);
  h.git("remote-a", "remote-repo", true);
  h.rows();
  h.flush();
  expect(h.order()).toEqual(["main", "a", "main2", "remote-main", "remote-a"]);
  expect(h.rows().filter((r: any) => r.tree).map((r: any) => r.w.id)).toEqual(["a", "remote-a"]);
  expect(h.moves).toEqual([]);
});

test("dragging a main checkout moves the right id and its children follow", () => {
  const h = orderedHarness(["other", "topic", "main", "last"]);
  h.git("main", "repo", false);
  h.git("topic", "repo", true);
  const first = h.rows();
  h.flush();
  // The row was built before reconciliation: neither its old index nor the
  // dragged row's old index may be used to resolve the drop.
  h.view.pressed = "main";
  h.view.over = "last";
  h.view.row(first.find((r: any) => r.w.id === "last"), {});
  h.handlers.on_mouse_up({}, h.cx);
  expect(h.moves).toEqual([{ id: "main", index: 4 }]);
  h.flush();
  h.rows();
  h.flush();
  expect(h.order()).toEqual(["other", "last", "main", "topic"]);
  h.rows();
  expect(h.moves).toEqual([]);
});

test("a machine becoming ready retries a previously rejected batch", () => {
  const h = orderedHarness(["topic", "main"]);
  h.git("main", "repo", false);
  h.git("topic", "repo", true);
  h.availability[0].layout = "unavailable";
  h.rows();
  h.moves.splice(0); // The unavailable machine rejected the moves.
  h.rows();
  expect(h.moves).toEqual([]);
  h.availability[0].layout = "ready";
  h.rows();
  expect(h.moves).toEqual([{ id: "main", index: 1 }]);
  h.flush();
  h.rows();
  expect(h.moves).toEqual([]);
});

test("a lost write retries after settling even without an intermediate ordered render", () => {
  const now = spyOn(Date, "now").mockReturnValue(10000);
  try {
    const h = orderedHarness(["topic", "main"]);
    h.git("main", "repo", false);
    h.git("topic", "repo", true);
    h.rows();
    h.flush();
    // A mirror conflict restores the original same-ID order before rendering.
    h.snapshot.reverse();
    now.mockReturnValue(10999);
    h.rows();
    expect(h.moves).toEqual([]);
    now.mockReturnValue(11000);
    let notified = false;
    h.view.due = () => new Set();
    h.view.checkNew({ notify() { notified = true; } });
    expect(notified).toBe(true);
    h.rows();
    expect(h.moves).toEqual([{ id: "main", index: 1 }]);
    h.rows();
    expect(h.moves).toHaveLength(1);
    h.flush();
    h.rows();
    now.mockReturnValue(12000);
    h.rows();
    expect(h.moves).toEqual([]);
    expect(h.view.ordering).toBeNull();
  } finally {
    now.mockRestore();
  }
});

test("settled retries wait for the affected machine to be ready", () => {
  const now = spyOn(Date, "now").mockReturnValue(10000);
  try {
    const h = orderedHarness(["topic", "main"]);
    h.git("main", "repo", false);
    h.git("topic", "repo", true);
    h.availability[0].layout = "unavailable";
    h.rows();
    h.moves.splice(0);
    now.mockReturnValue(12000);
    expect(h.view.orderingDue(Date.now())).toBe(false);
    h.rows();
    expect(h.moves).toEqual([]);
    h.availability[0].layout = "ready";
    h.rows();
    expect(h.moves).toEqual([{ id: "main", index: 1 }]);
  } finally {
    now.mockRestore();
  }
});

test("no reconciliation without a rendered sidebar", () => {
  const h = orderedHarness(["topic", "main"]);
  h.git("main", "repo", false);
  h.git("topic", "repo", true);
  expect(h.moves).toEqual([]);
  h.rows();
  h.flush();
  expect(h.order()).toEqual(["main", "topic"]);
});

test("git checks run a few spaces at a time, not every space at once", async () => {
  let running = 0, most = 0;
  const execGit = async () => {
    running++;
    most = Math.max(most, running);
    await new Promise((resolve) => setTimeout(resolve, 1));
    running--;
    return { code: 0, stdout: "/repo\n", stderr: "" };
  };
  const h = harness([], new Map(), [], execGit);
  Object.assign(h.view, { git: {}, checked: {}, unsure: new Set(), pending: new Set(), watching: new Map() });
  h.view.watch = () => {};
  const keys = Array.from({ length: 40 }, (_, i) => JSON.stringify([null, `/repo/${i}`]));
  h.view.refreshGit(keys, h.cx);
  await Promise.all(h.tasks);
  expect(Object.values(h.view.git).filter(Boolean)).toHaveLength(40);
  expect(most).toBeLessThanOrEqual(12);
});

// The list scrolls by its direct children, so the active space's place counts machine headers too.
function scrollHarness(spaces: Space[]) {
  const h = harness([], new Map(), spaces);
  Object.assign(h.view, { git: {}, checked: {}, unsure: new Set(), pending: new Set(), watching: new Map(), folded: new Set(), machines: [] });
  h.view.shown = new Set(spaces.map(s => s.id));
  h.view.born = {};
  return h;
}
const withHandle = (h: ReturnType<typeof harness>) => { h.view.scroll = { calls: [] as number[], scroll_to_item(i: number) { this.calls.push(i); } }; return h; };
const spaceList = (ids: string[], active: string, remote: string[] = []): Space[] =>
  ids.map(id => ({ id, folder: "/" + id, active: id === active, ...(remote.includes(id) ? { machine: "cloud" } : {}) }));

test("the active space is brought into view once, and left alone while it stays put", () => {
  const h = withHandle(scrollHarness(spaceList(["a", "b", "c", "d"], "c")));
  h.view.render();
  expect(h.view.scroll.calls).toEqual([2]);
  expect(h.tracked).toEqual([h.view.scroll]); // the list is the area that handle scrolls
  h.view.render();
  h.view.render();
  expect(h.view.scroll.calls).toEqual([2]);
  h.snapshot.forEach(s => { s.active = s.id === "a"; });
  h.view.render();
  expect(h.view.scroll.calls).toEqual([2, 0]);
});

test("the active space's place counts a remote machine's header and rows", () => {
  const ids = ["a", "b", "r1", "r2"];
  const h = withHandle(scrollHarness(spaceList(ids, "r2", ["r1", "r2"])));
  h.view.render();
  // children: this computer's header, a, b, cloud's header, r1, r2
  expect(h.view.scroll.calls).toEqual([5]);
});

test("a folded machine's active space has no row to reveal", () => {
  const h = withHandle(scrollHarness(spaceList(["a", "r1"], "r1", ["r1"])));
  h.view.folded = new Set(["cloud"]);
  h.view.render();
  expect(h.view.scroll.calls).toEqual([]);
});

test("the narrow rail reveals the same child", () => {
  const h = withHandle(scrollHarness(spaceList(["a", "b", "c"], "c")));
  h.env.layout = { id: "sidebar", size: { px: 100 } };
  h.view.render();
  expect(h.view.scroll.calls).toEqual([2]);
});

test("the list reveals the active space again when its own size changes, and only then", () => {
  const h = withHandle(scrollHarness(spaceList(["a", "b", "c", "d"], "d")));
  let notified = 0;
  h.cx.notify = () => { notified++; };
  h.view.render();
  expect(h.view.scroll.calls).toEqual([3]);
  h.handlers.on_size_change({ width: 200, height: 60 }, h.cx);
  expect(h.view.scroll.calls).toEqual([3, 3]);
  expect(notified).toBe(1);
  h.view.render();
  expect(h.view.scroll.calls).toEqual([3, 3]);
});

test("a size change with no active row drawn asks for nothing", () => {
  const h = withHandle(scrollHarness(spaceList(["a", "r1"], "r1", ["r1"])));
  h.view.folded = new Set(["cloud"]);
  h.view.render();
  h.handlers.on_size_change({ width: 200, height: 60 }, h.cx);
  expect(h.view.scroll.calls).toEqual([]);
});

test("the list reveals the active space again when a machine header shifts its place", () => {
  const h = withHandle(scrollHarness(spaceList(["a", "b", "c", "d"], "b")));
  h.view.render();
  expect(h.view.scroll.calls).toEqual([1]);
  // A machine joins: its header and rows come after this computer's, and now this computer gets a header too,
  // so the same active space sits one child further down.
  h.snapshot.push({ id: "r1", folder: "/r1", machine: "cloud", active: false });
  h.view.shown.add("r1");
  h.view.render();
  expect(h.view.scroll.calls).toEqual([1, 2]);
  h.view.render();
  expect(h.view.scroll.calls).toEqual([1, 2]);
});

// Machine headers: what each part of the row does when clicked.
type Node = { id?: string; src?: string; calls: Record<string, any[][]>; kids: (Node | string)[] };
function headerHarness(opts: { state?: string; layoutPx?: number; folded?: string[]; logout?: boolean } = {}) {
  const ran: [string, unknown][] = [], overlays: unknown[] = [];
  const storage = new Map<string, string>(opts.folded ? [["machines.folded", JSON.stringify(opts.folded)]] : []);
  const make = (): any => {
    const node: Node = { calls: {}, kids: [] };
    const proxy: any = new Proxy(node, { get: (target, key: string) => key in target ? (target as any)[key] : (...args: any[]) => {
      if (key === "id") target.id = args[0];
      if (key === "child") target.kids.push(args[0]);
      else if (key === "children") target.kids.push(...args[0]);
      else if (key === "when") { if (args[0]) args[1](proxy); }
      else (target.calls[key] ??= []).push(args);
      return proxy;
    } });
    return proxy;
  };
  const snapshot = [{ id: "a", name: "a", folder: "/a", machine: null, active: true, tabs: [] }, { id: "r", name: "r", folder: "/r", machine: "vehiclesec", active: false, tabs: [] }];
  const env: Record<string, unknown> = {
    View: class {}, div: make, v_flex: make, h_flex: make, svg: (src: string) => Object.assign(make(), { src }),
    ScrollHandle: { new: () => ({ scroll_to_item() {} }) },
    spaces: () => snapshot, machines: () => [{ name: null, layout: "ready" }, { name: "vehiclesec", layout: "ready" }], panes: () => [],
    run(name: string, args: unknown) { ran.push([name, args]); }, openOverlay(o: unknown) { overlays.push(o); },
    exec: async () => ({ code: 0, stdout: "", stderr: "" }), hc: async () => ({ code: 0, stdout: "{}", stderr: "" }),
    theme: () => new Proxy({}, { get: (_, k) => `#${String(k)}` }), shared: () => null, setShared() {}, watchFolder: () => new Promise(() => {}),
    window: () => ({ active: true }), layout: () => opts.layoutPx ? { id: "sidebar", size: { px: opts.layoutPx } } : null, drag: () => null,
    localStorage: { setItem(k: string, v: string) { storage.set(k, v); }, getItem: (k: string) => storage.get(k) ?? null },
  };
  const Spaces = new Function(...Object.keys(env), `${source}; return Spaces;`)(...Object.values(env));
  const view = new Spaces();
  view.init({}, { timer: { every() {} }, spawn() {}, notify() {} });
  Object.assign(view, { git: {}, shown: new Set(["a", "r"]) });
  view.machines = [{ name: "vehiclesec", state: opts.state ?? "connected", target: "vehiclesec", ...(opts.logout ? { keeps_running_after_logout: false } : {}) }];
  const all = (n: Node | string): Node[] => typeof n === "string" ? [] : [n, ...n.kids.flatMap(all)];
  const find = (id: string) => all(view.render()).find(n => n.id === id);
  const text = (n: Node | string): string => typeof n === "string" ? n : n.kids.map(text).join("");
  let stopped = 0, notified = 0;
  const cx = { stop_propagation() { stopped++; }, notify() { notified++; } };
  const handler = (n: Node, name: string, button?: string) => {
    const call = n.calls[name]?.find(args => button === undefined || args[0] === button);
    return call?.at(-1) as (e: unknown, cx: unknown) => void;
  };
  return { view, find, text, ran, overlays, storage, cx, handler, stopped: () => stopped, notified: () => notified };
}

test("a machine header's + starts a space on that machine without folding it", () => {
  const h = headerHarness();
  for (const [id, machine] of [["machine-add-local", ""], ["machine-add-vehiclesec", "vehiclesec"]]) {
    const add = h.find(id)!;
    expect(add.calls.size[0][0]).toBeGreaterThanOrEqual(22); // a comfortable target
    expect(add.calls.tooltip[0][0]).toBe(`New space on ${machine || "this computer"}`);
    // The press stops too, so the header behind it neither shows pressed nor folds.
    const before = h.stopped();
    h.handler(add, "on_mouse_down", "left")({}, h.cx);
    h.handler(add, "on_click")({}, h.cx);
    expect(h.stopped()).toBe(before + 2);
    expect(h.ran.at(-1)).toEqual(["space.new", { machine }]);
  }
  expect(h.view.folded.size).toBe(0);
});

test("clicking anywhere else on a machine header folds and unfolds it", () => {
  const h = headerHarness();
  const head = () => h.find("machine-vehiclesec")!;
  expect(head().calls.h[0][0]).toBeLessThanOrEqual(30); // no taller than a space row
  // The chevron leads the row, as in a file tree.
  const chevron = () => ((head().kids[0] as Node).kids[0] as Node).src;
  expect(chevron()).toBe("mods/workspace-chrome/chevron-down.svg");
  h.handler(head(), "on_click")({}, h.cx);
  expect([...h.view.folded]).toEqual(["vehiclesec"]);
  expect(JSON.parse(h.storage.get("machines.folded")!)).toEqual(["vehiclesec"]);
  expect(h.find("space-r")).toBeUndefined();
  expect(chevron()).toBe("mods/workspace-chrome/chevron-right.svg");
  h.handler(head(), "on_click")({}, h.cx);
  expect(h.view.folded.size).toBe(0);
  expect(h.find("space-r")).toBeDefined();
  expect(h.ran).toEqual([]);
});

test("the status dot sits on the machine icon, and the state word stays", () => {
  const h = headerHarness({ state: "unreachable" });
  const mark = h.find("machine-state-vehiclesec")!;
  expect(mark.calls.tooltip[0][0]).toBe("vehiclesec · unreachable");
  const dot = (mark.kids[1] as Node);
  expect(dot.calls.bg[0][0]).toBe("#dim");
  expect(h.text(h.find("machine-vehiclesec")!)).toContain("unreachable");
  // Nowhere to start a space on a machine that isn't there.
  expect(h.find("machine-add-vehiclesec")).toBeUndefined();
  const local = h.find("machine-state-local")!;
  expect((local.kids[1] as Node).calls.bg[0][0]).toBe("#ansi2");
});

test("the logout warning opens its fix without folding the machine", () => {
  const h = headerHarness({ logout: true });
  const warn = h.find("machine-logout-vehiclesec")!;
  h.handler(warn, "on_mouse_down", "left")({}, h.cx);
  h.handler(warn, "on_click")({}, h.cx);
  expect(h.overlays).toEqual([{ mod: "machine-add", kind: "dialog", width: 560 }]);
  expect(h.view.folded.size).toBe(0);
});

test("the rail keeps its one-button machine cells", () => {
  const h = headerHarness({ layoutPx: 76 });
  expect(h.find("machine-add-local")).toBeUndefined();
  const head = h.find("machine-vehiclesec")!;
  expect(head.calls.tooltip[0][0]).toBe("vehiclesec · connected");
  h.handler(head, "on_click")({}, h.cx);
  expect([...h.view.folded]).toEqual(["vehiclesec"]);
});

// A tab or pane Herdr drags drops on a space row; rows say whether they can take it.
const dropState = new Function("View", "div", `${source}; return dropState;`)(class {}, () => null);

test("a dragged tab can go to another space of its machine, never its own or another machine's", () => {
  const tab = { tab: "c1", space: "a", machine: null, over: null, valid: false };
  expect(dropState(null, { id: "b", machine: null })).toBeNull();
  expect(dropState(tab, { id: "b", machine: null })).toBe("can");
  expect(dropState(tab, { id: "a", machine: null })).toBe("no");
  expect(dropState(tab, { id: "far", machine: "vps" })).toBe("no");
  expect(dropState({ ...tab, over: { space: "b" }, valid: true }, { id: "b", machine: null })).toBe("over");
  expect(dropState({ ...tab, over: { space: "b" }, valid: false }, { id: "b" })).toBe("refused");
  // A pane may make a new tab in its own space; a remote tab only on its machine.
  expect(dropState({ ...tab, pane: "x1" }, { id: "a", machine: null })).toBe("can");
  expect(dropState({ ...tab, machine: "vps" }, { id: "far", machine: "vps" })).toBe("can");
  expect(dropState({ ...tab, machine: "vps" }, { id: "b", machine: null })).toBe("no");
});

test("every space row, full or rail, is a drop target that fades when it can't take the drag", () => {
  const calls: [string, unknown[]][] = [];
  // Records each builder call and runs `when` branches, so a row's look is visible.
  const element: any = new Proxy({}, { get: (_, method) => (...args: any[]) => {
    calls.push([String(method), args]);
    if (method === "when" && args[0]) args[1](element);
    return element;
  } });
  const h = harness([], new Map(), [{ id: "a", name: "api", folder: "/a", active: true }, { id: "far", name: "far", folder: "/f", machine: "vps" }] as Space[]);
  const Spaces = new Function("View", "hc", "localStorage", "spaces", "panes", "run", "v_flex", "h_flex", "div", "svg", "shared", "machines", "exec", "window", "watchFolder", "ScrollHandle", "theme", "layout", "setShared", "drag", `${source}; return Spaces;`)(
    class {}, async () => ({ code: 0, stdout: "{}", stderr: "" }), { setItem() {}, getItem: () => null },
    () => h.snapshot, () => [], () => {}, ...Array(4).fill(() => element), () => null, () => [], async () => ({ code: 1, stdout: "", stderr: "" }), () => ({ active: true }), () => new Promise(() => {}),
    { new: () => ({ scroll_to_item() {} }) }, () => new Proxy({}, { get: (_, k) => String(k) }), () => null, () => {},
    () => env.drag,
  );
  const env = { drag: { tab: "c1", space: "a", machine: null, over: { space: "a" }, valid: false } as unknown };
  const view = new Spaces();
  for (const [draw, radius] of [["row", 8], ["compact", 6]] as const) {
    for (const w of h.snapshot) {
      calls.length = 0;
      view[draw]({ w, i: 0, g: null, tree: null }, new Proxy({}, { get: (_, k) => String(k) }));
      expect(calls.find(([m]) => m === "drop_move")?.[1]).toEqual([{ space: w.id }]);
      // Its own space (under the pointer) and a space on another machine: neither can take the tab, so both fade.
      expect(calls.some(([m, a]) => m === "opacity" && a[0] === 0.4)).toBe(true);
      expect(calls.some(([m, a]) => m === "border_color" && a[0] === "accent")).toBe(false);
      expect(calls.some(([m, a]) => m === "rounded" && a[0] === radius)).toBe(true);
    }
    // Another space of its machine under the pointer: lit.
    h.snapshot.push({ id: "b", name: "web", folder: "/b" });
    env.drag = { tab: "c1", space: "a", machine: null, over: { space: "b" }, valid: true };
    calls.length = 0;
    view[draw]({ w: h.snapshot[2], i: 2, g: null, tree: null }, new Proxy({}, { get: (_, k) => String(k) }));
    expect(calls.some(([m, a]) => m === "border_color" && a[0] === "accent")).toBe(true);
    expect(calls.some(([m]) => m === "opacity")).toBe(false);
    h.snapshot.pop();
    env.drag = { tab: "c1", space: "a", machine: null, over: { space: "a" }, valid: false };
  }
});
