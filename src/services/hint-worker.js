// Hint worker: solver work stays off the main thread. Every reply echoes the
// request tags so the page can drop answers that arrive for an old state.

import { computeHint } from './hint-engine.js';

self.onmessage = event => {
    const { id, sessionId, puzzleRevision, stateRevision, puzzle, colors, layer } = event.data || {};
    let result;
    try {
        result = computeHint(puzzle, colors, layer);
    } catch {
        result = null;
    }
    self.postMessage({ id, sessionId, puzzleRevision, stateRevision, result });
};
