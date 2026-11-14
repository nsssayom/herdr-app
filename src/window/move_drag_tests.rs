/// A list like the shipped sidebar and tab bar: a 20 px row per space and per
/// tab (drag sources and targets), then a new-tab row, in a 200 px column
/// beside the shown tab's panes.
const MOVE_PROBE: &str = r#"
import { View, div } from "gpui-kit";
import { spaces, run } from "herdr";
export default class Probe extends View {
  render() {
    const row = (id) => div().id(id).h(20).w(200).flex_none();
    return div().size_full().flex().flex_col().children(spaces().flatMap(s => [
      row(`space-${s.id}`).drop_move({ space: s.id }),
      ...s.tabs.map(t => row(`tab-${t.id}`).drag_move({ tab: t.id }).drop_move({ tab: t.id })
        .on_click(() => run("tab.select", { id: t.id }))),
    ])).child(row("new").drop_move({ tab: "new" }));
  }
}
"#;

thread_local! {
    /// Where the probe's column starts (below the window's title bar).
    static PROBE_TOP: std::cell::Cell<f32> = const { std::cell::Cell::new(0.) };
}

/// The `i`th 20 px row of the probe.
fn probe_at(i: usize) -> gpui::Point<gpui::Pixels> {
    gpui::point(gpui::px(100.), gpui::px(PROBE_TOP.get() + 20. * i as f32 + 10.))
}

/// The rows `MOVE_PROBE` draws for `move_world` (plus x4 beside x1): p1, c1, c2, p2, c3, vps/p9, vps/c9, new.
fn probe_row(id: &str) -> gpui::Point<gpui::Pixels> {
    let rows = ["space-p1", "tab-c1", "tab-c2", "space-p2", "tab-c3", "space-vps/p9", "tab-vps/c9", "new"];
    probe_at(rows.iter().position(|r| *r == id).unwrap())
}

fn move_window(cx: &mut gpui::TestAppContext) -> (gpui::Entity<super::AppWindow>, &mut gpui::VisualTestContext) {
    use serde_json::json;
    let (view, cx) = open_window(cx, "move-probe", MOVE_PROBE, json!({
        "id": "root", "type": "row", "children": [
            {"id": "probe", "type": "block", "size": {"px": 200}, "content": {"mod": "move-probe"}},
            {"id": "context", "type": "block", "content": {"tab": "active"}}
        ]
    }));
    view.update_in(cx, |this, _, cx| {
        move_world(this);
        this.model.split("x1", super::Axis::Row, "x4", "t4");
        this.publish(cx);
    });
    cx.simulate_resize(gpui::size(gpui::px(1000.), gpui::px(600.)));
    move_frame(cx);
    let top = view.update(cx, |this, _| this.bounds.borrow()["probe"].origin.y);
    PROBE_TOP.set(f32::from(top));
    (view, cx)
}

fn move_frame(cx: &mut gpui::VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.run_until_parked();
}

fn pane_at(view: &gpui::Entity<super::AppWindow>, cx: &mut gpui::VisualTestContext, pane: &str) -> gpui::Bounds<gpui::Pixels> {
    view.update(cx, |this, _| this.bounds.borrow()[pane])
}

fn press(cx: &mut gpui::VisualTestContext, at: gpui::Point<gpui::Pixels>) {
    cx.simulate_mouse_move(at, None, gpui::Modifiers::default());
    move_frame(cx);
    cx.simulate_mouse_down(at, gpui::MouseButton::Left, gpui::Modifiers::default());
    move_frame(cx);
}

fn drag_to(cx: &mut gpui::VisualTestContext, at: gpui::Point<gpui::Pixels>) {
    cx.simulate_mouse_move(at, Some(gpui::MouseButton::Left), gpui::Modifiers::default());
    move_frame(cx);
}

fn release(cx: &mut gpui::VisualTestContext, at: gpui::Point<gpui::Pixels>) {
    cx.simulate_mouse_up(at, gpui::MouseButton::Left, gpui::Modifiers::default());
    move_frame(cx);
}

/// A press, a move past the threshold, then onto `to`.
fn drag(cx: &mut gpui::VisualTestContext, from: gpui::Point<gpui::Pixels>, to: gpui::Point<gpui::Pixels>) {
    press(cx, from);
    drag_to(cx, from + gpui::point(gpui::px(0.), gpui::px(6.)));
    drag_to(cx, to);
}

fn grip(view: &gpui::Entity<super::AppWindow>, cx: &mut gpui::VisualTestContext, pane: &str) -> gpui::Point<gpui::Pixels> {
    let b = pane_at(view, cx, pane);
    gpui::point(b.center().x, b.top() + gpui::px(9.))
}

