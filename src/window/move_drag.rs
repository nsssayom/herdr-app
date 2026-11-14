//! Moving tabs and panes by dragging, across the parts of the window: a tab
//! from a tab bar onto a space or into the shown tab's panes, a pane by its
//! grip into another tab, out into a new one, or onto a space.
//!
//! The app owns the one drag there is. A press on the pane grip, or on a mod
//! element marked `drag_move({tab} | {pane})`, becomes a drag past 4 px. Mods
//! mark where it can drop with `drop_move({space} | {tab} | {tab: "new"})`;
//! the shown tab's panes are targets of their own (edges, as the grip's).
//! The app follows the pointer over the whole window, draws the ghost and the
//! pane preview, tells mods through `drag()` so they can light their targets,
//! and runs the move command on release. Escape, or a release where nothing
//! would happen, changes nothing.
use super::*;
use gpui_shell::move_drag::{self as shell_drag, MoveHit};

/// How far the pointer moves before a press becomes a drag.
const START: f32 = 4.;
/// How long a pane held over another tab waits before showing it.
pub(super) const DWELL: Duration = Duration::from_millis(600);

#[derive(Clone, Debug, PartialEq)]
pub(super) enum Dragged {
    Tab(String),
    Pane(String),
}

/// Where a drag can drop.
#[derive(Clone, Debug, PartialEq)]
pub(super) enum Target {
    /// A pane of the shown tab: an edge, or (in its own tab) the middle.
    Pane { pane: String, edge: Option<Edge> },
    Space(String),
    Tab(String),
    /// A new tab: after the pane's own tab, or last in `space`.
    NewTab(Option<String>),
}

/// What dropping there does.
#[derive(Clone, Debug, PartialEq)]
pub(super) enum Plan {
    /// A command, as a click would run it (its refusals show as a toast).
    Run(&'static str, Value),
    /// The grip's own rearranging in its tab: a swap (no edge) or beside.
    Rearrange { target: String, edge: Option<Edge> },
    /// Dropped where it came from: the release is the element's own (a click).
    Itself,
    /// Nothing: not a place for it, and why.
    No(&'static str),
}

pub(super) struct Over {
    pub target: Target,
    /// What a mod's target said, for `drag()`.
    raw: Value,
    /// Its box, window px.
    bounds: Bounds<Pixels>,
    plan: Plan,
    pub label: String,
}

pub(super) struct MoveDrag {
    pub what: Dragged,
    down: Point<Pixels>,
    pointer: Point<Pixels>,
    pub moving: bool,
    /// Started on the app's grip: its press is the app's, not an element's.
    grip: bool,
    pub over: Option<Over>,
    /// The tab a pane is held over, shown once DWELL passes.
    dwell: Option<(String, Task<()>)>,
}

impl MoveDrag {
    fn new(what: Dragged, at: Point<Pixels>, grip: bool) -> Self {
        MoveDrag { what, down: at, pointer: at, moving: false, grip, over: None, dwell: None }
    }
}

/// A mod's `drop_move` value as a target; anything else isn't one.
pub(super) fn parse_target(v: &Value) -> Option<Target> {
    let id = |k: &str| v.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
    match (id("space"), id("tab")) {
        (space, Some(tab)) if tab == "new" => Some(Target::NewTab(space)),
        (None, Some(tab)) => Some(Target::Tab(tab)),
        (Some(space), None) => Some(Target::Space(space)),
        _ => None,
    }
}

/// Over another tab's pane there's nothing to swap with: its nearest edge.
pub(super) fn edge_zone(bounds: Bounds<Pixels>, at: Point<Pixels>) -> Option<Edge> {
    if !bounds.contains(&at) || bounds.size.width <= px(0.) || bounds.size.height <= px(0.) {
        return None;
    }
    let x = f32::from(at.x - bounds.origin.x) / f32::from(bounds.size.width);
    let y = f32::from(at.y - bounds.origin.y) / f32::from(bounds.size.height);
    [(x, Edge::Left), (1. - x, Edge::Right), (y, Edge::Top), (1. - y, Edge::Bottom)]
        .into_iter().min_by(|a, b| a.0.total_cmp(&b.0)).map(|(_, e)| e)
}

pub(super) fn edge_word(edge: Edge) -> &'static str {
    match edge {
        Edge::Left => "left",
        Edge::Right => "right",
        Edge::Top => "up",
        Edge::Bottom => "down",
    }
}

fn edge_place(edge: Option<Edge>) -> &'static str {
    match edge {
        Some(Edge::Left) => "left of it",
        Some(Edge::Right) => "right of it",
        Some(Edge::Top) => "above it",
        Some(Edge::Bottom) => "below it",
        None => "swap places",
    }
}

