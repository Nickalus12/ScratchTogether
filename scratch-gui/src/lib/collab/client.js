/* WebSocket client for ScratchTogether: auto-reconnect, typed message handlers. */

class CollabClient {
    constructor () {
        this.ws = null;
        this.handlers = {};
        this.connected = false;
        this.session = null; // {url, room, name}
        this.me = null; // {id, color}
        this._backoff = 1000;
        this._closedByUser = false;
    }

    on (type, cb) {
        (this.handlers[type] = this.handlers[type] || []).push(cb);
    }

    _emit (type, msg) {
        (this.handlers[type] || []).forEach(cb => {
            try {
                cb(msg);
            } catch (e) {
                // eslint-disable-next-line no-console
                console.error('[collab] handler error', type, e);
            }
        });
    }

    connect ({url, room, name}) {
        this.session = {url, room, name};
        this._closedByUser = false;
        this._open();
    }

    _open () {
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
            this._backoff = 1000;
            // Persistent device identity: token issued by the server on first
            // join, kept in localStorage — name-only login stays that simple.
            const token = localStorage.getItem('st_token') || undefined;
            ws.send(JSON.stringify({type: 'join', room, name, token}));
        };
        ws.onmessage = evt => {
            let msg;
            try {
                msg = JSON.parse(evt.data);
            } catch (e) {
                return;
            }
            if (msg.type === 'welcome') {
                this.connected = true;
                this.me = {id: msg.id, color: msg.color};
                if (msg.token) localStorage.setItem('st_token', msg.token);
            }
            this._emit(msg.type, msg);
        };
        ws.onclose = () => {
            const wasConnected = this.connected;
            this.connected = false;
            if (wasConnected) this._emit('disconnected', {});
            if (!this._closedByUser) this._scheduleReconnect();
        };
        ws.onerror = () => { /* onclose follows */ };
    }

    _scheduleReconnect () {
        setTimeout(() => {
            if (!this._closedByUser && this.session) this._open();
        }, this._backoff);
        this._backoff = Math.min(this._backoff * 1.6, 15000);
    }

    send (msg) {
        if (this.ws && this.ws.readyState === 1) {
            this.ws.send(JSON.stringify(msg));
        }
    }

    disconnect () {
        this._closedByUser = true;
        if (this.ws) this.ws.close();
    }
}

export default new CollabClient();