fn grip_drag(view: &gpui::Entity<super::AppWindow>, cx: &mut gpui::VisualTestContext, pane: &str, to: gpui::Point<gpui::Pixels>) {
    let from = grip(view, cx, pane);
    drag(cx, from, to);
}

fn tab_ids(view: &gpui::Entity<super::AppWindow>, cx: &mut gpui::VisualTestContext, space: &str) -> Vec<String> {
    view.update(cx, |this, _| this.model.space(space).map(|p| p.tabs.iter().map(|c| c.id.clone()).collect()).unwrap_or_default())
}

fn panes_of(view: &gpui::Entity<super::AppWindow>, cx: &mut gpui::VisualTestContext, tab: &str) -> Vec<String> {
    view.update(cx, |this, _| this.model.tab(tab).map(|c| c.root.panes().iter().map(|n| n.id.clone()).collect()).unwrap_or_default())
}

fn drag_state(view: &gpui::Entity<super::AppWindow>, cx: &mut gpui::VisualTestContext) -> serde_json::Value {
    view.update(cx, |this, _| this.drag_json())
}

fn world_of(view: &gpui::Entity<super::AppWindow>, cx: &mut gpui::VisualTestContext) -> String {
    view.update(cx, |this, _| format!("{:?} {:?}", this.model.spaces, this.model.active))
}

#[track_caller]
fn settled(view: &gpui::Entity<super::AppWindow>, cx: &mut gpui::VisualTestContext) {
    let left = view.update(cx, |this, _| {
        this.changing_terminals.clear();
        this.pending_terminals.clear();
        this.move_drag.as_ref().map(|d| format!("{:?} moving {}", d.what, d.moving))
    });
    assert_eq!(left, None, "the drag ended");
    assert!(!gpui_shell::move_drag::moving());
}

#[test]
fn a_tab_dragged_onto_a_space_moves_there_runs_in_its_own_window() {
    in_own_process("tab_dragged_onto_a_space");
}

#[gpui::test]
fn tab_dragged_onto_a_space(cx: &mut gpui::TestAppContext) {
    use serde_json::json;
    if !running_alone("tab_dragged_onto_a_space") { return; }
    let (view, cx) = move_window(cx);
    // Below 4 px it's a press: nothing is dragged, and the release is a click (it selects).
    press(cx, probe_row("tab-c2"));
    drag_to(cx, probe_row("tab-c2") + gpui::point(gpui::px(3.), gpui::px(0.)));
    assert_eq!(drag_state(&view, cx), serde_json::Value::Null);
    release(cx, probe_row("tab-c2") + gpui::point(gpui::px(3.), gpui::px(0.)));
    assert_eq!(view.update(cx, |this, _| this.model.active_tab().map(|c| c.id.clone())), Some("c2".into()));
    view.update(cx, |this, _| { this.model.select_tab("c1"); });
    settled(&view, cx);

    // Onto another machine's space: shown as refused, and the drop does nothing.
    let before = world_of(&view, cx);
    drag(cx, probe_row("tab-c2"), probe_row("space-vps/p9"));
    assert_eq!(drag_state(&view, cx), json!({"tab": "c2", "space": "p1", "machine": null, "over": {"space": "vps/p9"}, "valid": false}));
    release(cx, probe_row("space-vps/p9"));
    assert_eq!(world_of(&view, cx), before);
    settled(&view, cx);

    // Escape cancels; so does letting go where nothing takes it.
    drag(cx, probe_row("tab-c2"), probe_row("space-p2"));
    assert_eq!(drag_state(&view, cx)["valid"], true);
    cx.simulate_keystrokes("escape");
    move_frame(cx);
    assert_eq!(drag_state(&view, cx), serde_json::Value::Null);
    release(cx, probe_row("space-p2"));
    assert_eq!(world_of(&view, cx), before);
    drag(cx, probe_row("tab-c2"), gpui::point(gpui::px(100.), gpui::px(400.)));
    assert_eq!(drag_state(&view, cx)["over"], serde_json::Value::Null);
    release(cx, gpui::point(gpui::px(100.), gpui::px(400.)));
    assert_eq!(world_of(&view, cx), before);
    settled(&view, cx);

    // Onto a space of its machine: it moves there, last, terminals running.
    drag(cx, probe_row("tab-c2"), probe_row("space-p2"));
    assert_eq!(drag_state(&view, cx), json!({"tab": "c2", "space": "p1", "machine": null, "over": {"space": "p2"}, "valid": true}));
    assert_eq!(view.update(cx, |this, _| this.move_drag.as_ref().and_then(|d| d.over.as_ref()).map(|o| o.label.clone())), Some("Move to web".into()));
    release(cx, probe_row("space-p2"));
    assert_eq!(tab_ids(&view, cx, "p2"), ["c3", "c2"]);
    assert_eq!(tab_ids(&view, cx, "p1"), ["c1"]);
    assert_eq!(view.update(cx, |this, _| this.model.active_tab().map(|c| c.id.clone())), Some("c1".into()), "what's shown stays");
    assert_eq!(drag_state(&view, cx), serde_json::Value::Null);
    settled(&view, cx);

    // Onto another tab: it takes that tab's place (the tab bar's reorder). The rows moved: c2 is under p2 now.
    let rows = |this: &super::AppWindow| this.model.spaces.iter().flat_map(|p| std::iter::once(format!("space-{}", p.id)).chain(p.tabs.iter().map(|c| format!("tab-{}", c.id)))).collect::<Vec<_>>();
    assert_eq!(view.update(cx, |this, _| rows(this)), ["space-p1", "tab-c1", "space-p2", "tab-c3", "tab-c2", "space-vps/p9", "tab-vps/c9"]);
    let row = probe_at;
    drag(cx, row(4), row(3));
    release(cx, row(3));
    assert_eq!(tab_ids(&view, cx, "p2"), ["c2", "c3"]);
    // Dropped back on itself: the release is the element's own click.
    drag(cx, row(3), row(3) + gpui::point(gpui::px(40.), gpui::px(0.)));
    assert_eq!(view.update(cx, |this, _| this.move_drag.as_ref().and_then(|d| d.over.as_ref()).map(|o| o.target.clone())), Some(super::move_drag::Target::Tab("c2".into())));
    release(cx, row(3) + gpui::point(gpui::px(40.), gpui::px(0.)));
    assert_eq!(tab_ids(&view, cx, "p2"), ["c2", "c3"]);
    assert_eq!(view.update(cx, |this, _| this.model.active_tab().map(|c| c.id.clone())), Some("c2".into()));
    settled(&view, cx);
}