/// What dropping `what` on `target` does, and the words the ghost shows.
pub(super) fn plan(m: &Model, home: &str, what: &Dragged, target: &Target) -> (Plan, String) {
    let space_name = |id: &str| m.space(id).map(|p| m.space_name(p, home)).unwrap_or_default();
    let tab_name = |id: &str| m.space_of(id).zip(m.tab(id)).map(|(p, c)| Model::tab_name(p, c)).unwrap_or_default();
    let other = (Plan::No("on another machine"), "Not here: another machine".to_owned());
    match what {
        Dragged::Tab(t) => {
            let Some(own) = m.space_of(t) else { return (Plan::No("gone"), String::new()) };
            match target {
                Target::Space(s) if m.space(s).is_none() => (Plan::No("gone"), String::new()),
                Target::Space(s) if !m.same_machine(t, s) => other,
                Target::Space(s) if *s == own.id => (Plan::No("its own space"), "Already in this space".into()),
                Target::Space(s) => (Plan::Run("tab.move", json!({ "id": t, "space": s })), format!("Move to {}", space_name(s))),
                Target::Tab(u) if u == t => (Plan::Itself, String::new()),
                Target::Tab(u) => {
                    let Some(p) = m.space_of(u).filter(|_| m.tab(u).is_some()) else { return (Plan::No("gone"), String::new()) };
                    if !m.same_machine(t, u) {
                        return other;
                    }
                    let index = p.tabs.iter().position(|c| c.id == *u).unwrap() + 1;
                    if p.id == own.id {
                        (Plan::Run("tab.move", json!({ "id": t, "index": index })), "Move here".into())
                    } else {
                        (Plan::Run("tab.move", json!({ "id": t, "space": p.id, "index": index })), format!("Move to {}", space_name(&p.id)))
                    }
                }
                Target::NewTab(space) => {
                    let s = space.clone().unwrap_or_else(|| own.id.clone());
                    match m.space(&s) {
                        None => (Plan::No("gone"), String::new()),
                        Some(_) if !m.same_machine(t, &s) => other,
                        Some(p) if p.id == own.id => {
                            if p.tabs.last().is_some_and(|c| c.id == *t) {
                                (Plan::No("already last"), "Already last".into())
                            } else {
                                (Plan::Run("tab.move", json!({ "id": t, "index": p.tabs.len() })), "Move to the end".into())
                            }
                        }
                        Some(_) => (Plan::Run("tab.move", json!({ "id": t, "space": s })), format!("Move to {}", space_name(&s))),
                    }
                }
                Target::Pane { pane, .. } if m.tab_of(pane).is_some_and(|c| c.id == *t) => (Plan::No("its own panes"), "Already this tab".into()),
                Target::Pane { pane, .. } if !m.same_machine(t, pane) => other,
                Target::Pane { pane, edge } => {
                    let edge = edge.unwrap_or_default();
                    (Plan::Run("tab.join", json!({ "id": t, "direction": edge_word(edge), "target": pane })), format!("Split, {}", edge_place(Some(edge))))
                }
            }
        }
        Dragged::Pane(p) => {
            let Some(from) = m.tab_of(p) else { return (Plan::No("gone"), String::new()) };
            let alone = from.root.panes().len() == 1;
            let own_space = m.space_of(p).map(|s| s.id.clone());
            match target {
                Target::Pane { pane, edge } if from.root.find(pane).is_some() => {
                    if pane == p {
                        (Plan::No("itself"), String::new())
                    } else {
                        (Plan::Rearrange { target: pane.clone(), edge: *edge }, if edge.is_some() { format!("Place {}", edge_place(*edge)) } else { "Swap places".into() })
                    }
                }
                Target::Pane { pane, .. } if !m.same_machine(p, pane) => other,
                Target::Pane { pane, edge } => {
                    let edge = edge.unwrap_or_default();
                    (Plan::Run("pane.move", json!({ "pane": p, "target": pane, "edge": edge_word(edge) })), format!("Place {}", edge_place(Some(edge))))
                }
                Target::Tab(u) if *u == from.id => (Plan::No("its own tab"), "Already in this tab".into()),
                Target::Tab(u) if m.tab(u).is_none() => (Plan::No("gone"), String::new()),
                Target::Tab(u) if !m.same_machine(p, u) => other,
                Target::Tab(u) => (Plan::Run("pane.move", json!({ "pane": p, "tab": u })), format!("Into tab {}", tab_name(u))),
                Target::NewTab(_) | Target::Space(_) if space_of(target).is_some_and(|s| m.space(s).is_none()) => (Plan::No("gone"), String::new()),
                Target::NewTab(_) | Target::Space(_) if space_of(target).is_some_and(|s| !m.same_machine(p, s)) => other,
                Target::NewTab(_) | Target::Space(_) if alone && space_of(target).is_none_or(|s| Some(s) == own_space.as_deref()) => (Plan::No("alone"), "Already alone in its tab".into()),
                Target::NewTab(None) => (Plan::Run("pane.move", json!({ "pane": p, "tab": "new" })), "New tab".into()),
                Target::NewTab(Some(s)) | Target::Space(s) => (Plan::Run("pane.move", json!({ "pane": p, "tab": "new", "space": s })), format!("New tab in {}", space_name(s))),
            }
        }
    }
}

