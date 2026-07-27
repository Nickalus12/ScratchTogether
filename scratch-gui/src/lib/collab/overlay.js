/* Presence state + remote cursors + toasts.
 * Peer/room state lives here and is consumed by the native menu-bar component
 * (components/menu-bar/collab-presence.jsx) via subscribe()/getState().
 * Only the cursor layer and transient toasts touch the DOM directly. */

// Same paper singleton scratch-paint uses — lets us place partners' paint
// cursors through the local zoom/pan (view <-> project conversion).
import paper from '@turbowarp/paper';

// Ids must match CURSORS in collab-server/appearance.js. The hotspot of every
// shape is its top-left corner, so they all point the same way.
const CURSOR_SHAPES = {
    arrow: {w: 18, h: 22, box: '0 0 18 22', stroke: 1.2,
        d: 'M1 1 L1 16 L5.5 12.5 L8.5 20 L11.5 18.5 L8.5 11.5 L14 11 Z'},
    hand: {w: 20, h: 22, box: '0 0 20 22', stroke: 1.1,
        d: 'M4 1 C4 0 6 0 6 1 L6 8 L7 8 L7 2 C7 1 9 1 9 2 L9 8 L10 8 L10 3 C10 2 12 2 12 3 ' +
           'L12 9 L13 9 L13 6 C13 5 15 5 15 6 L15 14 C15 19 12 21 9 21 C5 21 4 18 3 15 ' +
           'L1 10 C1 9 3 8 4 10 Z'},
    pencil: {w: 20, h: 20, box: '0 0 20 20', stroke: 1.1,
        d: 'M1 19 L2 14 L14 2 L18 6 L6 18 Z M12 4 L16 8'},
    star: {w: 22, h: 22, box: '0 0 22 22', stroke: 1.1,
        d: 'M11 1 L13.5 7.6 L20.5 7.9 L15 12.3 L16.9 19.1 L11 15.2 ' +
           'L5.1 19.1 L7 12.3 L1.5 7.9 L8.5 7.6 Z'},
    rocket: {w: 22, h: 22, box: '0 0 22 22', stroke: 1.1,
        d: 'M11 1 C14 4 15.5 8 15.5 12 L15.5 15 L12.5 13.5 L12.5 17 L11 20.5 ' +
           'L9.5 17 L9.5 13.5 L6.5 15 L6.5 12 C6.5 8 8 4 11 1 Z'},
    heart: {w: 22, h: 22, box: '0 0 22 22', stroke: 1.1,
        d: 'M11 19.5 C4 14.5 1.5 11 1.5 7.5 C1.5 4.5 3.8 2.5 6.4 2.5 ' +
           'C8.3 2.5 9.9 3.5 11 5.2 C12.1 3.5 13.7 2.5 15.6 2.5 ' +
           'C18.2 2.5 20.5 4.5 20.5 7.5 C20.5 11 18 14.5 11 19.5 Z'},
    sparkle: {w: 22, h: 22, box: '0 0 22 22', stroke: 1,
        d: 'M11 1 C12 6.5 15.5 10 21 11 C15.5 12 12 15.5 11 21 ' +
           'C10 15.5 6.5 12 1 11 C6.5 10 10 6.5 11 1 Z'},
    cat: {w: 22, h: 22, box: '0 0 22 22', stroke: 1.1,
        d: 'M4 2 L7.5 6.5 L14.5 6.5 L18 2 L18 8 C20 10 20 14.5 16.5 17 ' +
           'C13.5 19.5 8.5 19.5 5.5 17 C2 14.5 2 10 4 8 Z'}
};

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
        // z-index 450: above the editor content, BELOW scratch-gui modals
        // (ReactModal overlays sit at 510+) so cursors never float over
        // addon settings, libraries, or other panels.
        this.cursorLayer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:450;overflow:hidden';
        document.body.appendChild(this.cursorLayer);

        const loop = () => {
            this._updateCursors();
            this._raf = requestAnimationFrame(loop);
        };
        this._raf = requestAnimationFrame(loop);
        // Sprite-tile presence dots poll slowly — DOM decoration, not per-frame.
        setInterval(() => this._updateSpriteBadges(), 700);
    }

    // A colored dot on the sprite tile each partner currently has open — see
    // where everyone is without reading the header.
    _updateSpriteBadges () {
        if (document.hidden) return;
        const nameEls = document.querySelectorAll('[class*="sprite-selector-item_sprite-name"]');
        if (!nameEls.length && !this._badges) return;
        const tileByName = new Map();
        for (const el of nameEls) {
            const tile = el.closest('[class*="sprite-selector-item_sprite-selector-item"]');
            if (tile) tileByName.set(el.textContent, tile);
        }
        this._badges = this._badges || new Map(); // peerId -> badge el
        const offsets = new Map(); // tile -> count (stack multiple peers)
        for (const [id, p] of this.peers) {
            const tile = p.sprite ? tileByName.get(p.sprite) : null;
            let badge = this._badges.get(id);
            if (!tile) {
                if (badge) {
                    badge.remove();
                    this._badges.delete(id);
                }
                continue;
            }
            if (!badge || !badge.isConnected || badge.parentElement !== tile) {
                if (badge) badge.remove();
                badge = document.createElement('div');
                badge.title = p.name;
                this._badges.set(id, badge);
                tile.appendChild(badge);
            }
            const slot = offsets.get(tile) || 0;
            offsets.set(tile, slot + 1);
            badge.style.cssText = [
                'position:absolute', `top:-4px`, `right:${-4 + (slot * 13)}px`, 'width:12px', 'height:12px',
                `background:${p.color}`, 'border:2px solid #fff', 'border-radius:50%',
                'box-shadow:0 1px 3px rgba(0,0,0,.35)', 'z-index:5', 'pointer-events:none'
            ].join(';');
            badge.title = `${p.name} is here`;
        }
        for (const [id, badge] of this._badges) {
            if (!this.peers.has(id)) {
                badge.remove();
                this._badges.delete(id);
            }
        }
    }

    setSelf (name, color, room, extra) {
        this.self = Object.assign({name, color, room}, extra || {});
        this._notify();
    }

    setConnected (connected) {
        this.connected = connected;
        this._notify();
    }

    addPeer (id, name, color, style) {
        this.peers.set(id, {
            name, color, style: style || 'arrow',
            status: 'here', sprite: null, cursor: null
        });
        this._notify();
    }

    removePeer (id) {
        this.peers.delete(id);
        this._notify();
    }

    setPeers (list, selfId) {
        this.peers.clear();
        list.forEach(p => {
            if (p.id !== selfId) {
                this.peers.set(p.id, {
                    name: p.name, color: p.color, style: p.cursor || 'arrow',
                    status: 'here', sprite: null, cursor: null
                });
            }
        });
        this._notify();
    }

    // Live colour/cursor change: drop the cached node so it rebuilds once.
    updatePeerAppearance (id, {color, style}) {
        const p = this.peers.get(id);
        if (!p) return;
        if (color) p.color = color;
        if (style) p.style = style;
        if (p._cursorEl) {
            p._cursorEl.remove();
            p._cursorEl = null;
        }
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
        // Background tabs: skip layout thrash entirely.
        if (document.hidden) return;

        // Nothing to draw and nothing drawn — skip all layout reads this frame.
        let anyCursor = false;
        for (const p of this.peers.values()) {
            if (p.cursor) {
                anyCursor = true;
                break;
            }
        }
        if (!anyCursor && !this.cursorLayer.childElementCount) return;

        const workspace = this.getWorkspace();
        const localSprite = this.localSpriteName();

        // Cursors only exist inside a LIVE blocks workspace: same sprite open
        // on both sides, and the local workspace actually rendered on screen
        // (rect collapses to 0 when the costumes/sounds tab or another page is
        // active). Positions recompute from the canvas CTM every frame, so
        // they stay glued to the peer's workspace coordinates through local
        // scrolling and zooming.
        let ctm = null;
        let svgRect = null;
        if (workspace) {
            try {
                const svg = workspace.getParentSvg();
                svgRect = svg.getBoundingClientRect();
                if (svgRect.width > 10 && svgRect.height > 10) {
                    ctm = workspace.getCanvas().getScreenCTM();
                }
            } catch (e) { /* workspace mid-teardown */ }
        }

        const seen = new Set();
        for (const [id, p] of this.peers) {
            seen.add(id);
            const el = this._cursorEl(id, p);
            let visible = false;
            let tx = 0;
            let ty = 0;
            if (p.cursor && p.cursor.space === 'paint') {
                const pos = this._paintCursorPos(p.cursor, localSprite);
                if (pos) {
                    visible = true;
                    tx = pos.x;
                    ty = pos.y;
                }
            } else if (ctm && p.cursor && p.cursor.sprite === localSprite) {
                const pt = new DOMPoint(p.cursor.x, p.cursor.y).matrixTransform(ctm);
                if (pt.x >= svgRect.left && pt.x <= svgRect.right &&
                    pt.y >= svgRect.top && pt.y <= svgRect.bottom) {
                    visible = true;
                    tx = pt.x;
                    ty = pt.y;
                }
            }
            if (visible) {
                // Cursor positions arrive at ~15fps; ease toward the newest
                // point every frame so remote cursors glide instead of step.
                if (!el._stVisible || p._cx === undefined) {
                    p._cx = tx;
                    p._cy = ty;
                } else {
                    p._cx += (tx - p._cx) * 0.35;
                    p._cy += (ty - p._cy) * 0.35;
                    if (Math.abs(tx - p._cx) < 0.5) p._cx = tx;
                    if (Math.abs(ty - p._cy) < 0.5) p._cy = ty;
                }
                el.style.transform = `translate(${p._cx}px, ${p._cy}px)`;
            }
            if (el._stVisible !== visible) {
                el._stVisible = visible;
                el.style.display = visible ? 'block' : 'none';
            }
        }
        // Drop DOM for peers who left (cached on the peer object, not querySelector).
        for (const el of [...this.cursorLayer.children]) {
            const id = Number(el.dataset.peer);
            if (!seen.has(id)) {
                el.remove();
            }
        }
    }

    // A partner's paint-editor cursor: only meaningful when this user has the
    // SAME sprite open in their own paint editor (paper.view exists only while
    // the costumes tab is mounted).
    _paintCursorPos (cursor, localSprite) {
        if (cursor.sprite !== localSprite) return null;
        try {
            if (!paper.view || !paper.view.element) return null;
            const rect = paper.view.element.getBoundingClientRect();
            if (rect.width < 10 || rect.height < 10) return null;
            const pt = paper.view.projectToView(new paper.Point(cursor.x, cursor.y));
            const x = rect.left + pt.x;
            const y = rect.top + pt.y;
            if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
            return {x, y};
        } catch (e) {
            return null;
        }
    }

    _cursorEl (id, p) {
        if (p._cursorEl && p._cursorEl.isConnected) return p._cursorEl;
        let el = this.cursorLayer.querySelector(`[data-peer="${id}"]`);
        if (el) el.remove();
        el = document.createElement('div');
        el.dataset.peer = id;
        el.style.cssText = 'position:absolute;left:0;top:0;will-change:transform;display:none';
        const shape = CURSOR_SHAPES[p.style] || CURSOR_SHAPES.arrow;
        el.innerHTML = `
          <svg width="${shape.w}" height="${shape.h}" viewBox="${shape.box}"
               style="display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.4))">
            <path d="${shape.d}" fill="${p.color}" stroke="#fff" stroke-width="${shape.stroke}"
                  stroke-linejoin="round"/>
          </svg>
          <div style="background:${p.color};color:#fff;font:bold 11px Helvetica,Arial;border-radius:4px;
                      padding:2px 6px;margin:-2px 0 0 10px;white-space:nowrap">${this._esc(p.name)}</div>`;
        this.cursorLayer.appendChild(el);
        p._cursorEl = el;
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
