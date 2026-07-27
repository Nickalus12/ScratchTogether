/* Resolves which room this tab is joining, and who is joining it.
 *
 * There is no name prompt any more — identity comes from the session cookie.
 * A signed-out visitor is sent to the dashboard with ?next= so they land back
 * here once they have an account. */

const defaultServerUrl = () => {
    const params = new URLSearchParams(location.search);
    if (params.get('server')) return params.get('server');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    // Dev server (8601) -> collab server on 4455. Production -> same host:port.
    if (location.port === '8601') return `ws://${location.hostname}:4455`;
    return `${proto}://${location.host}`;
};

const apiBase = () => (location.port === '8601' ? `http://${location.hostname}:4455` : '');
const homeBase = () => (location.port === '8601' ? `http://${location.hostname}:4455` : '');

// /r/<slug> is the canonical room URL; ?room= still works for old links.
const roomFromLocation = () => {
    const path = (location.pathname.match(/^\/r\/([A-Za-z0-9_-]+)/) || [])[1];
    if (path) return path;
    const params = new URLSearchParams(location.search);
    return (params.get('room') || '').trim();
};

const splash = message => {
    const el = document.createElement('div');
    el.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:99999', 'display:flex',
        'align-items:center', 'justify-content:center', 'flex-direction:column', 'gap:14px',
        'background:linear-gradient(135deg,#0d1020,#241a4d)', 'color:#f2f4fb',
        'font:600 16px/1.5 ui-rounded,Nunito,system-ui,-apple-system,"Segoe UI",sans-serif'
    ].join(';');
    el.innerHTML =
        '<svg width="54" height="54" viewBox="0 0 26 26">' +
        '<path d="M4 17c2.5 0 2.5-8 5-8s2.5 8 5 8 2.5-8 5-8" stroke="#a78bfa" stroke-width="2.6"' +
        ' fill="none" stroke-linecap="round"/></svg>' +
        `<div>${message}</div>`;
    document.body.appendChild(el);
    return el;
};

const showLogin = () => new Promise(resolve => {
    const room = roomFromLocation();
    const params = new URLSearchParams(location.search);

    if (params.get('solo') === '1') {
        resolve(null);
        return;
    }
    if (!room) {
        // No room in the URL — nothing to join, so this is just the editor.
        resolve(null);
        return;
    }

    const held = splash('Joining&hellip;');
    fetch(`${apiBase()}/api/me`, {headers: {'x-squiggle': '1'}})
        .then(r => r.json())
        .then(data => {
            if (!data.user) {
                const next = encodeURIComponent(location.pathname + location.search);
                location.href = `${homeBase()}/?next=${next}`;
                return;
            }
            held.remove();
            resolve({name: data.user.displayName, room, url: defaultServerUrl()});
        })
        .catch(() => {
            // Server unreachable: fall back to solo rather than trapping the
            // editor behind a spinner.
            held.remove();
            resolve(null);
        });
});

export default showLogin;