fn space_of(target: &Target) -> Option<&str> {
    match target {
        Target::Space(s) | Target::NewTab(Some(s)) => Some(s),
        _ => None,
    }
}

impl AppWindow {
    /// A press on a mod's `drag_move` element: a drag once it moves.
    pub(super) fn move_press(&mut self, item: &Value, at: Point<Pixels>) {
        let id = |k: &str| item.get(k).and_then(Value::as_str).map(str::to_owned);
        let what = match (id("tab"), id("pane")) {
            (Some(tab), None) if self.model.tab(&tab).is_some() => Dragged::Tab(tab),
            (None, Some(pane)) if self.pane_movable(&pane) => Dragged::Pane(pane),
            _ => return,
        };
        // The grip's press came first (it's over the element).
        if self.move_drag.is_none() {
            self.move_drag = Some(MoveDrag::new(what, at, false));
        }
    }

    /// A press on a pane's grip.
    pub(super) fn grip_press(&mut self, pane: &str, at: Point<Pixels>, cx: &mut Context<Self>) {
        if self.pane_movable(pane) {
            self.move_drag = Some(MoveDrag::new(Dragged::Pane(pane.to_owned()), at, true));
            cx.notify();
        }
    }

    pub(super) fn dragging_pane(&self, pane: &str) -> bool {
        self.move_drag.as_ref().is_some_and(|d| d.what == Dragged::Pane(pane.to_owned()))
    }

