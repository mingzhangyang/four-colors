// Hint service: requests go to a Worker tagged with sessionId + puzzleRevision +
// stateRevision. A reply that no longer matches the page is discarded; a slow
// reply resolves as "unavailable" and never changes the game state. Leaving,
// restarting or switching pages cancels outstanding requests. Without a
// Worker the hint is reported unavailable: running the solver on the page
// would block input and the timeout could never fire.

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
                    p.resolve({ ...p.tags, result: null, failed: true });
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
         * Resolves with { result, sessionId, puzzleRevision, stateRevision }, or
         * with result null and one of timedOut / failed / unavailable. Callers
         * compare the tags with the live page before showing anything.
         */
        request({ sessionId, puzzleRevision, stateRevision, puzzle, colors, layer }) {
            const id = ++seq;
            const tags = { id, sessionId, puzzleRevision, stateRevision };
            const w = ensureWorker();
            if (!w) return Promise.resolve({ ...tags, result: null, unavailable: true });
            const payload = {
                ...tags,
                puzzle: { adj: puzzle.adj, fixed: puzzle.fixed, goals: puzzle.goals, actions: puzzle.actions },
                colors: colors.slice(),
                layer,
            };
            return new Promise(resolve => {
                const timer = setTimeout(() => {
                    pending.delete(id);
                    resolve({ ...tags, result: null, timedOut: true });
                }, timeoutMs);
                pending.set(id, { resolve, timer, tags });
                w.postMessage(payload);
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
