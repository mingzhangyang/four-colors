// Optional Analytics V2 bridge. Only the shared client owns transport and time sampling.
// Loading it is production-only, asynchronous and never blocks game startup.
// Local previews emit nothing unless a test explicitly supplies window.hubTrack.
export function createAnalytics(gameId, isPlaying) {
    const playing = () => {
        try {
            return Boolean(isPlaying());
        } catch {
            return false;
        }
    };
    const registry = window.__gamesAnalyticsPlaying instanceof Map
        ? window.__gamesAnalyticsPlaying : new Map();
    registry.set(gameId, playing);
    window.__gamesAnalyticsPlaying = registry;

    let script = null;
    const pending = [];
    function emit(kind) {
        try {
            if (typeof window.hubTrack === 'function') window.hubTrack(gameId, kind);
            else if (script && pending.length < 16) pending.push(kind);
        } catch {
            // Telemetry failures never interrupt a move, save, or completion.
        }
    }

    const canonical = document.querySelector('link[rel="canonical"]');
    const source = document.querySelector('meta[name="games-analytics-client"]')?.content;
    // Never load the shared script on localhost, CI, or preview deployments.
    if (canonical && source && new URL(canonical.href).origin === location.origin) {
        script = document.createElement('script');
        script.async = true;
        script.src = source;
        script.dataset.analyticsGame = gameId;
        script.dataset.analyticsExternal = 'true';
        script.addEventListener('load', () => {
            try {
                window.hubAnalytics?.bindPlaying(gameId, playing);
            } catch {
                // The read-only predicate is already in the registry.
            }
            script = null;
            for (const kind of pending.splice(0)) emit(kind);
        }, { once: true });
        script.addEventListener('error', () => {
            script = null;
            pending.length = 0;
        }, { once: true });
        document.head.append(script);
    }

    return { play: () => emit('play'), finish: () => emit('finish') };
}