    /// The pointer moved with a drag pressed (capture phase: targets report
    /// after this, in the bubble phase, and `settle_drag` reads them).
    fn drag_pointer(&mut self, at: Point<Pixels>, pressed: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(d) = self.move_drag.as_mut() else { return };
        if !pressed {
            self.cancel_move_drag(cx);
            return;
        }
        d.pointer = at;
        if !d.moving {
            if (at.x - d.down.x).abs().max((at.y - d.down.y).abs()) < settings::z(START) {
                return;
            }
            d.moving = true;
        }
        shell_drag::set_moving(true);
        shell_drag::clear_hit();
        cx.defer_in(window, |this, window, cx| this.settle_drag(window, cx));
        cx.notify();
    }

    /// What's under the pointer: a mod's target, else a pane of the shown tab.
    fn drag_over(&self, d: &MoveDrag, at: Point<Pixels>, hit: Option<MoveHit>) -> Option<Over> {
        let finish = |target: Target, raw: Value, bounds| {
            let (plan, label) = plan(&self.model, &home(), &d.what, &target);
            Over { target, raw, bounds, plan, label }
        };
        if let Some(hit) = hit
            && let Some(target) = parse_target(&hit.target)
        {
            return Some(finish(target, hit.target, hit.bounds));
        }
        let tab = self.model.active_tab()?;
        let own = matches!(&d.what, Dragged::Pane(p) if tab.root.find(p).is_some());
        let bounds = self.bounds.borrow();
        tab.shown().visible_blocks().into_iter()
            .filter(|n| n.is_pane() && d.what != Dragged::Pane(n.id.clone()))
            .find_map(|n| {
                let b = *bounds.get(&n.id)?;
                let edge = if own { pane_drag::drop_zone(b, at)? } else { Some(edge_zone(b, at)?) };
                let raw = json!({ "pane": n.id, "edge": edge.map(edge_word) });
                Some(finish(Target::Pane { pane: n.id.clone(), edge }, raw, b))
            })
    }

    /// After a move's listeners ran: the target now, and what follows from it.
    fn settle_drag(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(d) = self.move_drag.as_ref().filter(|d| d.moving) else { return };
        let over = self.drag_over(d, d.pointer, shell_drag::hit());
        let held = match (&d.what, over.as_ref().map(|o| &o.target)) {
            (Dragged::Pane(p), Some(Target::Tab(u))) if self.model.active_tab().is_some_and(|c| c.id != *u) && self.model.tab(u).is_some() && self.model.same_machine(p, u) => Some(u.clone()),
            _ => None,
        };
        let d = self.move_drag.as_mut().unwrap();
        d.over = over;
        if held.as_ref() != d.dwell.as_ref().map(|(t, _)| t) {
            d.dwell = held.map(|tab| {
                let id = tab.clone();
                let task = cx.spawn_in(window, async move |this, cx| {
                    cx.background_executor().timer(DWELL).await;
                    let _ = this.update_in(cx, |this, window, cx| this.dwelled(&id, window, cx));
                });
                (tab, task)
            });
        }
        self.publish_drag(cx);
        cx.notify();
    }

    /// A pane held over another tab long enough: that tab shows, and the drag
    /// goes on there.
    fn dwelled(&mut self, tab: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(d) = self.move_drag.as_mut() else { return };
        if !d.moving || d.dwell.as_ref().is_none_or(|(t, _)| t != tab) {
            return;
        }
        d.dwell = None;
        self.run("tab.select", json!({ "id": tab }), window, cx);
        // Its panes are targets once they're drawn.
        cx.defer_in(window, |this, window, cx| this.settle_drag(window, cx));
        cx.notify();
    }

    pub(super) fn cancel_move_drag(&mut self, cx: &mut Context<Self>) {
        if self.move_drag.take().is_some() {
            shell_drag::set_moving(false);
            self.publish_drag(cx);
            cx.notify();
        }
    }

