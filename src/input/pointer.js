// Pointer input for the map: a tap paints only when the pointer goes down and
// up on the same region without travelling. A second finger, pointercancel,
// a drag or a long press cancels the tap, so pinch-zoom or scrolling never
// paints by accident. Long press reports the region instead of painting.

export function attachPointer(element, { regionAt, toMap, onTap, onLongPress = null, slop = 12, longPressMs = 520 }) {
    const active = new Set();
    let gesture = null;

    function cancel() {
        if (gesture && gesture.timer) clearTimeout(gesture.timer);
        gesture = null;
    }

    function down(e) {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        active.add(e.pointerId);
        if (active.size > 1) { cancel(); return; }
        const region = regionAt(e.clientX, e.clientY);
        gesture = { id: e.pointerId, x: e.clientX, y: e.clientY, region, timer: null, long: false };
        if (onLongPress && region >= 0) {
            gesture.timer = setTimeout(() => {
                if (!gesture) return;
                gesture.long = true;
                onLongPress(region);
            }, longPressMs);
        }
    }

    function move(e) {
        if (!gesture || e.pointerId !== gesture.id) return;
        if (Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) > slop) cancel();
    }

    function up(e) {
        active.delete(e.pointerId);
        if (!gesture || e.pointerId !== gesture.id) return;
        const g = gesture;
        cancel();
        if (g.long || g.region < 0) return;
        const region = regionAt(e.clientX, e.clientY);
        if (region !== g.region) return;
        onTap(region, toMap(e.clientX, e.clientY));
    }

    function lost(e) {
        active.delete(e.pointerId);
        if (gesture && e.pointerId === gesture.id) cancel();
    }

    element.addEventListener('pointerdown', down);
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', lost);
    element.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') lost(e); });
    element.addEventListener('contextmenu', e => e.preventDefault());
    // a touch that turns into a pinch or scroll arrives as pointercancel; a blur also ends gestures
    window.addEventListener('blur', () => { active.clear(); cancel(); });

    return {
        cancel() {
            active.clear();
            cancel();
        },
    };
}
