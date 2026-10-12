// Hint service: requests go to a Worker tagged with sessionId + puzzleRevision +
// stateRevision. A reply that no longer matches the page is discarded; a slow
// reply resolves as "unavailable" and never changes the game state. Leaving,
// restarting or switching pages cancels outstanding requests.

import { computeHint } from './hint-engine.js';

export const HINT_TIMEOUT_MS = 2500;

export function createHintService({ timeoutMs = HINT_TIMEOUT_MS, workerFactory = null } = {}) {
    let worker = null;
    let workerFailed = false;
    let seq = 0;
    const pending = new Map();

    function ensureWorker() {
        if (worker || workerFailed) return worker;
        try {
            worker = workerFactory ? workerFactory() : new Worker(new URL('./hint-worker.js', import.meta.url), { type: 'module' });
            worker.onmessage = e => {
                const msg = e.data || {};
                const p = pending.get(msg.id);
                if (!p) return;
                pending.delete(msg.id);
                clearTimeout(p.timer);
                p.resolve({ ...msg, stale: false });
            };
            worker.onerror = () => {
                workerFailed = true;
                worker = null;
                for (const [id, p] of pending) {
                    pending.delete(id);
                    clearTimeout(p.timer);
                    p.resolve({ id, result: null, failed: true });
                }
            };
        } catch {
            workerFailed = true;
            worker = null;
        }
        return worker;
    }

    return {
        /**
         * Resolves with { result, sessionId, puzzleRevision, stateRevision } or
         * { result: null, timedOut: true }. Callers compare the tags with the
         * live page before showing anything.
         */
        request({ sessionId, puzzleRevision, stateRevision, puzzle, colors, layer }) {
            const id = ++seq;
            const payload = {
                id,
                sessionId,
                puzzleRevision,
                stateRevision,
                puzzle: { adj: puzzle.adj, fixed: puzzle.fixed, goals: puzzle.goals, actions: puzzle.actions },
                colors: colors.slice(),
                layer,
            };
            return new Promise(resolve => {
                const timer = setTimeout(() => {
                    pending.delete(id);
                    resolve({ id, sessionId, puzzleRevision, stateRevision, result: null, timedOut: true });
                }, timeoutMs);
                pending.set(id, { resolve, timer });
                const w = ensureWorker();
                if (w) {
                    w.postMessage(payload);
                } else {
                    // no Worker available: compute after yielding, same tags and timeout semantics
                    setTimeout(() => {
                        const p = pending.get(id);
                        if (!p) return;
                        let result;
                        try { result = computeHint(payload.puzzle, payload.colors, layer); } catch { result = null; }
                        pending.delete(id);
                        clearTimeout(p.timer);
                        p.resolve({ id, sessionId, puzzleRevision, stateRevision, result });
                    }, 0);
                }
            });
        },
        cancelAll() {
            for (const [id, p] of pending) {
                clearTimeout(p.timer);
                p.resolve({ id, result: null, cancelled: true });
            }
            pending.clear();
        },
        get pendingCount() {
            return pending.size;
        },
    };
}