    /// The release: returns whether it was the drag's (so nothing under it clicks).
    fn drag_release(&mut self, at: Point<Pixels>, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(d) = self.move_drag.take() else { return false };
        shell_drag::set_moving(false);
        cx.notify();
        if !d.moving {
            // A click: the grip's is its own; an element's goes on to the element.
            return d.grip;
        }
        // Where it's released (the pointer may get there without a move).
        let last = d.over.as_ref().filter(|o| o.bounds.contains(&at) && !matches!(o.target, Target::Pane { .. }))
            .map(|o| MoveHit { target: o.raw.clone(), bounds: o.bounds });
        let plan = self.drag_over(&d, at, last).map(|o| o.plan);
        self.publish_drag(cx);
        let ours = match plan {
            Some(Plan::Itself) => false,
            Some(Plan::Run(name, args)) => {
                self.run(name, args, window, cx);
                true
            }
            Some(Plan::Rearrange { target, edge }) => {
                if let Dragged::Pane(pane) = &d.what
                    && self.pane_movable(pane)
                    && self.model.move_pane(pane, &target, edge)
                {
                    self.sync(window, cx);
                }
                true
            }
            Some(Plan::No(_)) | None => true,
        };
        cx.defer_in(window, |this, window, cx| this.restore_focus(window, cx));
        ours
    }

    /// `drag()` for mods: what's dragged, where from, and what's under the
    /// pointer, once it's a drag.
    pub(super) fn drag_json(&self) -> Value {
        let Some(d) = self.move_drag.as_ref().filter(|d| d.moving) else { return Value::Null };
        let (tab, pane) = match &d.what {
            Dragged::Tab(t) => (Some(t.clone()), None),
            Dragged::Pane(p) => (self.model.tab_of(p).map(|c| c.id.clone()), Some(p.clone())),
        };
        let id = pane.as_deref().or(tab.as_deref()).unwrap_or_default();
        let space = self.model.space_of(id);
        let mut v = json!({
            "tab": tab, "space": space.map(|s| s.id.clone()), "machine": space.and_then(|s| s.machine.clone()),
            "over": d.over.as_ref().map(|o| o.raw.clone()),
            "valid": d.over.as_ref().is_some_and(|o| matches!(o.plan, Plan::Run(..) | Plan::Rearrange { .. })),
        });
        if let Some(pane) = pane {
            v["pane"] = json!(pane);
        }
        v
    }

    fn publish_drag(&mut self, cx: &mut Context<Self>) {
        if mods::publish_drag(self.drag_json()) {
            self.refresh_snapshot_mods(cx);
        }
    }

    /// What the ghost says is dragged.
    fn dragged_name(&self, d: &MoveDrag, cx: &App) -> String {
        match &d.what {
            Dragged::Tab(t) => self.model.space_of(t).zip(self.model.tab(t)).map(|(p, c)| Model::tab_name(p, c)).unwrap_or_default(),
            Dragged::Pane(p) => self.terms.get(p).map(|t| t.view.read(cx).title.clone()).filter(|s| !s.trim().is_empty())
                .or_else(|| match self.model.tab_of(p).and_then(|c| c.root.find(p)).and_then(Node::content) {
                    Some(Content::Mod { name, .. }) => Some(name.clone()),
                    // No title yet: what it runs, as its header says.
                    _ => self.model.address_of(p).map(|a| self.program(&a)["name"].as_str().map(str::to_owned).unwrap_or(a)),
                })
                .unwrap_or_else(|| "pane".into()),
        }
    }

