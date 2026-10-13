// Composition root: wire storage, settings, audio and hints into the game.
// Nothing here is loaded from the games collection; everything is local.

import { createStorage, createSaveManager } from './storage.js';
import { createSettings } from './services/settings.js';
import { createHintService } from './services/hints.js';
import { createAudio } from './audio.js';
import { createGame } from './game.js';

function makeTabId() {
    // fresh per page load: a duplicated tab must not share an id with its source
    return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

const storage = createStorage();
const settings = createSettings({ storage });
const tabId = makeTabId();
const saves = createSaveManager({ storage, tabId });
// the stored preference is only hydrated here; no AudioContext exists until a gesture
const audio = createAudio({ muted: settings.get('muted') });
const hints = createHintService();

const game = createGame({
    root: document.getElementById('app'),
    storage,
    saves,
    settings,
    hints,
    audio,
    tabId,
});

// Exposed for browser regression tests and manual debugging only.
window.__fourColors = game;
