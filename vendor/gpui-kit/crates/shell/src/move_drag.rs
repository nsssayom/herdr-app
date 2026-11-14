//! HERDR: moves the host runs when something is dragged onto a target (a tab
//! onto a space, a pane onto a tab). Elements only say what they are:
//! `drag_move(item)` hands a left press to the host, which decides whether
//! the press becomes a drag; `drop_move(target)` is a place to drop one.
//! The host tracks the pointer, draws the drag and decides what a drop does.
//!
//! A target reports itself while the pointer is over its visible box,
//! whatever is drawn over it: a drag covers the window so nothing below
//! reacts to it, and views drawn from cache still report (their mouse
//! listeners are replayed with the box they were painted at).

use gpui::{AnyElement, App, Bounds, DispatchPhase, Element, ElementId, GlobalElementId, InspectorElementId, InteractiveElement, IntoElement, LayoutId, MouseButton, MouseMoveEvent, Pixels, Point, Window};
use serde_json::Value;
use std::cell::{Cell, RefCell};
use std::rc::Rc;

/// What the host does with a press on a `drag_move` element.
pub trait MoveHost {
    /// A left press on an element that can be dragged; `item` is what it said
    /// it is (`{tab}` or `{pane}`), `at` where the press was (window px).
    fn press(&self, item: &Value, at: Point<Pixels>, window: &mut Window, cx: &mut App);
}

/// The innermost target under the pointer at the last move.
#[derive(Clone, Debug, PartialEq)]
pub struct MoveHit {
    pub target: Value,
    /// Its visible box, window px.
    pub bounds: Bounds<Pixels>,
}

thread_local! {
    static HOST: RefCell<Option<Rc<dyn MoveHost>>> = const { RefCell::new(None) };
    static MOVING: Cell<bool> = const { Cell::new(false) };
    static HIT: RefCell<Option<MoveHit>> = const { RefCell::new(None) };
}

/// Who presses on `drag_move` elements go to (the last one set).
pub fn set_host(host: Rc<dyn MoveHost>) {
    HOST.with_borrow_mut(|h| *h = Some(host));
}

/// Whether a drag is moving: only then do targets report themselves.
pub fn set_moving(moving: bool) {
    MOVING.set(moving);
    if !moving {
        clear_hit();
    }
}

pub fn moving() -> bool {
    MOVING.get()
}

/// Forgets the last hit. The host calls this in the capture phase of every
/// move, so what targets report in the bubble phase is about this move.
pub fn clear_hit() {
    HIT.with_borrow_mut(|h| *h = None);
}

/// The target the pointer is over after this move's listeners ran (read it
/// after dispatch, e.g. from a deferred callback).
pub fn hit() -> Option<MoveHit> {
    HIT.with_borrow(Clone::clone)
}

/// Makes `element` a drag source: its left presses go to the host.
pub(crate) fn source<E: InteractiveElement>(element: E, item: Value) -> E {
    element.capture_any_mouse_down(move |event, window, cx| {
        if event.button != MouseButton::Left {
            return;
        }
        if let Some(host) = HOST.with_borrow(Clone::clone) {
            host.press(&item, event.position, window, cx);
        }
    })
}

/// Makes `element` a drop target. The innermost target under the pointer
/// wins: this registers before painting what's inside, so an inner target
/// hears the move first.
pub(crate) fn target(element: AnyElement, target: Value) -> AnyElement {
    DropTarget { element, target }.into_any_element()
}

/// Reuses the element's own layout node, like the size observer.
struct DropTarget {
    element: AnyElement,
    target: Value,
}

impl IntoElement for DropTarget {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}

impl Element for DropTarget {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, window: &mut Window, cx: &mut App) -> (LayoutId, ()) {
        (self.element.request_layout(window, cx), ())
    }

    fn prepaint(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, _: Bounds<Pixels>, _: &mut (), window: &mut Window, cx: &mut App) {
        self.element.prepaint(window, cx);
    }

    fn paint(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, bounds: Bounds<Pixels>, _: &mut (), _: &mut (), window: &mut Window, cx: &mut App) {
        let visible = bounds.intersect(&window.content_mask().bounds);
        let target = self.target.clone();
        window.on_mouse_event(move |event: &MouseMoveEvent, phase, _, _| {
            if phase != DispatchPhase::Bubble || !MOVING.get() || !visible.contains(&event.position) {
                return;
            }
            HIT.with_borrow_mut(|hit| {
                if hit.is_none() {
                    *hit = Some(MoveHit { target: target.clone(), bounds: visible });
                }
            });
        });
        self.element.paint(window, cx);
    }
}
