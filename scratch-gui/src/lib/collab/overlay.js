/* Presence state + remote cursors + toasts.
 * Peer/room state lives here and is consumed by the native menu-bar component
 * (components/menu-bar/collab-presence.jsx) via subscribe()/getState().
 * Only the cursor layer and transient toasts touch the DOM directly. */

class Overlay {
    constructor () {
        this.peers = new Map(); // id -> {name, color, status, sprite, cursor:{x,y,sprite}}
        this.self = null; // {name, color, room}
        this.connected = false;
        this.projects = []; // [{id, name, owner, room, updatedAt, size}]
        this.cursorLayer = null;
        this.getWorkspace = () => null;
        this.localSpriteName = () => null;
        this._raf = null;
        this._subscribers = new Set();
    }

    // ---- state pub/sub (for the React presence component) ----

    subscribe (cb) {
        this._subscribers.add(cb);
        return () => this._subscribers.delete(cb);
    }

    getState () {
        return {
            self: this.self,
            connected: this.connected,
            projects: this.projects,
            peers: [...this.peers.entries()].map(([id, p]) => ({
                id, name: p.name, color: p.color, status: p.status, sprite: p.sprite
            }))
        };
    }

    setProjects (projects) {
        this.projects = projects || [];
        this._notify();
    }

    _notify () {
        for (const cb of this._subscribers) {
            try {
                cb();
            } catch (e) { /* subscriber error must not break sync */ }
        }
    }

    // ---- lifecycle ----

    mount () {
        if (this.cursorLayer) return;
        this.cursorLayer = document.createElement('div');
        this.cursorLayer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9997;overflow:hidden';
        document.body.appendChild(this.cursorLayer);

        const loop = () => {
            this._updateCursors();
            this._raf = requestAnimationFrame(loop);
        };
        this._raf = requestAnimationFrame(loop);
    }

    setSelf (name, color, room) {
        this.self = {name, color, room};
        this._notify();
    }

    setConnected (connected) {
        this.connected = connected;
        this._notify();
    }

    addPeer (id, name, color) {
        this.peers.set(id, {name, color, status: 'here', sprite: null, cursor: null});
        this._notify();
    }

    removePeer (id) {
        this.peers.delete(id);
        this._notify();
    }

    setPeers (list, selfId) {
        this.peers.clear();
        list.forEach(p => {
            if (p.id !== selfId) this.peers.set(p.id, {name: p.name, color: p.color, status: 'here', sprite: null, cursor: null});
        });
        this._notify();
    }

    setPeerPresence (id, {status, sprite}) {
        const p = this.peers.get(id);
        if (!p) return;
        if (status !== undefined) p.status = status;
        if (sprite !== undefined) p.sprite = sprite;
        this._notify();
    }

    setPeerCursor (id, cursor) {
        const p = this.peers.get(id);
        if (p) p.cursor = cursor; // no notify — cursors render on the rAF loop
    }

    // ---- cursors ----

    _updateCursors () {
        if (!this.cursorLayer) return;
        const workspace = this.getWorkspace();
        const localSprite = this.localSpriteName();
        for (const [id, p] of this.peers) {
            const el = this._cursorEl(id, p);
            let visible = false;
            if (workspace && p.cursor && p.cursor.sprite === localSprite) {
                try {
                    const canvas = workspace.getCanvas();
                    const ctm = canvas.getScreenCTM();
                    if (ctm) {
                        const pt = new DOMPoint(p.cursor.x, p.cursor.y).matrixTransform(ctm);
                        const svgRect = workspace.getParentSvg().getBoundingClientRect();
                        if (pt.x >= svgRect.left && pt.x <= svgRect.right &&
                            pt.y >= svgRect.top && pt.y <= svgRect.bottom) {
                            el.style.transform = `translate(${pt.x}px, ${pt.y}px)`;
                            visible = true;
                        }
                    }
                } catch (e) { /* workspace mid-teardown */ }
            }
            el.style.display = visible ? 'block' : 'none';
        }
        for (const el of this.cursorLayer.children) {
            if (!this.peers.has(Number(el.dataset.peer))) el.remove();
        }
    }

    _cursorEl (id, p) {
        let el = this.cursorLayer.querySelector(`[data-peer="${id}"]`);
        if (!el) {
            el = document.createElement('div');
            el.dataset.peer = id;
            el.style.cssText = 'position:absolute;left:0;top:0;will-change:transform;display:none';
            el.innerHTML = `
              <svg width="18" height="22" viewBox="0 0 18 22" style="display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.4))">
                <path d="M1 1 L1 16 L5.5 12.5 L8.5 20 L11.5 18.5 L8.5 11.5 L14 11 Z" fill="${p.color}" stroke="#fff" stroke-width="1.2"/>
              </svg>
              <div style="background:${p.color};color:#fff;font:bold 11px Helvetica,Arial;border-radius:4px;
                          padding:2px 6px;margin:-2px 0 0 10px;white-space:nowrap">${this._esc(p.name)}</div>`;
            this.cursorLayer.appendChild(el);
        }
        return el;
    }

    // ---- toasts ----

    toast (text, color) {
        const t = document.createElement('div');
        t.textContent = text;
        t.style.cssText = [
            'position:fixed', 'top:60px', 'left:50%', 'transform:translateX(-50%)', 'z-index:99998',
            `background:${color || '#4c97ff'}`, 'color:#fff', 'padding:9px 20px', 'border-radius:20px',
            'font:bold 14px Helvetica,Arial', 'box-shadow:0 4px 14px rgba(0,0,0,.25)',
            'opacity:0', 'transition:opacity .25s'
        ].join(';');
        document.body.appendChild(t);
        requestAnimationFrame(() => (t.style.opacity = '1'));
        setTimeout(() => {
            t.style.opacity = '0';
            setTimeout(() => t.remove(), 300);
        }, 2600);
    }

    _esc (s) {
        return String(s == null ? '' : s).replace(/[<>&"]/g, c => ({'<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;'}[c]));
    }
}

export default new Overlay();