    /// Over the window: the pane preview, the ghost at the pointer, and the
    /// listeners that follow the pointer anywhere while a drag is pressed.
    pub(super) fn drag_layer(&self, cx: &mut Context<Self>) -> AnyElement {
        let d = self.move_drag.as_ref();
        let moving = d.is_some_and(|d| d.moving);
        let over = d.and_then(|d| d.over.as_ref());
        let valid = over.is_some_and(|o| matches!(o.plan, Plan::Run(..) | Plan::Rearrange { .. }));
        let preview = over.filter(|_| valid).and_then(|o| match &o.target {
            Target::Pane { edge, .. } => {
                let mut b = o.bounds;
                match edge {
                    Some(Edge::Left) => b.size.width /= 2.,
                    Some(Edge::Right) => { b.size.width /= 2.; b.origin.x += b.size.width; }
                    Some(Edge::Top) => b.size.height /= 2.,
                    Some(Edge::Bottom) => { b.size.height /= 2.; b.origin.y += b.size.height; }
                    None => {}
                }
                Some(div().absolute().left(b.origin.x).top(b.origin.y).w(b.size.width).h(b.size.height)
                    .bg(c("accent").opacity(0.18)).border_2().border_color(c("accent")).into_any_element())
            }
            _ => None,
        });
        let ghost = d.filter(|d| d.moving).map(|d| {
            let label = over.map(|o| o.label.clone()).filter(|l| !l.is_empty());
            let refused = over.is_some_and(|o| matches!(o.plan, Plan::No(_)));
            // Kept inside the window near its edges.
            anchored().position(d.pointer + point(settings::z(14.), settings::z(14.))).snap_to_window_with_margin(settings::z(6.)).child(div()
                .max_w(settings::z(260.)).px(settings::z(9.)).py(settings::z(5.)).rounded(settings::z(7.))
                .bg(c("popover")).border_1().border_color(if refused { c("blocked") } else if valid { c("accent") } else { c("border") })
                .shadow_md().flex().flex_col().gap(settings::z(1.)).text_size(settings::z(12.))
                .child(div().truncate().text_color(c("foreground")).child(self.dragged_name(d, cx)))
                .children(label.map(|l| div().truncate().text_size(settings::z(11.)).text_color(if refused { c("blocked") } else { c("muted") }).child(l))))
                .into_any_element()
        });
        let this = cx.entity().downgrade();
        div().id("move-drag-layer").absolute().inset_0()
            // Over where it came from, the element keeps the release (a click).
            .when(moving && !over.is_some_and(|o| o.plan == Plan::Itself), |el| el.occlude().cursor(if over.is_some_and(|o| matches!(o.plan, Plan::No(_))) { CursorStyle::OperationNotAllowed } else { CursorStyle::ClosedHand }))
            .children(preview).children(ghost).child(canvas(
            |_, _, _| {},
            move |_, _, window, _| {
                let t = this.clone();
                window.on_mouse_event(move |ev: &MouseMoveEvent, phase, window, cx| {
                    if phase == DispatchPhase::Capture {
                        let _ = t.update(cx, |this, cx| {
                            this.grip_hover(ev.position, cx);
                            this.drag_pointer(ev.position, ev.pressed_button == Some(MouseButton::Left), window, cx);
                        });
                    }
                });
                let t = this.clone();
                window.on_mouse_event(move |ev: &MouseUpEvent, phase, window, cx| {
                    if phase == DispatchPhase::Capture && ev.button == MouseButton::Left
                        && t.update(cx, |this, cx| this.drag_release(ev.position, window, cx)).unwrap_or(false)
                    { cx.stop_propagation(); }
                });
            },
        ).absolute().size_full()).into_any_element()
    }
}

/// Presses on `drag_move` elements, for the window.
pub(super) struct Host(pub WeakEntity<AppWindow>);

impl shell_drag::MoveHost for Host {
    fn press(&self, item: &Value, at: Point<Pixels>, _: &mut Window, cx: &mut App) {
        let _ = self.0.update(cx, |this, _| this.move_press(item, at));
    }
}

#[cfg(test)]
mod tests {
    use super::{Dragged, Plan, Target, edge_zone, parse_target, plan};
    use crate::layout::Edge;
    use crate::model::{Model, Tab};
    use gpui::{Bounds, point, px, size};
    use serde_json::json;

