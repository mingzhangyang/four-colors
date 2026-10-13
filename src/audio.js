// Synthesised paper, stamp and completion sounds. Muted by default with this
// game's own setting. A stored "unmuted" preference is only hydrated at
// construction; the AudioContext is created inside a user gesture (the unmute
// action or the first sound a player action plays), never on page load, and
// nothing is shared across sites.

export function createAudio({ muted = true } = {}) {
    let ctx = null;
    let isMuted = muted;
    let noise = null;

    function ensure() {
        if (!ctx) {
            const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
            if (!AC) return null;
            try { ctx = new AC(); } catch { return null; }
        }
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        return ctx;
    }

    function noiseBuffer(c) {
        if (noise) return noise;
        noise = c.createBuffer(1, c.sampleRate * 0.4, c.sampleRate);
        const data = noise.getChannelData(0);
        let seed = 7;
        for (let i = 0; i < data.length; i++) {
            seed = (seed * 16807) % 2147483647;
            data[i] = (seed / 2147483647) * 2 - 1;
        }
        return noise;
    }

    function burst(c, { t, dur, freq, q = 1, gain = 0.2 }) {
        const src = c.createBufferSource();
        src.buffer = noiseBuffer(c);
        const f = c.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.value = freq;
        f.Q.value = q;
        const g = c.createGain();
        g.gain.setValueAtTime(gain, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        src.connect(f).connect(g).connect(c.destination);
        src.start(t);
        src.stop(t + dur + 0.02);
    }

    function tone(c, { t, dur, freq, to = null, type = 'sine', gain = 0.12, attack = 0.008 }) {
        const o = c.createOscillator();
        o.type = type;
        o.frequency.setValueAtTime(freq, t);
        if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
        const g = c.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(gain, t + attack);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g).connect(c.destination);
        o.start(t);
        o.stop(t + dur + 0.02);
    }

    const SOUNDS = {
        paint(c, t) {
            burst(c, { t, dur: 0.07, freq: 2400, q: 0.8, gain: 0.08 });
            tone(c, { t, dur: 0.09, freq: 520, to: 470, gain: 0.04 });
        },
        erase(c, t) {
            burst(c, { t, dur: 0.12, freq: 3200, q: 0.6, gain: 0.06 });
        },
        stamp(c, t) {
            tone(c, { t, dur: 0.16, freq: 130, to: 60, gain: 0.22, attack: 0.004 });
            burst(c, { t, dur: 0.05, freq: 900, q: 1.2, gain: 0.08 });
        },
        swap(c, t) {
            tone(c, { t, dur: 0.12, freq: 440, to: 620, type: 'triangle', gain: 0.06 });
            tone(c, { t: t + 0.08, dur: 0.14, freq: 620, to: 440, type: 'triangle', gain: 0.05 });
        },
        blocked(c, t) {
            tone(c, { t, dur: 0.08, freq: 220, to: 190, type: 'triangle', gain: 0.05 });
        },
        complete(c, t) {
            [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(c, { t: t + i * 0.11, dur: 0.5, freq: f, type: 'triangle', gain: 0.07 }));
            SOUNDS.stamp(c, t + 0.5);
        },
    };

    return {
        play(name) {
            if (isMuted) return;
            const c = ensure();
            if (!c || !SOUNDS[name]) return;
            try { SOUNDS[name](c, c.currentTime + 0.005); } catch { /* ignore */ }
        },
        /** Call from a user gesture. */
        setMuted(next) {
            isMuted = next;
            if (!next) ensure();
        },
        get muted() {
            return isMuted;
        },
        suspend() {
            if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
        },
    };
}
