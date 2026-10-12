// Keyboard path: arrows move a focus between regions (spatially, using label
// points), 1–4 choose a pigment, Enter/Space applies the current tool,
// Backspace/Delete/0 erases, Ctrl/Cmd+Z undoes, Ctrl+Shift+Z or Ctrl+Y redoes,
// H asks for a hint, S toggles the swap tool, L opens the region list and
// Escape cancels a swap preview or closes the tool tray.

const DIRS = {
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
};

/** Nearest region in a direction from `from` (label points), or -1. */
export function spatialNext(points, from, key) {
    const dir = DIRS[key];
    if (!dir) return -1;
    if (from < 0 || from >= points.length) return 0;
    const [fx, fy] = points[from];
    let best = -1;
    let bestScore = Infinity;
    points.forEach(([x, y], i) => {
        if (i === from) return;
        const dx = x - fx;
        const dy = y - fy;
        const along = dx * dir[0] + dy * dir[1];
        if (along <= 4) return;
        const across = Math.abs(dx * dir[1] - dy * dir[0]);
        const score = along + across * 2.2;
        if (score < bestScore) { bestScore = score; best = i; }
    });
    return best;
}

export function attachKeyboard(target, handlers) {
    target.addEventListener('keydown', e => {
        if (e.defaultPrevented || e.altKey) return;
        const mod = e.ctrlKey || e.metaKey;
        const k = e.key;
        let handled = true;
        if (mod && (k === 'z' || k === 'Z')) {
            if (e.shiftKey) handlers.redo(); else handlers.undo();
        } else if (mod && (k === 'y' || k === 'Y')) {
            handlers.redo();
        } else if (mod) {
            handled = false;
        } else if (DIRS[k] && handlers.move) {
            handlers.move(k);
        } else if (k >= '1' && k <= '4') {
            handlers.color(Number(k) - 1);
        } else if (k === 'Enter' || k === ' ') {
            handlers.apply();
        } else if (k === 'Backspace' || k === 'Delete' || k === '0') {
            handlers.erase();
        } else if (k === 'h' || k === 'H') {
            handlers.hint();
        } else if (k === 's' || k === 'S') {
            handlers.swapTool();
        } else if (k === 'l' || k === 'L') {
            handlers.regionList();
        } else if (k === 'u' || k === 'U') {
            handlers.undo();
        } else if (k === 'Escape') {
            handled = handlers.escape();
        } else {
            handled = false;
        }
        if (handled) e.preventDefault();
    });
}