#[test]
fn a_tab_dragged_into_the_panes_joins_beside_one_runs_in_its_own_window() {
    in_own_process("tab_dragged_into_the_panes");
}

#[gpui::test]
fn tab_dragged_into_the_panes(cx: &mut gpui::TestAppContext) {
    use serde_json::json;
    if !running_alone("tab_dragged_into_the_panes") { return; }
    let (view, cx) = move_window(cx);
    let x4 = pane_at(&view, cx, "x4");
    // The shown tab onto its own panes: nothing.
    let before = world_of(&view, cx);
    let left = gpui::point(x4.left() + gpui::px(10.), x4.center().y);
    drag(cx, probe_row("tab-c1"), left);
    assert_eq!(drag_state(&view, cx)["over"], json!({"pane": "x4", "edge": "left"}));
    assert_eq!(drag_state(&view, cx)["valid"], false);
    release(cx, left);
    assert_eq!(world_of(&view, cx), before);
    settled(&view, cx);
    // Another tab: it joins on the edge it's dropped on, even from the middle of the pane.
    let middle_left = gpui::point(x4.center().x - gpui::px(5.), x4.center().y);
    drag(cx, probe_row("tab-c2"), middle_left);
    assert_eq!(drag_state(&view, cx), json!({"tab": "c2", "space": "p1", "machine": null, "over": {"pane": "x4", "edge": "left"}, "valid": true}));
    release(cx, middle_left);
    assert_eq!(panes_of(&view, cx, "c1"), ["x1", "x2", "x4"]);
    assert!(view.update(cx, |this, _| this.model.tab("c2").is_none()));
    settled(&view, cx);
    // Up: above the pane.
    let x3_tab = probe_row("tab-c3") - gpui::point(gpui::px(0.), gpui::px(20.));
    let x1 = pane_at(&view, cx, "x1");
    let top = gpui::point(x1.center().x, x1.top() + gpui::px(30.));
    drag(cx, x3_tab, top);
    assert_eq!(drag_state(&view, cx)["over"], json!({"pane": "x1", "edge": "up"}));
    release(cx, top);
    let c1 = view.update(cx, |this, _| this.model.tab("c1").unwrap().clone());
    assert_eq!(c1.root.panes().iter().map(|n| n.id.as_str()).collect::<Vec<_>>(), ["x3", "x1", "x2", "x4"]);
    assert_eq!(c1.root.parent_of("x3").unwrap().axis(), Some(super::Axis::Column));
    assert!(view.update(cx, |this, _| this.model.space("p2").is_none()), "its space emptied and closed");
    settled(&view, cx);
}

#[test]
fn a_pane_dragged_by_its_grip_goes_to_other_tabs_runs_in_its_own_window() {
    in_own_process("pane_dragged_to_other_tabs");
}