    /// p1 (c1: x1 | x4, c2: x2), p2 (c3: x3) here; vps/p9 (vps/c9) on another machine.
    fn world() -> Model {
        let mut m = Model::default();
        m.add_space("p1", "api", "/src", Tab::new("c1", "one", "x1", "t1"));
        m.add_tab("p1", Tab::new("c2", "two", "x2", "t2"));
        m.split("x1", crate::layout::Axis::Row, "x4", "t4");
        m.add_space("p2", "web", "/web", Tab::new("c3", "", "x3", "t3"));
        m.add_space("vps/p9", "far", "/", Tab::new("vps/c9", "", "vps/x9", "vps/t9"));
        m.space_mut("vps/p9").unwrap().machine = Some("vps".into());
        m.select_tab("c1");
        m
    }

    fn run(p: (Plan, String)) -> Option<(&'static str, serde_json::Value)> {
        match p.0 {
            Plan::Run(name, args) => Some((name, args)),
            _ => None,
        }
    }

    #[test]
    fn targets_are_what_mods_said() {
        assert_eq!(parse_target(&json!({"space": "p2"})), Some(Target::Space("p2".into())));
        assert_eq!(parse_target(&json!({"tab": "c3"})), Some(Target::Tab("c3".into())));
        assert_eq!(parse_target(&json!({"tab": "new"})), Some(Target::NewTab(None)));
        assert_eq!(parse_target(&json!({"tab": "new", "space": "p2"})), Some(Target::NewTab(Some("p2".into()))));
        for nothing in [json!({}), json!({"tab": ""}), json!({"space": 3}), json!({"tab": "c3", "space": "p2"}), json!({"pane": "x1"})] {
            assert_eq!(parse_target(&nothing), None, "{nothing}");
        }
    }

    #[test]
    fn another_tabs_pane_is_all_edges() {
        let b = Bounds::new(point(px(100.), px(200.)), size(px(800.), px(400.)));
        for (x, y, edge) in [(110., 400., Some(Edge::Left)), (890., 400., Some(Edge::Right)), (500., 210., Some(Edge::Top)),
            (500., 590., Some(Edge::Bottom)), (480., 400., Some(Edge::Left)), (520., 400., Some(Edge::Right)), (99., 400., None)] {
            assert_eq!(edge_zone(b, point(px(x), px(y))), edge, "{x},{y}");
        }
    }

    #[test]
    fn a_dragged_tab_moves_to_a_space_or_a_place_or_joins_a_pane() {
        let m = world();
        let tab = Dragged::Tab("c2".into());
        assert_eq!(run(plan(&m, "/", &tab, &Target::Space("p2".into()))), Some(("tab.move", json!({"id": "c2", "space": "p2"}))));
        assert_eq!(plan(&m, "/", &tab, &Target::Space("p2".into())).1, "Move to web");
        // Its own space, another machine's, or a space gone: nothing.
        for s in ["p1", "vps/p9", "gone"] {
            assert!(matches!(plan(&m, "/", &tab, &Target::Space(s.into())).0, Plan::No(_)), "{s}");
        }
        // Onto a tab: where that tab is, in its space.
        assert_eq!(run(plan(&m, "/", &tab, &Target::Tab("c1".into()))), Some(("tab.move", json!({"id": "c2", "index": 1}))));
        assert_eq!(run(plan(&m, "/", &tab, &Target::Tab("c3".into()))), Some(("tab.move", json!({"id": "c2", "space": "p2", "index": 1}))));
        assert_eq!(plan(&m, "/", &tab, &Target::Tab("c2".into())).0, Plan::Itself);
        assert!(matches!(plan(&m, "/", &tab, &Target::Tab("vps/c9".into())).0, Plan::No(_)));
        // The bar's empty end: last, unless it is.
        assert!(matches!(plan(&m, "/", &tab, &Target::NewTab(None)).0, Plan::No(_)));
        assert_eq!(run(plan(&m, "/", &Dragged::Tab("c1".into()), &Target::NewTab(None))), Some(("tab.move", json!({"id": "c1", "index": 2}))));
        assert_eq!(run(plan(&m, "/", &tab, &Target::NewTab(Some("p2".into())))), Some(("tab.move", json!({"id": "c2", "space": "p2"}))));
        // Into a pane of another tab, at each edge; never its own panes or another machine's.
        for (edge, word) in [(Edge::Left, "left"), (Edge::Right, "right"), (Edge::Top, "up"), (Edge::Bottom, "down")] {
            assert_eq!(run(plan(&m, "/", &tab, &Target::Pane { pane: "x4".into(), edge: Some(edge) })),
                Some(("tab.join", json!({"id": "c2", "direction": word, "target": "x4"}))));
        }
        assert!(matches!(plan(&m, "/", &Dragged::Tab("c1".into()), &Target::Pane { pane: "x4".into(), edge: Some(Edge::Left) }).0, Plan::No(_)));
        assert!(matches!(plan(&m, "/", &Dragged::Tab("vps/c9".into()), &Target::Pane { pane: "x4".into(), edge: Some(Edge::Left) }).0, Plan::No(_)));
    }

