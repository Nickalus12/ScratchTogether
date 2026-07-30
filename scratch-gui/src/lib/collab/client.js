/* WebSocket client for Squiggle: auto-reconnect, typed message handlers,
 * brief outbound queue so a blip doesn't drop block edits mid-drag. */

// Lossy traffic — safe to drop under backpressure or while offline.
const LOSSY = new Set(['cursor', 'presence', 'sprite-info']);
// Reliable traffic is queued briefly across reconnects (block edits, snapshots…).
const MAX_QUEUE = 80;
const MAX_BUFFERED = 2 * 1024 * 1024; // ~2MB socket buffer → start dropping lossy

class CollabClient {
    constructor () {
        this.ws = null;
        this.handlers = {};
        this.connected = false;
        this.session = null; // {url, room, name}
        this.me = null; // {id, color}
        this._backoff = 1000;
        this._closedByUser = false;
        this._reconnectTimer = null;
        this._queue = []; // reliable messages waiting for an open socket
        this._openGen = 0; // ignore stale socket callbacks after supersede
    }

    on (type, cb) {
        (this.handlers[type] = this.handlers[type] || []).push(cb);
    }

    _emit (type, msg) {
        const list = this.handlers[type];
        if (!list || !list.length) return;
        for (let i = 0; i < list.length; i++) {
            try {
                list[i](msg);
            } catch (e) {
                // eslint-disable-next-line no-console
                console.error('[collab] handler error', type, e);
            }
        }
    }

    connect ({url, room, name}) {
        this.session = {url, room, name};
        this._closedByUser = false;
        this._backoff = 1000;
        this._open();
    }

    _clearReconnect () {
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
    }

    _open () {
        if (!this.session || this._closedByUser) return;
        this._clearReconnect();

        // Supersede any in-flight socket so its onclose can't double-reconnect.
        const gen = ++this._openGen;
        if (this.ws) {
            try {
                this.ws.onopen = null;
                this.ws.onmessage = null;
                this.ws.onclose = null;
                this.ws.onerror = null;
                this.ws.close();
            } catch (e) { /* already dead */ }
            this.ws = null;
        }

        const {url, room, name} = this.session;
        let ws;
        try {
            ws = new WebSocket(url);
        } catch (e) {
            this._scheduleReconnect();
            return;
        }
        this.ws = ws;

        ws.onopen = () => {
            if (gen !== this._openGen) return;
            this._backoff = 1000;
            // Persistent device identity: token issued by the server on first
            // join, kept in localStorage — name-only login stays that simple.
            let token;
            try {
                token = localStorage.getItem('st_token') || undefined;
            } catch (e) {
                token = undefined;
            }
            ws.send(JSON.stringify({type: 'join', room, name, token}));
        };
        ws.onmessage = evt => {
            if (gen !== this._openGen) return;
            let msg;
            try {
                msg = JSON.parse(evt.data);
            } catch (e) {
                return;
            }
            if (msg.type === 'welcome') {
                this.connected = true;
                this.me = {id: msg.id, color: msg.color};
                if (msg.token) {
                    try {
                        localStorage.setItem('st_token', msg.token);
                    } catch (e) { /* private mode */ }
                }
                this._flushQueue();
            }
            this._emit(msg.type, msg);
        };
        ws.onclose = () => {
            if (gen !== this._openGen) return;
            const wasConnected = this.connected;
            this.connected = false;
            this.ws = null;
            if (wasConnected) this._emit('disconnected', {});
            if (!this._closedByUser) this._scheduleReconnect();
        };
        ws.onerror = () => { /* onclose follows */ };
    }

    _scheduleReconnect () {
        if (this._closedByUser || !this.session) return;
        this._clearReconnect();
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            if (!this._closedByUser && this.session) this._open();
        }, this._backoff);
        this._backoff = Math.min(this._backoff * 1.6, 15000);
    }

    // Reconnect immediately when the tab comes back (laptop sleep / ZeroTier blip).
    resumeIfNeeded () {
        if (this._closedByUser || !this.session) return;
        // Don't kill a healthy open socket OR an in-flight CONNECTING handshake.
        if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
        this._backoff = 1000;
        this._open();
    }

    _flushQueue () {
        if (!this.ws || this.ws.readyState !== 1) return;
        const pending = this._queue;
        this._queue = [];
        for (let i = 0; i < pending.length; i++) {
            try {
                this.ws.send(pending[i]);
            } catch (e) {
                // Re-queue the rest if the socket died mid-flush.
                this._queue = pending.slice(i);
                return;
            }
        }
    }

    send (msg) {
        if (!msg || typeof msg !== 'object') return;
        const lossy = LOSSY.has(msg.type);
        let data;
        try {
            data = JSON.stringify(msg);
        } catch (e) {
            return;
        }

        // Only treat the socket as writable after welcome — frames sent between
        // onopen and welcome are dropped server-side (no room yet) and would
        // bypass the reliable queue.
        if (this.connected && this.ws && this.ws.readyState === 1) {
            // Under backpressure, drop lossy traffic so block edits keep flowing.
            if (lossy && this.ws.bufferedAmount > MAX_BUFFERED) return;
            try {
                this.ws.send(data);
            } catch (e) {
                if (!lossy) this._enqueue(data);
            }
            return;
        }

        if (lossy) return; // no point queueing cursors for a dead socket
        this._enqueue(data);
    }

    _enqueue (data) {
        if (this._queue.length >= MAX_QUEUE) {
            // Prefer keeping the newest reliable messages (latest block state wins).
            this._queue.shift();
        }
        this._queue.push(data);
    }

    disconnect () {
        this._closedByUser = true;
        this._clearReconnect();
        this._queue = [];
        this._openGen++;
        if (this.ws) {
            try {
                this.ws.close();
            } catch (e) { /* ignore */ }
            this.ws = null;
        }
        this.connected = false;
    }
}

const client = new CollabClient();

// Fast recover after sleep / tab background — ZeroTier often needs a fresh socket.
if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) client.resumeIfNeeded();
    });
}
if (typeof window !== 'undefined') {
    window.addEventListener('online', () => client.resumeIfNeeded());
}

export default client;
