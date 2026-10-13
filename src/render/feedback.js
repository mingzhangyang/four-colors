// Non-blocking feedback: toasts with optional actions, a polite announcer for
// screen readers, and the corner completion seal. Nothing here covers the map.

import { el, clear } from './dom.js';

export function createToasts(host) {
    const region = el('div', { class: 'toasts', role: 'region', 'aria-live': 'polite', 'aria-label': 'Notices' });
    host.append(region);
    const shown = new Map();
    return {
        show(key, text, { actions = [], timeout = 4200 } = {}) {
            if (shown.has(key)) shown.get(key).remove();
            const node = el('div', { class: 'toast', role: actions.length ? 'alert' : 'status' }, [el('span', { class: 'toast-text' }, [text])]);
            if (actions.length) {
                const row = el('div', { class: 'toast-actions' });
                for (const a of actions) {
                    row.append(el('button', {
                        type: 'button',
                        class: `btn btn-small${a.primary ? ' btn-primary' : ''}`,
                        onclick: () => { node.remove(); shown.delete(key); a.run(); },
                    }, [a.label]));
                }
                node.append(row);
            }
            region.append(node);
            shown.set(key, node);
            if (timeout && !actions.length) {
                setTimeout(() => {
                    if (shown.get(key) === node) { node.remove(); shown.delete(key); }
                }, timeout);
            }
            return node;
        },
        dismiss(key) {
            if (shown.has(key)) { shown.get(key).remove(); shown.delete(key); }
        },
        has(key) {
            return shown.has(key);
        },
    };
}

export function createAnnouncer(host) {
    const node = el('div', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });
    host.append(node);
    let timer = null;
    return {
        say(text) {
            clearTimeout(timer);
            node.textContent = '';
            timer = setTimeout(() => { node.textContent = text; }, 30);
        },
    };
}

export function sealElement(text, variant = '') {
    return el('div', { class: `page-seal ${variant}`, 'aria-hidden': 'true' }, [el('span', {}, [text])]);
}

export function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
}

export { clear };