    #[test]
    fn a_dragged_pane_goes_into_a_tab_beside_a_pane_or_into_a_new_tab() {
        let m = world();
        let pane = Dragged::Pane("x4".into());
        // In its own tab: the grip's swap and edges.
        assert_eq!(plan(&m, "/", &pane, &Target::Pane { pane: "x1".into(), edge: None }).0, Plan::Rearrange { target: "x1".into(), edge: None });
        assert_eq!(plan(&m, "/", &pane, &Target::Pane { pane: "x1".into(), edge: Some(Edge::Top) }).0, Plan::Rearrange { target: "x1".into(), edge: Some(Edge::Top) });
        // Another tab's pane, the tab itself, a new tab, a space.
        assert_eq!(run(plan(&m, "/", &pane, &Target::Pane { pane: "x3".into(), edge: Some(Edge::Left) })), Some(("pane.move", json!({"pane": "x4", "target": "x3", "edge": "left"}))));
        assert_eq!(run(plan(&m, "/", &pane, &Target::Tab("c2".into()))), Some(("pane.move", json!({"pane": "x4", "tab": "c2"}))));
        assert_eq!(plan(&m, "/", &pane, &Target::Tab("c2".into())).1, "Into tab two");
        assert_eq!(run(plan(&m, "/", &pane, &Target::NewTab(None))), Some(("pane.move", json!({"pane": "x4", "tab": "new"}))));
        assert_eq!(run(plan(&m, "/", &pane, &Target::Space("p2".into()))), Some(("pane.move", json!({"pane": "x4", "tab": "new", "space": "p2"}))));
        assert_eq!(run(plan(&m, "/", &pane, &Target::Space("p1".into()))), Some(("pane.move", json!({"pane": "x4", "tab": "new", "space": "p1"}))));
        // Its own tab, another machine's places: nothing.
        for target in [Target::Tab("c1".into()), Target::Tab("vps/c9".into()), Target::Space("vps/p9".into()), Target::NewTab(Some("vps/p9".into())),
            Target::Pane { pane: "vps/x9".into(), edge: Some(Edge::Left) }, Target::Space("gone".into())] {
            assert!(matches!(plan(&m, "/", &pane, &target).0, Plan::No(_)), "{target:?}");
        }
        // A tab's only pane is already alone there.
        let lone = Dragged::Pane("x2".into());
        assert!(matches!(plan(&m, "/", &lone, &Target::NewTab(None)).0, Plan::No(_)));
        assert!(matches!(plan(&m, "/", &lone, &Target::Space("p1".into())).0, Plan::No(_)));
        assert!(matches!(run(plan(&m, "/", &lone, &Target::Space("p2".into()))), Some(("pane.move", _))));
    }
}