#[gpui::test]
fn pane_dragged_to_other_tabs(cx: &mut gpui::TestAppContext) {
    use serde_json::json;
    if !running_alone("pane_dragged_to_other_tabs") { return; }
    let (view, cx) = move_window(cx);
    // Let go where nothing takes it, or Escape: nothing moves.
    let before = world_of(&view, cx);
    let nowhere = probe_at(20);
    grip_drag(&view, cx, "x4", nowhere);
    assert_eq!(drag_state(&view, cx)["over"], serde_json::Value::Null);
    release(cx, nowhere);
    let x1 = pane_at(&view, cx, "x1");
    grip_drag(&view, cx, "x4", x1.center());
    cx.simulate_keystrokes("escape");
    move_frame(cx);
    release(cx, x1.center());
    assert_eq!(world_of(&view, cx), before);
    settled(&view, cx);
    // The old in-tab drag: the middle of the other pane swaps.
    let x1 = pane_at(&view, cx, "x1");
    grip_drag(&view, cx, "x4", x1.center());
    assert_eq!(drag_state(&view, cx), json!({"tab": "c1", "pane": "x4", "space": "p1", "machine": null, "over": {"pane": "x1", "edge": null}, "valid": true}));
    release(cx, x1.center());
    assert_eq!(panes_of(&view, cx, "c1"), ["x4", "x1"]);
    settled(&view, cx);
    // Onto its own tab, or another machine's: nothing.
    let before = world_of(&view, cx);
    for row in ["tab-c1", "tab-vps/c9", "space-vps/p9"] {
        grip_drag(&view, cx, "x4", probe_row(row));
        assert_eq!(drag_state(&view, cx)["valid"], false, "{row}");
        release(cx, probe_row(row));
        assert_eq!(world_of(&view, cx), before, "{row}");
        settled(&view, cx);
    }
    // Onto a tab: into it, beside its focused pane.
    grip_drag(&view, cx, "x4", probe_row("tab-c3"));
    assert_eq!(drag_state(&view, cx)["over"], json!({"tab": "c3"}));
    release(cx, probe_row("tab-c3"));
    assert_eq!(panes_of(&view, cx, "c3"), ["x3", "x4"]);
    assert_eq!(view.update(cx, |this, _| this.model.active_tab().map(|c| c.id.clone())), Some("c1".into()));
    settled(&view, cx);
    // Held over a tab, it shows that tab; dropped on a pane's edge there, it goes beside it.
    view.update_in(cx, |this, _, cx| { this.model.split("x1", super::Axis::Row, "x5", "t5"); this.publish(cx); });
    move_frame(cx);
    grip_drag(&view, cx, "x5", probe_row("tab-c2"));
    assert_eq!(view.update(cx, |this, _| this.model.active_tab().map(|c| c.id.clone())), Some("c1".into()), "not yet");
    cx.executor().advance_clock(super::move_drag::DWELL + std::time::Duration::from_millis(50));
    move_frame(cx);
    assert_eq!(view.update(cx, |this, _| this.model.active_tab().map(|c| c.id.clone())), Some("c2".into()));
    assert!(view.update(cx, |this, _| this.move_drag.as_ref().is_some_and(|d| d.moving)), "the drag goes on");
    let x2 = pane_at(&view, cx, "x2");
    let right = gpui::point(x2.right() - gpui::px(10.), x2.center().y);
    drag_to(cx, right);
    assert_eq!(drag_state(&view, cx)["over"], json!({"pane": "x2", "edge": "right"}));
    release(cx, right);
    assert_eq!(panes_of(&view, cx, "c2"), ["x2", "x5"]);
    assert_eq!(panes_of(&view, cx, "c1"), ["x1"]);
    settled(&view, cx);
    // Out into a new tab, after its own; onto a space, a new tab last there.
    grip_drag(&view, cx, "x5", probe_row("new"));
    // The rows: p1, c1, c2, p2, c3, ... new is after vps/c9 still.
    assert_eq!(drag_state(&view, cx)["over"], json!({"tab": "new"}));
    release(cx, probe_row("new"));
    let p1 = tab_ids(&view, cx, "p1");
    assert_eq!(p1.len(), 3);
    assert_eq!(&p1[..2], ["c1", "c2"]);
    assert_eq!(panes_of(&view, cx, &p1[2]), ["x5"]);
    settled(&view, cx);
    view.update_in(cx, |this, _, cx| { this.model.select_tab("c3"); this.publish(cx); });
    move_frame(cx);
    // The rows grew by the new tab: p2 is one lower.
    let p2 = probe_row("space-p2") + gpui::point(gpui::px(0.), gpui::px(20.));
    grip_drag(&view, cx, "x3", p2);
    assert_eq!(drag_state(&view, cx)["over"], json!({"space": "p2"}));
    release(cx, p2);
    let tabs = tab_ids(&view, cx, "p2");
    assert_eq!(tabs.len(), 2);
    assert_eq!(panes_of(&view, cx, &tabs[1]), ["x3"]);
    settled(&view, cx);
}
