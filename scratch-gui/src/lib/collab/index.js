/* Squiggle sync engine.
 *
 * Replication model:
 *  - Block edits: Blockly events relayed live, routed by sprite NAME (names are
 *    unique in Scratch; target ids are not stable across .sb3 loads). Applied to
 *    the remote VM directly, and mirrored into the visible workspace when the
 *    receiving user has the same sprite open.
 *  - Structural changes (sprites/costumes/sounds/paint edits): originator sends a
 *    debounced full .sb3 snapshot; everyone converges on identical assets.
 *  - Sprite motion on the stage, green flag / stop, cursor, selection and status
 *    are relayed as lightweight presence messages.
 */

import paper from '@turbowarp/paper';
import client from './client';
import showLogin from './login';
import overlay from './overlay';
import paintMerge from './paint-merge';

/*
 * Small preferences that belong to the person rather than the project, kept
 * where they will survive a reload. TurboWarp persists its own settings in the
 * URL, which does not survive following a room link.
 */
const INTERPOLATION_KEY = 'squiggle:interpolation';

const readPref = (key, fallback) => {
    try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : raw === '1';
    } catch (e) {
        return fallback; // private browsing, or storage disabled
    }
};

const savePref = (key, value) => {
    try {
        localStorage.setItem(key, value ? '1' : '0');
    } catch (e) { /* not worth breaking anything over */ }
};

const state = {
    vm: null,
    workspace: null,
    ScratchBlocks: null,
    active: false,
    /*
     * Depth, not a flag. Every reader treats it as a boolean (0 is falsy), but
     * the applies nest: applySnapshot holds it across `await vm.loadProject`,
     * and a vm-action or sprite-info arriving in that window used to run its
     * own apply and set the flag back to FALSE on the way out — leaving the
     * rest of the load unsuppressed, so the loading project's own Blockly
     * events were read as local edits and broadcast back to the room. That is
     * the echo loop, and it happened exactly when a room was busiest. Counting
     * means the outermost apply is the one that clears it.
     */
    applyingRemote: 0,
    snapshotTimer: null,
    snapshotInFlight: false, // serialize zip+send so rapid edits don't stack zips
    lastCursorSent: 0,
    lastSpriteInfoSent: 0,
    pendingSpriteInfo: null, // trailing sprite-info so the final drag position always lands
    spriteInfoTimer: null,
    lastPresence: {status: null, sprite: null, sentAt: 0},
    lastSnapshotB64: null, // dedup — skip re-broadcasting identical project state
    localTab: 0, // 0 code / 1 costumes / 2 sounds
    pendingRemotePaint: new Map(), // deferred remote paint edits while locally painting
    pendingSnapshotMsg: null, // deferred remote snapshot while locally painting
    snapshotLoading: false,
    queuedBlockEvents: [],
    // Orphan block-events (unknown sprite) held briefly until a snapshot lands.
    orphanBlockEvents: [],
    // Coalesce rapid block moves (drag) into one send per block id.
    pendingBlockMoves: new Map(), // blockId -> msg
    blockMoveTimer: null,
    targetByName: null, // Map name -> target; rebuilt on project load
    lastWorkspaceRefresh: 0,
    housekeepTimer: null,
    initialized: false,
    everConnected: false, // welcome seen at least once (reconnect detection)
    offlineEdits: false, // project edited while the socket was down
    skipNextSnapshot: false, // drop the stale room snapshot after an offline-edit rejoin
    roomVersion: 0, // last room snapshot version we've seen/produced (server-gated)
    forceNextSnapshot: false, // deliberate override (offline-edit rejoin) bypasses the gate
    recentPaint: new Map(), // "target|index|kind" -> {at, msg}; re-applied after snapshot loads
    // Per-costume paint bases: for svg the last export/apply text (stroke-diff
    // base), for bitmaps the freshest known full pixels (patch base + shadow).
    paintBase: new Map(), // "target|index|svg" -> text; "target|index|bmp" -> {pixels,width,height}
    pointerDown: false, // mid-stroke guard: remote paint defers until pointer release
    // Bitmap edits waiting out their debounce, keyed by costume. A single slot
    // meant painting one costume and switching to another inside 250ms threw
    // the first costume's stroke away entirely — it was never sent AND never
    // cached, because both happen inside the send.
    pendingBitmaps: new Map(), // "target|costumeIndex" -> {meta, pixels}
    // Depth, not a flag — for the same reason applyingRemote is one. Two
    // workspace rebuilds can overlap around Blockly's setTimeout(0) event
    // drain, and a boolean lets the first one's resume unsuspend the second
    // one's still-pending synthetic events, which then broadcast as edits.
    workspaceSuspended: 0,
    // When the whole run of deferred snapshots started, so an unbroken stream
    // of edits cannot postpone the only save path forever.
    snapshotDeferredSince: 0,
    // Set while repairing a known divergence: apply the room's snapshot even
    // if it matches the last one we saw, because what we saw is not what we
    // have any more.
    forceApplyNextSnapshot: false,
    selfId: null,
    role: 'editor',
    canEdit: true,
    // Last title we pushed into the GUI. Renames echoed back from the server
    // must not bounce out again as a fresh rename.
    appliedTitle: null,
    // Smooth motion is the default, but it is the person's call — some
    // projects (pen art, 3D, anything that teleports sprites) look worse for
    // it, and a laggy one gets slower without looking smoother.
    wantInterpolation: readPref(INTERPOLATION_KEY, true)
};

// Set by gui.jsx so collab can drive the project title box and the settings UI.
let hooks = {};

const trimPaintBase = () => {
    while (state.paintBase.size > 12) {
        state.paintBase.delete(state.paintBase.keys().next().value);
    }
};

// Bumped whenever a remote paint edit lands on a costume; the paint editor
// wrapper folds it into imageId so an OPEN editor reloads and shows the
// partner's stroke immediately (true co-painting on one costume).
const paintRevs = new Map(); // "targetName|costumeIndex" -> rev
const bumpPaintRev = (targetName, costumeIndex) => {
    const key = `${targetName}|${costumeIndex}`;
    paintRevs.set(key, (paintRevs.get(key) || 0) + 1);
};
const paintRev = (targetId, costumeIndex) => {
    if (!state.vm) return 0;
    const t = state.vm.runtime.getTargetById(targetId);
    return t ? (paintRevs.get(`${t.getName()}|${costumeIndex}`) || 0) : 0;
};

// Latest paint edit per costume, from either side. Full-project snapshot loads
// can carry costume state OLDER than live-synced paint edits (the zip is
// debounced up to 20s behind) — without this cache a snapshot reverting fresh
// strokes was the "we painted it and it came back undone" bug.
const PAINT_CACHE_MAX_AGE_MS = 10 * 60 * 1000;
const cachePaint = msg => {
    const key = `${msg.target}|${msg.costumeIndex}|${msg.action}`;
    state.recentPaint.set(key, {at: Date.now(), msg});
    if (state.recentPaint.size > 64) {
        const oldest = state.recentPaint.keys().next().value;
        state.recentPaint.delete(oldest);
    }
};

// Presence/cursor traffic is pointless with nobody in the room.
const hasPeers = () => overlay.peers.size > 0;

/*
 * Whether this tab may change the project.
 *
 * A viewer used to be told once, in a toast that faded in under three seconds,
 * and then handed a fully working editor. Everything they did applied locally,
 * went to the server, and was refused there — silently, because the client had
 * no handler for the refusal — until the next snapshot replaced the lot. The
 * only sign anything was wrong was an afternoon's work disappearing.
 *
 * So: viewers send nothing, the workspace stops accepting edits, and the
 * reason stays on screen instead of fading.
 */
const canWrite = () => state.active && state.canEdit && !state.applyingRemote;

/*
 * A viewer's edit is refused at the call, not after it.
 *
 * Suppressing the outgoing message alone still let the change land in this
 * tab's own VM, so the editor showed work that the next snapshot was going to
 * erase — the same lie, told locally. These wrappers are already the one place
 * every structural edit passes through, so they are where it stops.
 *
 * `applyingRemote` is excluded on purpose: everything a viewer is here to SEE
 * arrives through these same methods.
 */
const REFUSE_TOAST_MS = 4000;
const refuseIfViewer = () => {
    if (!state.active || state.canEdit || state.applyingRemote) return false;
    if (Date.now() - (state.lastRefuseAt || 0) > REFUSE_TOAST_MS) {
        state.lastRefuseAt = Date.now();
        overlay.toast('👀 You are watching — ask the owner for edit access', '#8a8fa3');
    }
    return true;
};

/*
 * The palette is a separate Blockly workspace and does not inherit readOnly,
 * and the drag it starts creates the block on the workspace it points at — so
 * that is the one worth asking. Without this a viewer can still pull blocks
 * out of the palette onto a canvas whose every other edit is refused.
 */
const patchFlyoutReadOnly = SB => {
    if (!SB || !SB.Gesture || SB.Gesture.prototype.__squiggleReadOnly) return;
    const proto = SB.Gesture.prototype;
    const original = proto.updateIsDraggingFromFlyout_;
    if (typeof original !== 'function') return;
    proto.updateIsDraggingFromFlyout_ = function () {
        const target = this.flyout_ && this.flyout_.targetWorkspace_;
        if (target && target.options && target.options.readOnly) return false;
        return original.call(this);
    };
    proto.__squiggleReadOnly = true;
};

const applyEditability = () => {
    // Blockly reads options.readOnly live — isMovable/isDeletable/isEditable
    // all consult it — so flipping it here is enough to stop dragging,
    // deleting and field edits on an already-injected workspace.
    if (state.workspace && state.workspace.options) {
        state.workspace.options.readOnly = !state.canEdit;
    }
    patchFlyoutReadOnly(state.ScratchBlocks);
    if (state.canEdit) {
        if (state.readOnlyBannerUp) {
            state.readOnlyBannerUp = false;
            overlay.banner(null);
        }
        return;
    }
    state.readOnlyBannerUp = true;
    overlay.banner('You are watching this project — your changes will not be saved.', {kind: 'busy'});
};

// Send presence only when it actually changed (or as a 3s keepalive refresh).
const sendPresence = fields => {
    if (!state.active) return;
    const now = Date.now();
    const next = {
        status: fields.status === undefined ? state.lastPresence.status : fields.status,
        sprite: fields.sprite === undefined ? state.lastPresence.sprite : fields.sprite
    };
    const changed = next.status !== state.lastPresence.status || next.sprite !== state.lastPresence.sprite;
    if (!changed && now - state.lastPresence.sentAt < 3000) return;
    state.lastPresence = {...next, sentAt: now};
    if (hasPeers()) client.send({type: 'presence', ...fields});
};

// -------------------------------------------------------------- utilities ---

const b64FromBuffer = buf => {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
};

// Faster than a per-byte loop on multi-MB snapshots (join from room cache).
const bufferFromB64 = b64 => {
    const bin = atob(b64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    const CHUNK = 0x8000;
    for (let i = 0; i < len; i += CHUNK) {
        const end = Math.min(i + CHUNK, len);
        for (let j = i; j < end; j++) bytes[j] = bin.charCodeAt(j);
    }
    return bytes.buffer;
};

const editingTargetName = () => {
    const t = state.vm && state.vm.editingTarget;
    return t ? t.getName() : null;
};

const rebuildTargetIndex = () => {
    const map = new Map();
    if (state.vm) {
        const targets = state.vm.runtime.targets;
        for (let i = 0; i < targets.length; i++) {
            const t = targets[i];
            if (t && t.isOriginal) map.set(t.getName(), t);
        }
    }
    state.targetByName = map;
};

const findTargetByName = name => {
    if (!state.vm || !name) return null;
    if (!state.targetByName) rebuildTargetIndex();
    const t = state.targetByName.get(name);
    if (t && t.blocks) return t;
    // Stale after rename/add — rebuild once.
    rebuildTargetIndex();
    return state.targetByName.get(name) || null;
};

/*
 * Costumes and sounds travel with an identity, not just a position.
 *
 * An index is a fact about one editor's list at one moment. A partner adding a
 * costume, deleting one, or dragging one up the strip renumbers everything
 * below it — so "delete costume 3", sent when 3 was the hat, arrives at a peer
 * where 3 is the whole drawing. Blocks learned this already and route by sprite
 * name; this is the same lesson for the two lists that never got it.
 *
 * The index still travels, as a hint: it settles which one was meant when a
 * costume has been duplicated and the names and assets are identical.
 */
const costumeIdent = (targetName, index) => {
    const t = findTargetByName(targetName);
    const c = t && t.getCostumes()[index];
    return c ? {name: c.name, assetId: c.assetId || c.md5 || null} : null;
};

const soundIdent = (targetName, index) => {
    const t = findTargetByName(targetName);
    const s = t && t.getSounds()[index];
    return s ? {name: s.name, assetId: s.assetId || s.md5 || null} : null;
};

/* Where the sender's item lives in OUR list. -1 means "not here" — which is an
 * answer, and a better one than acting on whatever is sitting at that index. */
const resolveIndex = (list, index, ident) => {
    if (!list || !list.length) return -1;
    if (!ident) return (index >= 0 && index < list.length) ? index : -1;
    const idOf = it => it.assetId || it.md5 || null;
    const at = list[index];
    // The hinted position, when it still holds what the sender was pointing at.
    if (at && at.name === ident.name && (!ident.assetId || idOf(at) === ident.assetId)) return index;
    if (ident.assetId) {
        for (let i = 0; i < list.length; i++) {
            if (idOf(list[i]) === ident.assetId && list[i].name === ident.name) return i;
        }
    }
    for (let i = 0; i < list.length; i++) {
        if (list[i].name === ident.name) return i;
    }
    return -1;
};

const resolveCostume = (target, msg, index) =>
    resolveIndex(target.getCostumes(), index, msg.ident);
const resolveSound = (target, msg) => resolveIndex(target.getSounds(), msg.index, msg.ident);

// Blockly event JSON -> the shape scratch-vm's blocklyListen/adapter expects.
const jsonToVmEvent = json => {
    const e = Object.assign({}, json);
    if (typeof e.xml === 'string') {
        try {
            e.xml = new DOMParser().parseFromString(e.xml, 'text/xml').documentElement;
        } catch (err) {
            return null;
        }
    }
    for (const key of ['newCoordinate', 'oldCoordinate']) {
        if (typeof e[key] === 'string') {
            const parts = e[key].split(',');
            e[key] = {x: Number(parts[0]), y: Number(parts[1])};
        }
    }
    return e;
};

const RELAYED_BLOCK_EVENTS = new Set([
    'create', 'delete', 'change', 'move',
    'var_create', 'var_delete', 'var_rename',
    'comment_create', 'comment_change', 'comment_move', 'comment_delete'
]);

// ------------------------------------------------------------- snapshots ---

// cacheOnly snapshots update the server's persisted copy (for late joiners /
// restarts) WITHOUT making current peers reload — used after live-synced paint
// edits, where peers already have the change applied in place.
// Browser-native base64 (FileReader) — the manual chunk loop janks the main
// thread hard on multi-MB projects, which showed up as editor stutter.
const blobToB64 = blob => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
});

const pngFromImageData = imageData => new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    canvas.getContext('2d').putImageData(imageData, 0, 0);
    canvas.toBlob(blob => {
        if (blob) blobToB64(blob).then(resolve, reject);
        else reject(new Error('toBlob returned null'));
    }, 'image/png');
});

const decodePng = b64 => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = `data:image/png;base64,${b64}`;
});

const imageDataFromImg = (img, w, h) => {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, w, h);
};

const sendSnapshotNow = async cacheOnly => {
    if (!state.active || state.applyingRemote || !state.vm) return;
    // One zip at a time — overlapping saveProjectSb3 janks the editor hard.
    if (state.snapshotInFlight) {
        // false = full relay must win over a queued cacheOnly.
        state.snapshotAgain = cacheOnly === true ?
            (state.snapshotAgain !== false) : false;
        return;
    }
    state.snapshotInFlight = true;
    try {
        // Land any coalesced block moves before we snapshot so the zip matches
        // what peers already received live.
        flushBlockMoves();
        if (cacheOnly === true) state.lastCacheSnapAt = Date.now();
        // Ask JSZip for base64 directly — skips the blob -> FileReader -> b64
        // copy chain (one less multi-MB pass on the main thread per snapshot).
        let b64;
        try {
            b64 = await state.vm.saveProjectSb3('base64');
        } catch (e) {
            const out = await state.vm.saveProjectSb3();
            b64 = typeof out.arrayBuffer === 'function' ?
                await blobToB64(out) :
                b64FromBuffer(out);
        }
        // Drop if we went inactive / started applying remote mid-zip.
        if (!state.active || state.applyingRemote) return;
        if (b64 === state.lastSnapshotB64) return; // nothing actually changed
        state.lastSnapshotB64 = b64;
        const force = state.forceNextSnapshot === true;
        state.forceNextSnapshot = false;
        const reset = cacheOnly !== true && state.resetNextSnapshot === true;
        if (reset) state.resetNextSnapshot = false;
        client.send({
            type: 'snapshot',
            b64,
            cacheOnly: cacheOnly === true,
            basedOn: state.roomVersion,
            force,
            reset
        });
    } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[collab] snapshot failed', e);
    } finally {
        state.snapshotInFlight = false;
        if (state.snapshotAgain !== undefined) {
            const again = state.snapshotAgain;
            state.snapshotAgain = undefined;
            scheduleSnapshot(again);
        }
    }
};

/*
 * A debounce re-armed by every edit never fires while the editing continues,
 * and this debounce guards the ONLY path by which work reaches disk. A child
 * who keeps painting, or keeps dragging blocks, without ever pausing the
 * minimum wait is a child whose afternoon is not being saved — the same
 * failure the cacheOnly path was added to fix, arriving through the timer
 * instead of through the missing call. So the deferral has a ceiling: however
 * busy it gets, a save goes out this often.
 */
const SNAPSHOT_MAX_WAIT_MS = 30000;

const scheduleSnapshot = cacheOnly => {
    if (!state.active || state.applyingRemote || !state.canEdit) return;
    if (!client.connected) state.offlineEdits = true;
    // A pending relay snapshot must not be downgraded by a later cacheOnly request.
    state.pendingSnapshotCacheOnly = state.snapshotTimer ?
        (state.pendingSnapshotCacheOnly && cacheOnly === true) :
        cacheOnly === true;
    if (!state.snapshotTimer) state.snapshotDeferredSince = Date.now();
    clearTimeout(state.snapshotTimer);
    // cacheOnly snapshots only refresh the server's copy for late joiners — the
    // live edits already reached everyone. Zipping the whole project is the
    // expensive part (multi-MB in game rooms), so do it rarely and when idle.
    const wait = state.pendingSnapshotCacheOnly ?
        Math.max(1500, 20000 - (Date.now() - (state.lastCacheSnapAt || 0))) :
        1000;
    const remaining = (state.snapshotDeferredSince + SNAPSHOT_MAX_WAIT_MS) - Date.now();
    state.snapshotTimer = setTimeout(() => {
        state.snapshotTimer = null;
        state.snapshotDeferredSince = 0;
        const flag = state.pendingSnapshotCacheOnly;
        // Don't zip while the tab is backgrounded — visibility handler resumes.
        if (typeof document !== 'undefined' && document.hidden) {
            state.deferredSnapshot = flag;
            return;
        }
        if (flag && typeof window.requestIdleCallback === 'function') {
            window.requestIdleCallback(() => sendSnapshotNow(true), {timeout: 8000});
        } else {
            sendSnapshotNow(flag);
        }
    }, Math.max(0, Math.min(wait, remaining)));
};

if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
        if (!state.active) return;
        if (document.hidden) {
            // Don't leave coalesced moves sitting in a timer across sleep.
            flushBlockMoves();
            return;
        }
        if (state.deferredSnapshot !== undefined) {
            const flag = state.deferredSnapshot;
            state.deferredSnapshot = undefined;
            scheduleSnapshot(flag);
        }
    });

    // Mid-stroke guard for live co-painting: remote paint holds while the
    // local pointer is down and lands right after release — after
    // scratch-paint's own mouseup commit has fired.
    document.addEventListener('pointerdown', () => {
        state.pointerDown = true;
    }, true);
    const pointerReleased = () => {
        if (!state.pointerDown) return;
        state.pointerDown = false;
        setTimeout(() => {
            if (!state.pointerDown && state.pendingRemotePaint.size) flushPendingPaint();
        }, 80);
    };
    document.addEventListener('pointerup', pointerReleased, true);
    document.addEventListener('pointercancel', pointerReleased, true);
    window.addEventListener('blur', pointerReleased);

    // Live cursors inside the paint editor: partners see WHERE you're drawing,
    // not just that you're "painting". Coordinates travel in paper project
    // space so they stay glued through each side's own zoom and pan.
    document.addEventListener('mousemove', evt => {
        if (!state.active || state.localTab !== 1 || !hasPeers()) return;
        const now = Date.now();
        if (now - state.lastCursorSent < 66) return;
        try {
            if (!paper.view || !paper.view.element) return;
            const rect = paper.view.element.getBoundingClientRect();
            if (rect.width < 10 ||
                evt.clientX < rect.left || evt.clientX > rect.right ||
                evt.clientY < rect.top || evt.clientY > rect.bottom) return;
            state.lastCursorSent = now;
            const pt = paper.view.viewToProject(
                new paper.Point(evt.clientX - rect.left, evt.clientY - rect.top));
            client.send({type: 'cursor', space: 'paint', x: pt.x, y: pt.y, sprite: editingTargetName()});
            state.cursorShown = true;
        } catch (e) { /* paint editor mid-teardown */ }
    }, true);
}

const reapplyRecentPaint = () => {
    if (!state.recentPaint.size) return;
    const cutoff = Date.now() - PAINT_CACHE_MAX_AGE_MS;
    for (const [key, entry] of state.recentPaint) {
        if (entry.at < cutoff) {
            state.recentPaint.delete(key);
            continue;
        }
        try {
            if (entry.msg.action === 'updateSvg') applyRemoteSvg(entry.msg);
            else applyRemoteBitmap(entry.msg);
        } catch (e) { /* costume/target no longer exists in the new snapshot */ }
    }
};

/*
 * Park the local project in the user's own library before something replaces
 * it. The room is a single shared document, so when two people's states
 * diverge one of them has to lose — but losing should mean "it's in your
 * library", not "it's gone". Rate-limited because the losing side of a stale
 * snapshot can happen repeatedly during a bad connection, and 40 near-identical
 * rescues is its own kind of data loss.
 */
const RESCUE_COOLDOWN_MS = 5 * 60 * 1000;
const rescueLocalProject = async why => {
    if (!state.vm || !state.canEdit) return false;
    if (Date.now() - (state.lastRescueAt || 0) < RESCUE_COOLDOWN_MS) return false;
    state.lastRescueAt = Date.now();
    try {
        const b64 = await state.vm.saveProjectSb3('base64');
        const when = new Date().toLocaleString();
        client.send({
            type: 'save-project',
            name: `Rescued — ${state.appliedTitle || 'project'} — ${when}`,
            b64,
            quiet: true
        });
        overlay.toast(`💾 Your unsaved changes were saved to your library (${why})`, '#f0912b');
        return true;
    } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[collab] rescue save failed', e);
        return false;
    }
};

const applySnapshot = async msg => {
    if (!state.vm || !msg || !msg.b64) return;
    // This snapshot is about to overwrite edits of ours that never reached the
    // room. Keep a copy first — silently discarding someone's work is the one
    // outcome this whole sync engine must never produce.
    if (msg.stale || state.rescueOnNextSnapshot) {
        const why = msg.stale ? 'someone else saved first' : 'someone else was already in the room';
        state.rescueOnNextSnapshot = false;
        await rescueLocalProject(why);
    }
    // Reconnect with edits made while offline and nobody else in the room:
    // our local copy is the newest truth — the welcome handler already pushed
    // it, so drop the stale room snapshot instead of reverting the user's work.
    if (state.skipNextSnapshot) {
        state.skipNextSnapshot = false;
        return;
    }
    // Reconnects re-deliver the room snapshot — if it's the state we already
    // have (usually our own), don't reload the project out from under us.
    // Unless we asked for this one: a resync request means live edits went
    // missing since that snapshot, so "we already have it" is exactly the
    // belief that is wrong, and skipping would leave the divergence in place.
    if (state.forceApplyNextSnapshot) {
        state.forceApplyNextSnapshot = false;
    } else if (msg.b64 === state.lastSnapshotB64) {
        if (typeof msg.version === 'number') state.roomVersion = msg.version;
        return;
    }
    // Never yank the project while the user is mid-paint — hold the newest
    // snapshot and apply it when they leave the costumes tab.
    if (state.localTab === 1) {
        state.pendingSnapshotMsg = msg;
        state.pendingRemotePaint.clear(); // snapshot supersedes queued strokes
        return;
    }
    // Serialize loads: concurrent loadProject on one VM corrupts state.
    // Keep only the newest pending message and run them one at a time.
    if (state.snapshotLoading) {
        state.pendingSnapshotMsg = msg;
        return;
    }

    const keepTarget = editingTargetName();
    state.applyingRemote++;
    state.snapshotLoading = true;
    if (msg.reset) state.recentPaint.clear(); // deliberate project open — don't resurrect old paint
    // SVG diff bases die with the old assets (the editor reloads from the new
    // ones). Bitmap shadows survive — they're the freshest pixels to restore.
    for (const k of [...state.paintBase.keys()]) {
        if (k.endsWith('|svg') || msg.reset) state.paintBase.delete(k);
    }
    try {
        await state.vm.loadProject(bufferFromB64(msg.b64));
        // Only mark applied after a successful load — failed loads must retry.
        // Assigned after an await, but not a race: `snapshotLoading` above is
        // set before the await and gates every other entry to this function, so
        // nothing else can be inside the load.
        // eslint-disable-next-line require-atomic-updates -- guarded by snapshotLoading
        state.lastSnapshotB64 = msg.b64;
        // The version, though, has other writers — `snapshot-ack` can land
        // while we load, and it is newer than the snapshot we started with.
        // Never move backwards, or the next send is `basedOn` a stale version
        // and the server gate rejects it.
        if (typeof msg.version === 'number' && msg.version > state.roomVersion) {
            state.roomVersion = msg.version;
        }
        rebuildTargetIndex();
        // The zip we just loaded can be up to ~20s behind live-synced paint —
        // re-apply the freshest costume state so strokes never get reverted.
        const reapplied = !msg.reset && state.recentPaint.size > 0;
        if (reapplied) reapplyRecentPaint();
        const restored = findTargetByName(keepTarget);
        if (restored) state.vm.setEditingTarget(restored.id);
        if (msg.author && msg.author !== 'server') {
            overlay.toast(`🔄 Project synced from ${msg.author}`, msg.color);
        }
        // Costumes now differ from the room's persisted zip — refresh it
        // (cacheOnly: peers already have the paint live).
        if (reapplied) setTimeout(() => scheduleSnapshot(true), 0);
    } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[collab] failed to apply snapshot', e);
    } finally {
        // Same gate: this function is the only writer of snapshotLoading, and
        // it cannot be re-entered while the flag is up.
        // eslint-disable-next-line require-atomic-updates -- guarded by snapshotLoading
        state.snapshotLoading = false;
        state.applyingRemote--;
    }

    // Block edits that raced the load were queued — replay on the state we just
    // loaded (do this even if another snapshot is pending / paint-deferred).
    const queued = state.queuedBlockEvents.splice(0);
    const orphans = state.orphanBlockEvents.splice(0);
    for (let i = 0; i < queued.length; i++) applyBlockEvent(queued[i]);
    for (let i = 0; i < orphans.length; i++) applyBlockEvent(orphans[i]);

    // A newer snapshot arrived while we were loading — apply it next (or
    // re-defer if the user is still on the costumes tab).
    if (state.pendingSnapshotMsg && state.pendingSnapshotMsg.b64 !== state.lastSnapshotB64) {
        const next = state.pendingSnapshotMsg;
        state.pendingSnapshotMsg = null;
        await applySnapshot(next);
    }
};

// -------------------------------------------------- outgoing: VM wrapping ---

// Only these still resync via full snapshot — everything else (sprites,
// costumes, sounds, paint, renames, reorders) relays as targeted messages so
// nobody's editor freezes on a whole-project zip + reload anymore.
const SNAPSHOT_METHODS = [
    'updateSoundBuffer',
    'shareBlocksToTarget', 'shareCostumeToTarget', 'shareSoundToTarget'
];

// Light operations relay as tiny targeted messages instead of snapshots.
// buildMsg runs BEFORE the mutation so it can capture pre-change names.
const wrapTargeted = (vm, method, buildMsg, refusal) => {
    if (typeof vm[method] !== 'function') return;
    const original = vm[method].bind(vm);
    vm[method] = (...args) => {
        if (refuseIfViewer()) return refusal && refusal();
        const msg = canWrite() ? buildMsg(...args) : null;
        const result = original(...args);
        if (msg) {
            // Renames invalidate the name→target index used by remote applies.
            if (method === 'renameSprite') rebuildTargetIndex();
            if (hasPeers()) client.send({type: 'vm-action', action: method, ...msg});
            scheduleSnapshot(true); // keep the server's cached copy fresh, relay-free
        }
        return result;
    };
};

const wrapVm = vm => {
    for (const method of SNAPSHOT_METHODS) {
        if (typeof vm[method] !== 'function') continue;
        const original = vm[method].bind(vm);
        vm[method] = (...args) => {
            if (refuseIfViewer()) return Promise.resolve();
            // Capture NOW — the flag is long reset by the time the promise
            // resolves, and a remote-triggered rebroadcast would loop.
            const wasRemote = state.applyingRemote;
            const result = original(...args);
            if (!wasRemote) Promise.resolve(result).then(scheduleSnapshot, () => {});
            return result;
        };
    }

    const targetNameById = id => {
        const t = vm.runtime.getTargetById(id);
        return t ? t.getName() : null;
    };

    // ---- targeted sprite sync (no more full-project reloads on add/delete) --

    // addSprite / duplicateSprite: after the sprite lands locally, export just
    // that sprite (.sprite3 zip) and relay it — receivers install it in place.
    const wrapSpriteAdder = method => {
        if (typeof vm[method] !== 'function') return;
        const original = vm[method].bind(vm);
        vm[method] = (...args) => {
            if (refuseIfViewer()) return Promise.resolve();
            const wasRemote = !canWrite();
            const before = wasRemote ? null : new Set(
                vm.runtime.targets.filter(t => t.isOriginal).map(t => t.getName()));
            const result = original(...args);
            if (!wasRemote) {
                Promise.resolve(result).then(() => {
                    rebuildTargetIndex();
                    const added = vm.runtime.targets.filter(t =>
                        t.isOriginal && !t.isStage && !before.has(t.getName()));
                    for (const t of added) {
                        if (hasPeers()) {
                            vm.exportSprite(t.id, 'base64').then(b64 => {
                                client.send({type: 'vm-action', action: 'spriteAdd', sprite: b64, name: t.getName()});
                            }, () => scheduleSnapshot()); // export failed — fall back to full resync
                        }
                    }
                    scheduleSnapshot(true); // keep the server's cached copy fresh
                }, () => {});
            }
            return result;
        };
    };
    wrapSpriteAdder('addSprite');
    wrapSpriteAdder('duplicateSprite');

    const originalDeleteSprite = vm.deleteSprite.bind(vm);
    vm.deleteSprite = targetId => {
        if (refuseIfViewer()) return () => {};
        const wasRemote = !canWrite();
        const name = targetNameById(targetId);
        const result = originalDeleteSprite(targetId);
        if (!wasRemote && name) {
            rebuildTargetIndex();
            if (hasPeers()) client.send({type: 'vm-action', action: 'spriteDelete', target: name});
            scheduleSnapshot(true);
        }
        return result;
    };

    // addCostume / addCostumeFromLibrary / addBackdrop / addSound: the asset
    // bytes ride in the message; receivers recreate the asset locally.
    const wrapCostumeAdder = (method, fixedVersion, stageTarget) => {
        if (typeof vm[method] !== 'function') return;
        const original = vm[method].bind(vm);
        vm[method] = (md5ext, costumeObject, optTargetId, optVersion) => {
            if (refuseIfViewer()) return Promise.resolve();
            const wasRemote = !canWrite();
            const result = original(md5ext, costumeObject, optTargetId, optVersion);
            if (!wasRemote) {
                Promise.resolve(result).then(() => {
                    const targetName = stageTarget ?
                        (vm.runtime.getTargetForStage() && vm.runtime.getTargetForStage().getName()) :
                        (optTargetId ? targetNameById(optTargetId) : editingTargetName());
                    const asset = costumeObject && costumeObject.asset;
                    if (targetName && asset && asset.data && hasPeers()) {
                        client.send({
                            type: 'vm-action',
                            action: 'costumeAdd',
                            target: targetName,
                            version: fixedVersion === undefined ? optVersion : fixedVersion,
                            costume: {
                                name: costumeObject.name,
                                dataFormat: costumeObject.dataFormat || asset.dataFormat,
                                bitmapResolution: costumeObject.bitmapResolution,
                                rotationCenterX: costumeObject.rotationCenterX,
                                rotationCenterY: costumeObject.rotationCenterY
                            },
                            data: b64FromBuffer(asset.data)
                        });
                    }
                    scheduleSnapshot(true);
                }, () => {});
            }
            return result;
        };
    };
    wrapCostumeAdder('addCostume');
    wrapCostumeAdder('addCostumeFromLibrary', 2);
    wrapCostumeAdder('addBackdrop', undefined, true);

    const originalAddSound = vm.addSound.bind(vm);
    vm.addSound = (soundObject, optTargetId) => {
        if (refuseIfViewer()) return Promise.resolve();
        const wasRemote = !canWrite();
        const result = originalAddSound(soundObject, optTargetId);
        if (!wasRemote) {
            Promise.resolve(result).then(() => {
                const targetName = optTargetId ? targetNameById(optTargetId) : editingTargetName();
                const asset = soundObject && soundObject.asset;
                if (targetName && asset && asset.data && hasPeers()) {
                    client.send({
                        type: 'vm-action',
                        action: 'soundAdd',
                        target: targetName,
                        sound: {
                            name: soundObject.name,
                            dataFormat: soundObject.dataFormat || asset.dataFormat
                        },
                        data: b64FromBuffer(asset.data)
                    });
                }
                scheduleSnapshot(true);
            }, () => {});
        }
        return result;
    };

    // User opening a local .sb3 replaces the whole room project — that's the
    // one legit full-snapshot left, and it must not resurrect cached paint.
    const originalLoad = vm.loadProject.bind(vm);
    vm.loadProject = (...args) => {
        const result = originalLoad(...args);
        if (!state.applyingRemote) {
            Promise.resolve(result).then(() => {
                state.recentPaint.clear();
                state.paintBase.clear();
                state.resetNextSnapshot = true;
                scheduleSnapshot();
            }, () => {});
        }
        return result;
    };

    const originalGreenFlag = vm.greenFlag.bind(vm);
    vm.greenFlag = (...args) => {
        if (canWrite()) {
            client.send({type: 'vm-action', action: 'greenFlag'});
            sendPresence({status: '▶ playing'});
        }
        return originalGreenFlag(...args);
    };

    const originalStopAll = vm.stopAll.bind(vm);
    vm.stopAll = (...args) => {
        if (canWrite()) {
            client.send({type: 'vm-action', action: 'stopAll'});
            sendPresence({status: 'here'});
        }
        return originalStopAll(...args);
    };

    // Live sprite dragging / property edits on the stage & sprite panel.
    // Throttled with a trailing send so the final drag position always lands.
    const flushSpriteInfo = () => {
        state.spriteInfoTimer = null;
        if (!state.pendingSpriteInfo || !hasPeers()) return;
        state.lastSpriteInfoSent = Date.now();
        client.send(state.pendingSpriteInfo);
        state.pendingSpriteInfo = null;
    };
    const originalPostSpriteInfo = vm.postSpriteInfo.bind(vm);
    vm.postSpriteInfo = data => {
        if (refuseIfViewer()) return;
        const result = originalPostSpriteInfo(data);
        // While the project is RUNNING each machine simulates independently —
        // syncing positions mid-game makes the simulations fight (rubber-band
        // "lag"). Positions converge naturally when play stops.
        if (canWrite() && !state.projectRunning && hasPeers()) {
            const target = editingTargetName();
            if (target) {
                state.pendingSpriteInfo = {type: 'sprite-info', target, data};
                const elapsed = Date.now() - state.lastSpriteInfoSent;
                if (elapsed > 45) {
                    flushSpriteInfo();
                } else if (!state.spriteInfoTimer) {
                    state.spriteInfoTimer = setTimeout(flushSpriteInfo, 50 - elapsed);
                }
            }
        }
        return result;
    };

    wrapTargeted(vm, 'renameSprite', (targetId, newName) => {
        const target = targetNameById(targetId);
        return target ? {target, newName} : null;
    });
    wrapTargeted(vm, 'renameCostume', (index, newName) => {
        const target = editingTargetName();
        return {target, index, newName, ident: costumeIdent(target, index)};
    });
    wrapTargeted(vm, 'renameSound', (index, newName) => {
        const target = editingTargetName();
        return {target, index, newName, ident: soundIdent(target, index)};
    });
    wrapTargeted(vm, 'reorderCostume', (targetId, from, to) => {
        const target = targetNameById(targetId);
        // `to` is a destination slot and stays positional — there is nothing
        // else it could be — but `from` names the costume being moved, so at
        // least the right one moves.
        return target ? {target, from, to, ident: costumeIdent(target, from)} : null;
    });
    wrapTargeted(vm, 'reorderSound', (targetId, from, to) => {
        const target = targetNameById(targetId);
        return target ? {target, from, to, ident: soundIdent(target, from)} : null;
    });
    wrapTargeted(vm, 'reorderTarget', (from, to) => ({from, to}));
    // Delete/duplicate of costumes & sounds operate on vm.editingTarget by
    // index — tiny targeted messages, no zips.
    wrapTargeted(vm, 'deleteCostume', index => {
        const target = editingTargetName();
        return {target, index, ident: costumeIdent(target, index)};
    }, () => () => {});
    wrapTargeted(vm, 'duplicateCostume', index => {
        const target = editingTargetName();
        return {target, index, ident: costumeIdent(target, index)};
    });
    wrapTargeted(vm, 'deleteSound', index => {
        const target = editingTargetName();
        return {target, index, ident: soundIdent(target, index)};
    }, () => () => {});
    wrapTargeted(vm, 'duplicateSound', index => {
        const target = editingTargetName();
        return {target, index, ident: soundIdent(target, index)};
    });

    // Live paint sync — vector strokes relay per edit-commit; bitmap edits are
    // heavier (raw pixels) so they relay with a trailing debounce. Both also
    // refresh the server's cached .sb3 (cacheOnly) for late joiners.
    const costumeSvgText = (targetName, index) => {
        const t = findTargetByName(targetName);
        const c = t && t.getCostumes()[index];
        if (!c || !c.asset || c.dataFormat !== 'svg') return null;
        try {
            return new TextDecoder().decode(c.asset.data);
        } catch (e) {
            return null;
        }
    };

    const originalUpdateSvg = vm.updateSvg.bind(vm);
    vm.updateSvg = (costumeIndex, svg, rotationCenterX, rotationCenterY) => {
        if (refuseIfViewer()) return;
        // Capture the diff base BEFORE the mutation: what this export was built
        // from (the last export/apply for this costume, or the current asset).
        let target = null;
        let prev = null;
        let ident = null;
        if (canWrite()) {
            target = editingTargetName();
            if (target) {
                // Captured before the write, like `prev`: afterwards the asset
                // id belongs to the stroke we are about to send, which is not
                // what the receiver is holding.
                ident = costumeIdent(target, costumeIndex);
                prev = state.paintBase.get(`${target}|${costumeIndex}|svg`);
                if (prev == null) prev = costumeSvgText(target, costumeIndex);
            }
        }
        const result = originalUpdateSvg(costumeIndex, svg, rotationCenterX, rotationCenterY);
        if (canWrite() && target) {
            state.paintBase.set(`${target}|${costumeIndex}|svg`, svg);
            trimPaintBase();
            const msg = {
                type: 'vm-action',
                action: 'updateSvg',
                target,
                costumeIndex,
                ident,
                svg,
                rotationCenterX,
                rotationCenterY
            };
            cachePaint(msg); // survives any snapshot that lands on top of it
            if (hasPeers()) {
                // Stroke-level delta lets a receiver who has DIVERGED (their own
                // concurrent strokes) replay just our strokes instead of
                // clobbering theirs with our full costume.
                const delta = prev ? paintMerge.diffSvg(prev, svg) : null;
                client.send(delta ?
                    Object.assign({}, msg, {baseHash: paintMerge.hashStr(prev), delta}) :
                    msg);
                sendPresence({status: '🎨 painting', sprite: target});
            }
            scheduleSnapshot(true);
        }
        return result;
    };

    // Bitmap wire format: when we know the receiver's base (same dims), send
    // only the changed-pixel rect + mask as small PNGs — merges concurrent
    // brush areas on the receiver instead of replacing their whole bitmap, and
    // is 100-1000x smaller than the raw RGBA that caused the co-painting
    // stutter. First commit / resize sends a full PNG; raw is the last resort.
    const sendBitmap = async p => {
        const {meta, pixels} = p;
        const key = `${meta.target}|${meta.costumeIndex}|bmp`;
        const prev = state.paintBase.get(key);
        state.paintBase.set(key, {pixels, width: meta.width, height: meta.height});
        trimPaintBase();
        // Snapshot-reapply restores bitmaps from this shadow — no PNG needed.
        cachePaint(Object.assign({}, meta, {useShadow: true}));
        if (!hasPeers()) return;
        try {
            if (prev && prev.width === meta.width && prev.height === meta.height) {
                const diff = paintMerge.diffBitmap(prev.pixels, pixels, meta.width, meta.height);
                if (!diff) return; // nothing actually changed
                const maskData = new ImageData(diff.pw, diff.ph);
                for (let i = 0; i < diff.mask.length; i++) maskData.data[(i * 4) + 3] = diff.mask[i];
                const [patchB64, maskB64] = await Promise.all([
                    pngFromImageData(diff.patch),
                    pngFromImageData(maskData)
                ]);
                client.send(Object.assign({}, meta, {
                    encoding: 'png',
                    mode: 'patch',
                    px: diff.px,
                    py: diff.py,
                    pw: diff.pw,
                    ph: diff.ph,
                    data: patchB64,
                    mask: maskB64
                }));
            } else {
                const fullB64 = await pngFromImageData(new ImageData(pixels, meta.width, meta.height));
                client.send(Object.assign({}, meta, {encoding: 'png', data: fullB64}));
            }
        } catch (e) {
            client.send(Object.assign({}, meta, {data: b64FromBuffer(pixels.buffer)}));
        }
    };

    // Every costume touched inside the debounce window, not just the last one.
    const flushPendingBitmaps = () => {
        state.bitmapTimer = null;
        const batch = [...state.pendingBitmaps.values()];
        state.pendingBitmaps.clear();
        for (const p of batch) sendBitmap(p).catch(() => {});
    };

    const originalUpdateBitmap = vm.updateBitmap.bind(vm);
    vm.updateBitmap = (costumeIndex, bitmap, rotationCenterX, rotationCenterY, bitmapResolution) => {
        if (refuseIfViewer()) return;
        const result = originalUpdateBitmap(costumeIndex, bitmap, rotationCenterX, rotationCenterY, bitmapResolution);
        if (canWrite()) {
            const target = editingTargetName();
            if (target && hasPeers()) {
                // Copy the pixel view only — bitmap.data.buffer may be a larger
                // ArrayBuffer shared with other views (byteOffset !== 0).
                const pixels = bitmap.data;
                const pixelCopy = new Uint8ClampedArray(pixels.buffer.slice(
                    pixels.byteOffset,
                    pixels.byteOffset + pixels.byteLength
                ));
                state.pendingBitmaps.set(`${target}|${costumeIndex}`, {
                    pixels: pixelCopy,
                    meta: {
                        type: 'vm-action',
                        action: 'updateBitmap',
                        target,
                        costumeIndex,
                        ident: costumeIdent(target, costumeIndex),
                        width: bitmap.width,
                        height: bitmap.height,
                        sourceWidth: bitmap.sourceWidth,
                        sourceHeight: bitmap.sourceHeight,
                        rotationCenterX,
                        rotationCenterY,
                        bitmapResolution
                    }
                });
                clearTimeout(state.bitmapTimer);
                state.bitmapTimer = setTimeout(flushPendingBitmaps, 250);
                sendPresence({status: '🎨 painting', sprite: target});
            }
            scheduleSnapshot(true);
        }
        return result;
    };

    const originalSetEditingTarget = vm.setEditingTarget.bind(vm);
    vm.setEditingTarget = (...args) => {
        const result = originalSetEditingTarget(...args);
        if (state.active && !state.applyingRemote) {
            sendPresence({sprite: editingTargetName()});
        }
        return result;
    };

    vm.runtime.on('PROJECT_RUN_START', () => {
        state.projectRunning = true;
        if (state.active && !state.applyingRemote) sendPresence({status: '▶ playing'});
    });
    vm.runtime.on('PROJECT_RUN_STOP', () => {
        state.projectRunning = false;
        if (state.active && !state.applyingRemote) sendPresence({status: 'here'});
    });

    vm.runtime.on('PROJECT_LOADED', rebuildTargetIndex);
};

/*
 * Frame interpolation: render at the display's refresh rate while game logic
 * keeps its designed tick (30fps for most Scratch projects) — smooth motion
 * without changing gameplay speed. On by default because most projects look
 * better for it.
 *
 * Loading a project resets runtime options, so it has to be re-asserted after
 * every load — but re-asserting `true` meant the Settings checkbox could not
 * turn it off: the next sync silently switched it back on, and in a live room
 * that is every few seconds. Re-assert the WANTED value instead, and treat any
 * call to setInterpolation as the new want.
 *
 * Lives outside wrapVm because wrapVm only runs for someone who joined a room.
 * Editing alone is the same editor and deserves the same default; having it
 * depend on whether you happened to open a room link was an accident of where
 * the code sat.
 */
const installInterpolation = vm => {
    const applyInterpolation = on => {
        try {
            vm.setInterpolation(on);
        } catch (e) { /* older vm */ }
        // The checkbox lives in redux and is set separately from the runtime,
        // so it has to be told or it will disagree with what the eye sees.
        if (hooks.setInterpolation) hooks.setInterpolation(on);
    };

    if (typeof vm.setInterpolation === 'function' && !vm.setInterpolation.__squiggle) {
        const original = vm.setInterpolation.bind(vm);
        const wrapped = on => {
            state.wantInterpolation = !!on;
            savePref(INTERPOLATION_KEY, !!on);
            return original(on);
        };
        wrapped.__squiggle = true;
        vm.setInterpolation = wrapped;
    }

    applyInterpolation(state.wantInterpolation);
    vm.runtime.on('PROJECT_LOADED', () => applyInterpolation(state.wantInterpolation));
};

// ------------------------------------------------ outgoing: block events ---

const flushBlockMoves = () => {
    if (state.blockMoveTimer) {
        clearTimeout(state.blockMoveTimer);
        state.blockMoveTimer = null;
    }
    if (!state.pendingBlockMoves.size) return;
    const batch = state.pendingBlockMoves;
    state.pendingBlockMoves = new Map();
    for (const msg of batch.values()) client.send(msg);
};

const onWorkspaceEvent = e => {
    if (!canWrite() || state.workspaceSuspended) return;
    if (e.type === 'ui') return;
    if (!RELAYED_BLOCK_EVENTS.has(e.type)) return;
    if (!client.connected) state.offlineEdits = true;
    const target = editingTargetName();
    if (!target) return;
    let json;
    try {
        json = e.toJson();
    } catch (err) {
        return;
    }
    // Dragging a stack fires dozens of move events — keep only the latest per block.
    if (e.type === 'move' && json.blockId) {
        state.pendingBlockMoves.set(json.blockId, {type: 'block-event', target, event: json});
        if (!state.blockMoveTimer) {
            state.blockMoveTimer = setTimeout(flushBlockMoves, 32);
        }
        sendPresence({status: '✏️ coding', sprite: target});
        // Moving a block is an edit like any other — it has to reach disk. The
        // cacheOnly path is idle-timed and rate-limited, so a long drag still
        // costs one save, not one per frame.
        scheduleSnapshot(true);
        return;
    }
    if (state.pendingBlockMoves.size) flushBlockMoves();
    client.send({type: 'block-event', target, event: json});
    sendPresence({status: '✏️ coding', sprite: target});
    // Block edits reach peers live but used to reach DISK only if some other
    // kind of edit happened to schedule a snapshot. An afternoon of pure block
    // work therefore persisted nothing: close every tab, or restart the
    // server, and it was gone. cacheOnly keeps it cheap — the save is idle-timed
    // and relay-free, because everyone already has these edits.
    scheduleSnapshot(true);
};

const onWorkspaceMouseMove = evt => {
    if (!state.active || !state.workspace || !hasPeers()) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    const now = Date.now();
    // ~15 fps is plenty for remote cursors and halves WS traffic under load.
    if (now - state.lastCursorSent < 66) return;
    state.lastCursorSent = now;
    try {
        const ctm = state.workspace.getCanvas().getScreenCTM();
        if (!ctm) return;
        const pt = new DOMPoint(evt.clientX, evt.clientY).matrixTransform(ctm.inverse());
        client.send({type: 'cursor', x: pt.x, y: pt.y, sprite: editingTargetName()});
        state.cursorShown = true;
    } catch (e) { /* workspace mid-teardown */ }
};

// Which editor tab is active locally (0 code / 1 costumes / 2 sounds)?
// Read from the DOM so we don't have to thread redux state out of React.
let _tabCache = {idx: 0, at: 0};
const currentTabIndex = () => {
    const now = Date.now();
    if (now - _tabCache.at < 200) return _tabCache.idx;
    const tabs = document.querySelectorAll('ul[role="tablist"] li[role="tab"]');
    let idx = 0;
    const n = Math.min(tabs.length, 3);
    for (let i = 0; i < n; i++) {
        if (tabs[i].getAttribute('aria-selected') === 'true') {
            idx = i;
            break;
        }
    }
    _tabCache = {idx, at: now};
    return idx;
};

const TAB_STATUS = ['here', '🎨 painting', '🎵 sounds'];

// Remote paint edits for the costume the local user is actively painting are
// deferred — applying them mid-edit resets scratch-paint's working state
// (color picker included). They flush as soon as the tab changes.
const flushPendingPaint = () => {
    const queued = [...state.pendingRemotePaint.values()];
    state.pendingRemotePaint.clear();
    for (let i = 0; i < queued.length; i++) applyVmAction(queued[i]);
};

/*
 * Ask the room for a state everyone agrees on.
 *
 * Every buffer in here has a cap, and hitting one means relayed edits were
 * thrown away — an edit nothing will ever resend, because the sender has no
 * idea it did not arrive. Left alone that is permanent, invisible divergence:
 * two people looking at the same room and seeing different projects. The
 * snapshot that comes back costs a reload, which is cheap next to that.
 *
 * Rate limited because the causes come in bursts and the answer is the whole
 * project.
 */
const RESYNC_COOLDOWN_MS = 10000;
const requestResync = why => {
    if (!state.active) return;
    if (Date.now() - (state.lastResyncAt || 0) < RESYNC_COOLDOWN_MS) return;
    state.lastResyncAt = Date.now();
    state.forceApplyNextSnapshot = true;
    client.send({type: 'resync'});
    // eslint-disable-next-line no-console
    console.warn('[collab] dropped relayed edits, resyncing:', why);
};

// A tab left open for a day would otherwise only learn about a deploy by
// reconnecting. Cheap enough at this interval to just ask.
const VERSION_POLL_MS = 5 * 60 * 1000;
const pollVersion = () => {
    if (!state.buildId || Date.now() - (state.lastVersionPoll || 0) < VERSION_POLL_MS) return;
    state.lastVersionPoll = Date.now();
    fetch('/api/version', {cache: 'no-store'})
        .then(r => r.json())
        .then(v => {
            if (v && v.buildId && v.buildId !== state.buildId) {
                overlay.banner('A new version of Squiggle is ready.', {
                    kind: 'update',
                    actionLabel: 'Reload',
                    onAction: () => window.location.reload()
                });
            }
        })
        .catch(() => { /* offline — the reconnect path will catch it */ });
};

const housekeep = () => {
    if (!state.active) return;
    pollVersion();

    const tab = currentTabIndex();
    if (tab !== state.localTab) {
        const wasPainting = state.localTab === 1;
        state.localTab = tab;
        sendPresence({status: TAB_STATUS[tab] || 'here', sprite: editingTargetName()});
        if (wasPainting) {
            if (state.pendingSnapshotMsg) {
                const snap = state.pendingSnapshotMsg;
                state.pendingSnapshotMsg = null;
                state.pendingRemotePaint.clear();
                applySnapshot(snap);
            } else {
                flushPendingPaint();
            }
        }
    }

    // Drop orphaned block-events that never found a sprite (stale after 8s).
    // Expiring one is still losing an edit — the sprite it belonged to never
    // showed up — so say so and get a clean copy rather than carry the hole.
    if (state.orphanBlockEvents.length) {
        const cutoff = Date.now() - 8000;
        const kept = state.orphanBlockEvents.filter(m => (m._queuedAt || 0) > cutoff);
        if (kept.length !== state.orphanBlockEvents.length) requestResync('orphan block-events expired');
        state.orphanBlockEvents = kept;
    }

    if (!state.cursorShown) return;
    let cursorSurfaceVisible = false;
    try {
        if (!document.hidden) {
            if (state.localTab === 1) {
                cursorSurfaceVisible = true; // paint canvas is the cursor surface
            } else if (state.workspace) {
                const rect = state.workspace.getParentSvg().getBoundingClientRect();
                cursorSurfaceVisible = rect.width > 10 && rect.height > 10;
            }
        }
    } catch (e) { /* mid-teardown */ }
    if (!cursorSurfaceVisible) {
        state.cursorShown = false;
        if (hasPeers()) client.send({type: 'cursor', hide: true});
    }
};

const startHousekeeping = () => {
    if (state.housekeepTimer) return;
    state.housekeepTimer = setInterval(housekeep, 1000);
};

/*
 * The room is over for this tab — kicked, replaced by another tab, refused.
 * The socket is already closed for good by the time this runs; without it the
 * 1Hz housekeeper kept polling and every edit kept queueing messages for a
 * connection that is never coming back.
 */
const endSession = () => {
    state.active = false;
    if (state.housekeepTimer) {
        clearInterval(state.housekeepTimer);
        state.housekeepTimer = null;
    }
    clearTimeout(state.snapshotTimer);
    state.snapshotTimer = null;
    overlay.setConnected(false);
};

// ------------------------------------------------- incoming: application ---

const applyBlockEvent = msg => {
    if (state.snapshotLoading) {
        // Don't apply into a half-loaded project — replay after the load.
        if (state.queuedBlockEvents.length < 500) state.queuedBlockEvents.push(msg);
        else requestResync('block-event replay queue full');
        return;
    }
    const target = findTargetByName(msg.target);
    if (!target) {
        // Sprite not here yet (snapshot in flight / rename race) — hold briefly.
        if (state.orphanBlockEvents.length < 200) {
            msg._queuedAt = Date.now();
            state.orphanBlockEvents.push(msg);
        } else {
            requestResync('orphan block-event queue full');
        }
        return;
    }
    const vmEvent = jsonToVmEvent(msg.event);
    if (!vmEvent) return;

    state.applyingRemote++;
    try {
        // var_* / comment events consult runtime.getEditingTarget() — impersonate
        // the sender's editing target for the duration of the apply.
        const runtime = state.vm.runtime;
        const realEditingTarget = runtime._editingTarget;
        runtime._editingTarget = target;
        try {
            target.blocks.blocklyListen(vmEvent);
        } finally {
            runtime._editingTarget = realEditingTarget;
        }

        // Mirror into the visible workspace if this user is looking at the same sprite.
        if (state.workspace && state.ScratchBlocks &&
            state.vm.editingTarget && state.vm.editingTarget === target) {
            const SB = state.ScratchBlocks;
            SB.Events.disable();
            try {
                const blocklyEvent = SB.Events.fromJson(msg.event, state.workspace);
                blocklyEvent.run(true);
            } catch (e) {
                // Workspace drifted from VM (rare) — reload, but not more than
                // twice a second (a burst of bad events used to freeze the editor).
                const now = Date.now();
                if (now - state.lastWorkspaceRefresh > 500) {
                    state.lastWorkspaceRefresh = now;
                    state.vm.refreshWorkspace();
                }
            } finally {
                SB.Events.enable();
            }
        }
    } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[collab] failed to apply block event', e, msg);
    } finally {
        state.applyingRemote--;
    }
};

const applySpriteInfo = msg => {
    if (state.projectRunning) return; // don't fight the running simulation
    const target = findTargetByName(msg.target);
    if (!target) return;
    const d = msg.data || {};
    state.applyingRemote++;
    try {
        if (typeof d.x === 'number' || typeof d.y === 'number') {
            target.setXY(typeof d.x === 'number' ? d.x : target.x, typeof d.y === 'number' ? d.y : target.y);
        }
        if (typeof d.direction === 'number') target.setDirection(d.direction);
        if (typeof d.size === 'number') target.setSize(d.size);
        if (typeof d.visible === 'boolean') target.setVisible(d.visible);
        if (typeof d.rotationStyle === 'string') target.setRotationStyle(d.rotationStyle);
        if (typeof d.name === 'string') state.vm.renameSprite(target.id, d.name);
    } catch (e) { /* target mid-removal */ }
    state.applyingRemote--;
};

// Install a relayed .sprite3 without yanking the local user off their sprite
// (vm.addSprite switches editingTarget to the new sprite).
const applySpriteAdd = msg => {
    const prevEditing = state.vm.editingTarget;
    state.vm.addSprite(new Uint8Array(bufferFromB64(msg.sprite))).then(() => {
        rebuildTargetIndex();
        if (prevEditing && state.vm.runtime.targets.includes(prevEditing)) {
            state.vm.setEditingTarget(prevEditing.id);
        }
        overlay.toast(`✨ ${msg.fromName} added ${msg.name}`, msg.color);
    }, e => {
        // eslint-disable-next-line no-console
        console.error('[collab] sprite install failed', e);
    });
};

const applyCostumeAdd = msg => {
    const target = findTargetByName(msg.target);
    if (!target || !state.vm.runtime.storage) return;
    const storage = state.vm.runtime.storage;
    const fmt = (msg.costume && msg.costume.dataFormat) || 'png';
    const assetType = fmt === 'svg' ? storage.AssetType.ImageVector : storage.AssetType.ImageBitmap;
    const asset = storage.createAsset(assetType, fmt, new Uint8Array(bufferFromB64(msg.data)), null, true);
    const costumeObj = Object.assign({}, msg.costume, {
        asset, assetId: asset.assetId, dataFormat: fmt, md5: `${asset.assetId}.${fmt}`
    });
    // addCostume selects the new costume on the target's OWNER — only relevant
    // if this user is editing the same sprite, which matches solo behavior.
    state.vm.addCostume(costumeObj.md5, costumeObj, target.id, msg.version).catch(e => {
        // eslint-disable-next-line no-console
        console.error('[collab] costume install failed', e);
    });
};

const applySoundAdd = msg => {
    const target = findTargetByName(msg.target);
    if (!target || !state.vm.runtime.storage) return;
    const storage = state.vm.runtime.storage;
    const fmt = (msg.sound && msg.sound.dataFormat) || 'wav';
    const assetType = fmt === 'mp3' ? storage.AssetType.SoundMP3 : storage.AssetType.SoundWav;
    const asset = storage.createAsset(assetType, fmt, new Uint8Array(bufferFromB64(msg.data)), null, true);
    const soundObj = Object.assign({}, msg.sound, {
        asset, assetId: asset.assetId, dataFormat: fmt, md5: `${asset.assetId}.${fmt}`
    });
    Promise.resolve(state.vm.addSound(soundObj, target.id)).catch(e => {
        // eslint-disable-next-line no-console
        console.error('[collab] sound install failed', e);
    });
};

const applyVmAction = msg => {
    state.applyingRemote++;
    try {
        if (msg.action === 'greenFlag') {
            state.vm.greenFlag();
            overlay.toast(`▶ ${msg.fromName} pressed the green flag!`, msg.color);
        } else if (msg.action === 'stopAll') {
            state.vm.stopAll();
        } else if (msg.action === 'renameSprite') {
            const target = findTargetByName(msg.target);
            if (target) {
                state.vm.renameSprite(target.id, msg.newName);
                rebuildTargetIndex();
            }
        } else if (msg.action === 'renameCostume' || msg.action === 'renameSound' ||
            msg.action === 'deleteCostume' || msg.action === 'duplicateCostume' ||
            msg.action === 'deleteSound' || msg.action === 'duplicateSound') {
            // these operate on vm.editingTarget — impersonate briefly
            const target = findTargetByName(msg.target);
            const isSound = msg.action.endsWith('Sound');
            const index = target ?
                (isSound ? resolveSound(target, msg) : resolveCostume(target, msg, msg.index)) : -1;
            // Not here: the costume was already deleted, or renamed out from
            // under this message. Doing nothing is right — falling back to the
            // raw index is how the wrong one gets deleted.
            if (target && index >= 0) {
                const prev = state.vm.editingTarget;
                state.vm.editingTarget = target;
                try {
                    if (msg.action === 'renameCostume' || msg.action === 'renameSound') {
                        state.vm[msg.action](index, msg.newName);
                    } else {
                        state.vm[msg.action](index);
                    }
                } finally {
                    state.vm.editingTarget = prev;
                }
            }
        } else if (msg.action === 'spriteAdd') {
            applySpriteAdd(msg);
        } else if (msg.action === 'spriteDelete') {
            const target = findTargetByName(msg.target);
            if (target) {
                state.vm.deleteSprite(target.id);
                rebuildTargetIndex();
                overlay.toast(`🗑️ ${msg.fromName} deleted ${msg.target}`, msg.color);
            }
        } else if (msg.action === 'costumeAdd') {
            applyCostumeAdd(msg);
        } else if (msg.action === 'soundAdd') {
            applySoundAdd(msg);
        } else if (msg.action === 'reorderCostume' || msg.action === 'reorderSound') {
            const target = findTargetByName(msg.target);
            const list = target &&
                (msg.action === 'reorderSound' ? target.getSounds() : target.getCostumes());
            const from = list ? resolveIndex(list, msg.from, msg.ident) : -1;
            if (from >= 0) {
                state.vm[msg.action](target.id, from, Math.min(Math.max(msg.to, 0), list.length - 1));
            }
        } else if (msg.action === 'reorderTarget') {
            state.vm.reorderTarget(msg.from, msg.to);
        } else if (msg.action === 'updateSvg' || msg.action === 'updateBitmap') {
            // True co-painting: remote strokes merge in LIVE, even on the same
            // costume — the only deferral left is while the local user is
            // mid-stroke (pointer down), so a reload never eats a drag.
            if (state.pointerDown && state.localTab === 1 && msg.target === editingTargetName()) {
                state.pendingRemotePaint.set(`${msg.target}|${msg.costumeIndex}|${msg.action}`, msg);
                return; // the finally below is what balances the ++

            }
            if (msg.action === 'updateSvg') {
                applyRemoteSvg(msg);
            } else {
                applyRemoteBitmap(msg);
            }
        }
    } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[collab] vm-action failed', e, msg.action);
    } finally {
        state.applyingRemote--;
    }
};

const applyRemoteSvg = incoming => {
    // _updateSvg takes the costume object directly — no editingTarget games.
    const target = findTargetByName(incoming.target);
    // Their index, our list. Painting the costume that happens to sit at that
    // number is how a partner's drawing ends up on somebody else's sprite.
    const index = target ? resolveCostume(target, incoming, incoming.costumeIndex) : -1;
    if (index < 0) return;
    const msg = index === incoming.costumeIndex ?
        incoming : Object.assign({}, incoming, {costumeIndex: index});
    const costume = target.getCostumes()[index];
    if (!costume) return;
    let final = {svg: msg.svg, rotationCenterX: msg.rotationCenterX, rotationCenterY: msg.rotationCenterY};
    if (msg.delta && costume.dataFormat === 'svg' && costume.asset) {
        let current = null;
        try {
            current = new TextDecoder().decode(costume.asset.data);
        } catch (e) { /* fall through to full apply */ }
        // Hash match = we're in sync with the sender's base: their full svg is
        // exact. Mismatch = concurrent edits — replay just their strokes onto
        // OUR costume so both sides' work lands.
        if (current && paintMerge.hashStr(current) !== msg.baseHash) {
            const merged = paintMerge.mergeSvg(
                current, msg.svg, msg.delta,
                costume.rotationCenterX, costume.rotationCenterY
            );
            if (merged) final = merged;
        }
    }
    bumpPaintRev(msg.target, msg.costumeIndex); // reload an open paint editor
    state.vm._updateSvg(costume, final.svg, final.rotationCenterX, final.rotationCenterY);
    state.paintBase.set(`${msg.target}|${msg.costumeIndex}|svg`, final.svg);
    trimPaintBase();
    cachePaint({
        type: 'vm-action',
        action: 'updateSvg',
        target: msg.target,
        costumeIndex: msg.costumeIndex,
        // Kept so the re-apply after a snapshot load resolves the costume the
        // same way this did, on a list the load has very likely renumbered.
        ident: msg.ident,
        svg: final.svg,
        rotationCenterX: final.rotationCenterX,
        rotationCenterY: final.rotationCenterY
    });
};

const commitRemoteBitmap = (incoming, pixels) => {
    // Re-resolve the costume — PNG decode is async and the project may have
    // reloaded (snapshot) between arrival and decode, which moves costumes as
    // readily as a partner's edit does.
    const target = findTargetByName(incoming.target);
    const index = target ? resolveCostume(target, incoming, incoming.costumeIndex) : -1;
    if (index < 0) return;
    const msg = index === incoming.costumeIndex ?
        incoming : Object.assign({}, incoming, {costumeIndex: index});
    const costume = target.getCostumes()[index];
    if (!costume) return;
    // The shadow is the freshest full pixels for this costume: patch base for
    // future merges AND the snapshot-reapply source.
    state.paintBase.set(`${msg.target}|${msg.costumeIndex}|bmp`, {
        pixels, width: msg.width, height: msg.height
    });
    trimPaintBase();
    cachePaint({
        type: 'vm-action',
        action: 'updateBitmap',
        useShadow: true,
        target: msg.target,
        costumeIndex: msg.costumeIndex,
        ident: msg.ident || costumeIdent(msg.target, index),
        width: msg.width,
        height: msg.height,
        sourceWidth: msg.sourceWidth,
        sourceHeight: msg.sourceHeight,
        rotationCenterX: msg.rotationCenterX,
        rotationCenterY: msg.rotationCenterY,
        bitmapResolution: msg.bitmapResolution
    });
    // Copy for the VM — the shadow keeps mutating on future patches.
    const imageData = new ImageData(new Uint8ClampedArray(pixels), msg.width, msg.height);
    imageData.sourceWidth = msg.sourceWidth;
    imageData.sourceHeight = msg.sourceHeight;
    bumpPaintRev(msg.target, msg.costumeIndex); // reload an open paint editor
    state.vm._updateBitmap(
        costume, imageData,
        msg.rotationCenterX, msg.rotationCenterY, msg.bitmapResolution
    );
};

// Current full pixels for a costume: the live shadow, else decoded from the
// costume's stored PNG asset.
const currentBitmapPixels = async msg => {
    const shadow = state.paintBase.get(`${msg.target}|${msg.costumeIndex}|bmp`);
    if (shadow && shadow.width === msg.width && shadow.height === msg.height) return shadow.pixels;
    const target = findTargetByName(msg.target);
    const costume = target && target.getCostumes()[msg.costumeIndex];
    if (!costume || !costume.asset) return null;
    const url = URL.createObjectURL(new Blob([costume.asset.data]));
    try {
        const img = await new Promise((resolve, reject) => {
            const i = new Image();
            i.onload = () => resolve(i);
            i.onerror = reject;
            i.src = url;
        });
        if (img.naturalWidth !== msg.width || img.naturalHeight !== msg.height) return null;
        return imageDataFromImg(img, msg.width, msg.height).data;
    } finally {
        URL.revokeObjectURL(url);
    }
};

const applyBitmapPatch = async msg => {
    const base = await currentBitmapPixels(msg);
    if (!base) return; // dims mismatch (missed a resize) — next full send heals
    const [patchImg, maskImg] = await Promise.all([decodePng(msg.data), decodePng(msg.mask)]);
    const patchData = imageDataFromImg(patchImg, msg.pw, msg.ph);
    const maskData = imageDataFromImg(maskImg, msg.pw, msg.ph);
    const maskAlpha = new Uint8ClampedArray(msg.pw * msg.ph);
    for (let i = 0; i < maskAlpha.length; i++) maskAlpha[i] = maskData.data[(i * 4) + 3];
    paintMerge.compositePatch(base, msg.width, patchData.data, maskAlpha, msg.px, msg.py, msg.pw, msg.ph);
    commitRemoteBitmap(msg, base);
};

const applyRemoteBitmap = incoming => {
    const target = findTargetByName(incoming.target);
    const index = target ? resolveCostume(target, incoming, incoming.costumeIndex) : -1;
    if (index < 0) return;
    // Rewritten once here so every path below — patch, png, raw, and the
    // shadow re-apply after a snapshot — works in OUR numbering.
    const msg = index === incoming.costumeIndex ?
        incoming : Object.assign({}, incoming, {costumeIndex: index});
    if (msg.useShadow) {
        // Snapshot-reapply path: restore from the local shadow.
        const shadow = state.paintBase.get(`${msg.target}|${msg.costumeIndex}|bmp`);
        if (shadow) commitRemoteBitmap(msg, shadow.pixels);
        return;
    }
    if (msg.mode === 'patch') {
        applyBitmapPatch(msg).catch(e => {
            // eslint-disable-next-line no-console
            console.error('[collab] bitmap patch failed', e);
        });
        return;
    }
    if (msg.encoding === 'png') {
        decodePng(msg.data).then(img => {
            commitRemoteBitmap(msg, imageDataFromImg(img, msg.width, msg.height).data);
        }, e => {
            // eslint-disable-next-line no-console
            console.error('[collab] png bitmap decode failed', e);
        });
        return;
    }
    commitRemoteBitmap(msg, new Uint8ClampedArray(bufferFromB64(msg.data)));
};

// -------------------------------------------- multiplayer game bridge ---
// Unsandboxed Together extension talks ONLY to this object. Game traffic
// must not go through editor-sync paths gated by projectRunning — both
// machines simulate independently and exchange game messages while green-flag
// scripts are running.

const netHandlers = {};
// Last-write-wins cache so extensions that bind after welcome still see
// current shared variables (late load of the Together category).
let cachedGameVars = Object.create(null);
// Cached peer-name list — rebuilt only on join/leave, not every reporter tick.
let cachedPeerNames = [];
let cachedPeerNamesStr = '';

const rebuildPeerCache = () => {
    cachedPeerNames = [...overlay.peers.values()].map(p => p.name);
    cachedPeerNamesStr = cachedPeerNames.join(', ');
};

const netEmit = (type, msg) => {
    const list = netHandlers[type];
    if (!list || !list.length) return;
    for (let i = 0; i < list.length; i++) {
        try {
            list[i](msg);
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error('[collab] SquiggleNet handler error', type, e);
        }
    }
};

const installNetBridge = () => {
    if (typeof window === 'undefined') return;
    if (window.SquiggleNet && window.SquiggleNet.__st) return;
    window.SquiggleNet = {
        __st: true,
        send (msg) {
            if (!state.active) return;
            // Mirror outbound shared-var writes into the local cache immediately
            // so reporters work before the (non-echoed) round-trip.
            if (msg && msg.type === 'game' && msg.action === 'var') {
                const key = String(msg.name == null ? '' : msg.name);
                if (key) cachedGameVars[key] = msg.value == null ? '' : msg.value;
            }
            client.send(msg);
        },
        on (type, cb) {
            if (typeof cb !== 'function') return () => {};
            (netHandlers[type] = netHandlers[type] || []).push(cb);
            // Replay cached shared vars to late subscribers.
            if (type === 'game-state') {
                queueMicrotask(() => {
                    try {
                        cb({vars: cachedGameVars});
                    } catch (e) { /* subscriber error */ }
                });
            }
            return () => {
                const list = netHandlers[type];
                if (!list) return;
                const i = list.indexOf(cb);
                if (i >= 0) list.splice(i, 1);
            };
        },
        get playerName () {
            return (client.session && client.session.name) || '';
        },
        get peers () {
            return cachedPeerNames;
        },
        get peersText () {
            return cachedPeerNamesStr;
        },
        get connected () {
            return !!(state.active && client.connected);
        },
        get room () {
            return (overlay.self && overlay.self.room) ||
                (client.session && client.session.room) || '';
        },
        get sharedVars () {
            return cachedGameVars;
        }
    };
    // Kept from the pre-rename build so any project or extension that bound to
    // the old global keeps working.
    window.ScratchTogetherNet = window.SquiggleNet;
    try {
        window.dispatchEvent(new CustomEvent('SquiggleNetReady'));
        window.dispatchEvent(new CustomEvent('ScratchTogetherNetReady'));
    } catch (e) { /* old browsers */ }
};

// Available before login so the Together extension can bind immediately.
installNetBridge();

// ------------------------------------------------------------- wiring up ---

const wireSocket = () => {
    client.on('welcome', msg => {
        const isReconnect = state.everConnected;
        state.everConnected = true;
        state.active = true;
        startHousekeeping();
        overlay.setConnected(true);
        state.selfId = msg.id;
        state.role = msg.role || 'editor';
        state.canEdit = msg.canEdit !== false;
        overlay.setSelf(msg.me ? msg.me.displayName : client.session.name, msg.color, msg.room, {
            handle: msg.me && msg.me.handle,
            isChild: !!(msg.me && msg.me.isChild),
            cursor: msg.cursor,
            role: state.role,
            canEdit: state.canEdit,
            title: msg.title,
            visibility: msg.visibility
        });
        overlay.setPeers(msg.peers, msg.id);
        overlay.setProjects(msg.projects);
        applyRoomTitle(msg.title || msg.room);
        /*
         * First welcome records the build this tab is running against; every
         * later one compares. Reconnecting into a server that has been deployed
         * since is exactly when a tab starts running stale code, and it is the
         * one moment we can reliably notice.
         */
        if (msg.buildId) {
            if (!state.buildId) {
                state.buildId = msg.buildId;
            } else if (msg.buildId === state.buildId) {
                overlay.banner(null); // reconnected to the same build — all clear
            } else {
                overlay.banner('A new version of Squiggle is ready.', {
                    kind: 'update',
                    actionLabel: 'Reload',
                    onAction: () => window.location.reload()
                });
            }
        }
        overlay.toast(
            isReconnect ? '🔌 Reconnected!' : `Welcome, ${overlay.self.name}! Room: ${msg.title || msg.room}`,
            msg.color
        );
        applyEditability();
        if (!state.canEdit) overlay.toast('👀 You are watching — ask the owner for edit access', '#8a8fa3');
        rebuildTargetIndex();
        state.roomVersion = typeof msg.version === 'number' ? msg.version : 0;
        // First one in an empty room seeds it with the current project.
        if (!msg.hasSnapshot && msg.peers.length <= 1) {
            sendSnapshotNow();
        } else if (isReconnect && state.offlineEdits && msg.peers.length <= 1) {
            // We kept editing through a connection blip and nobody else is in
            // the room — push our newer state instead of letting the server's
            // stale snapshot revert it. (With others online, theirs wins.)
            state.skipNextSnapshot = true;
            state.forceNextSnapshot = true; // deliberate override of the version gate
            sendSnapshotNow();
        } else if (isReconnect && state.offlineEdits) {
            // Others were in the room while we were away, so their state wins
            // and the snapshot on its way will replace what we did offline.
            // It gets copied into our library first rather than dropped.
            state.rescueOnNextSnapshot = true;
        }
        state.offlineEdits = false;
        state.lastPresence = {status: null, sprite: null, sentAt: 0};
        client.send({type: 'presence', sprite: editingTargetName(), status: 'here'});
        // Seed Together shared variables for late joiners / reconnects.
        cachedGameVars = Object.assign(Object.create(null), msg.gameVars || {});
        rebuildPeerCache();
        netEmit('game-state', {vars: cachedGameVars});
    });
    client.on('disconnected', () => {
        overlay.setConnected(false);
        // Keep housekeeping running — reconnect is expected; stop only on solo exit.
        netEmit('disconnected', {});
    });
    /*
     * A deploy landed while this tab was open. The page keeps working against
     * the old code — nothing is taken away mid-sentence — but the banner stays
     * up until it is reloaded, because an old editor talking to a new server is
     * where unreproducible bugs come from.
     */
    client.on('server-restarting', () => {
        overlay.banner('Squiggle is updating — saving your work…', {kind: 'busy'});
        // Don't wait for the debounce; the server is holding the door for this.
        sendSnapshotNow();
    });
    client.on('peer-updated', msg => {
        overlay.updatePeerAppearance(msg.id, {color: msg.color, style: msg.cursor});
        if (msg.id === state.selfId && overlay.self) {
            overlay.setSelf(overlay.self.name, msg.color, overlay.self.room,
                Object.assign({}, overlay.self, {cursor: msg.cursor}));
        }
        rebuildPeerCache();
    });
    client.on('room-renamed', msg => {
        applyRoomTitle(msg.title);
    });
    /*
     * Every refusal the server sends has to arrive somewhere a person can see
     * it. This handler used to know three of them and drop the rest on the
     * floor — including `read-only`, which is sent for every edit a viewer
     * makes, and `bad-snapshot`, which means the project is no longer being
     * saved at all. Both of those end in lost work, and both were silent.
     */
    client.on('error', msg => {
        if (msg.error === 'session-replaced') {
            client.disconnect();
            endSession();
            overlay.toast('👀 Opened in another tab — disconnected here', '#ff8c00');
        } else if (msg.error === 'room-full') {
            client.disconnect();
            endSession();
            overlay.toast('🚫 Room is full', '#e8386d');
        } else if (msg.error === 'no-access') {
            client.disconnect();
            endSession();
            overlay.toast('🔒 Access denied', '#e8386d');
        } else if (msg.error === 'read-only') {
            // The gate below should mean this never fires. If it does, the
            // editor believes it may write and the server disagrees — so
            // believe the server, and stop pretending the edits are landing.
            if (state.canEdit) {
                state.canEdit = false;
                applyEditability();
            }
        } else if (msg.error === 'bad-snapshot') {
            // Almost always the size cap. Nothing this tab does will save
            // until the project gets smaller, so this stays on screen.
            overlay.banner(
                'This project is too big to save. Delete a few costumes or sounds to fix it.',
                {kind: 'update'}
            );
        } else if (msg.error) {
            overlay.toast(`⚠️ ${msg.error.replace(/-/g, ' ')}`, '#e8386d');
        }
    });
    client.on('queue-overflow', () => {
        // Reliable messages had to be dropped while the socket was down, so
        // our copy and the room's have diverged in a way neither side can
        // reconstruct. Treat it exactly like editing offline: on reconnect the
        // project is either pushed (nobody else there) or rescued into the
        // library before theirs is accepted. Both keep the work.
        client.droppedReliable = false;
        state.offlineEdits = true;
        state.forceNextSnapshot = true;
    });
    client.on('kicked', msg => {
        client.disconnect();
        endSession();
        overlay.toast(msg.reason === 'room-deleted' ?
            '🚪 This room was deleted' : '🔒 Your access to this room changed', '#e8386d');
    });
    client.on('peer-joined', msg => {
        overlay.addPeer(msg.peer.id, msg.peer.name, msg.peer.color, msg.peer.cursor);
        rebuildPeerCache();
        overlay.toast(`👋 ${msg.peer.name} joined!`, msg.peer.color);
        // Re-announce so the newcomer immediately sees our sprite/status.
        client.send({
            type: 'presence',
            sprite: state.lastPresence.sprite || editingTargetName(),
            status: state.lastPresence.status || 'here'
        });
        netEmit('peer-joined', msg);
    });
    client.on('peer-left', msg => {
        overlay.removePeer(msg.id);
        rebuildPeerCache();
        overlay.toast(`${msg.name} left`, '#8a8fa3');
        netEmit('peer-left', msg);
    });
    client.on('snapshot', applySnapshot);
    client.on('snapshot-ack', msg => {
        if (typeof msg.version === 'number') state.roomVersion = msg.version;
    });
    client.on('projects', msg => overlay.setProjects(msg.projects));
    client.on('project-saved', msg => {
        overlay.setProjects(msg.projects);
        overlay.toast(`💾 ${msg.owner} saved "${msg.name}"`, '#4caf50');
    });
    client.on('request-snapshot', sendSnapshotNow);
    client.on('block-event', applyBlockEvent);
    client.on('sprite-info', applySpriteInfo);
    client.on('vm-action', applyVmAction);
    client.on('presence', msg => overlay.setPeerPresence(msg.from, msg));
    client.on('cursor', msg => overlay.setPeerCursor(
        msg.from,
        msg.hide ? null : {space: msg.space, x: msg.x, y: msg.y, sprite: msg.sprite}
    ));
    // Together extension traffic — never gated by projectRunning.
    client.on('game', msg => {
        if (msg && msg.action === 'var') {
            const key = String(msg.name == null ? '' : msg.name);
            if (key) cachedGameVars[key] = msg.value == null ? '' : msg.value;
        }
        netEmit('game', msg);
    });
};

// ------------------------------------------------------------- public API ---

const init = async (vm, initHooks) => {
    hooks = initHooks || {};
    if (state.initialized) return;
    state.initialized = true;
    state.vm = vm;
    installNetBridge(); // idempotent — already installed at module load
    installInterpolation(vm); // room or not — it is the same editor

    // Register before the login modal so we can't miss the event while the user types.
    const projectLoaded = new Promise(resolve => vm.runtime.once('PROJECT_LOADED', resolve));

    const login = await showLogin();
    if (!login) return; // solo mode

    // Don't connect until the local (default) project has finished loading —
    // otherwise its load could land after the room snapshot and clobber it.
    if (vm.runtime.targets.length === 0) {
        await Promise.race([projectLoaded, new Promise(r => setTimeout(r, 15000))]);
    }

    overlay.mount();
    overlay.getWorkspace = () => state.workspace;
    overlay.localSpriteName = editingTargetName;

    wrapVm(vm);
    wireSocket();
    client.connect(login);
};

const attachWorkspace = (workspace, ScratchBlocks) => {
    state.workspace = workspace;
    state.ScratchBlocks = ScratchBlocks;
    workspace.addChangeListener(onWorkspaceEvent);
    const svg = workspace.getParentSvg();
    if (svg) svg.addEventListener('mousemove', onWorkspaceMouseMove);
    // A workspace can be built after the welcome that decided we are a viewer.
    applyEditability();
};

/*
 * blocks.jsx rebuilds the whole workspace from VM state on workspaceUpdate
 * (sprite switch, project load). Those synthetic create/delete events must not
 * be rebroadcast. Blockly fires listeners from a setTimeout(0) queue, so the
 * resume must be deferred past the queue drain (which was scheduled first).
 *
 * Counted, for the reason applyingRemote is counted. Two rebuilds can be in
 * flight at once — a socket message landing between one rebuild's drain and
 * its resume is enough — and with a boolean the first resume clears the
 * suspension while the second rebuild's synthetic events are still queued.
 * Those events then read as this user's own edits and go out to the room:
 * the echo loop, by another door.
 */
const suspendWorkspaceEvents = () => {
    state.workspaceSuspended++;
};
const resumeWorkspaceEvents = () => {
    setTimeout(() => {
        if (state.workspaceSuspended > 0) state.workspaceSuspended--;
    }, 0);
};

const detachWorkspace = () => {
    if (state.workspace) {
        try {
            state.workspace.removeChangeListener(onWorkspaceEvent);
            const svg = state.workspace.getParentSvg();
            if (svg) svg.removeEventListener('mousemove', onWorkspaceMouseMove);
        } catch (e) { /* already disposed */ }
    }
    state.workspace = null;
    state.ScratchBlocks = null;
};

// Appearance changes go over the socket so peers repaint immediately; the
// server persists them to the account.
const setAppearance = ({color, style}) => {
    if (!state.active) return false;
    client.send({type: 'appearance', color, cursor: style});
    return true;
};

const applyRoomTitle = title => {
    const clean = String(title || '').slice(0, 60);
    if (!clean || clean === state.appliedTitle) return;
    state.appliedTitle = clean;
    if (hooks.setProjectTitle) hooks.setProjectTitle(clean);
    // The presence panel shows the title too, so keep it in step.
    if (overlay.self) {
        overlay.setSelf(overlay.self.name, overlay.self.color, overlay.self.room,
            Object.assign({}, overlay.self, {title: clean}));
    }
};

// Renaming the project renames the room. Owner-gated on the server.
const setRoomTitle = title => {
    const clean = String(title || '')
        .trim()
        .slice(0, 60);
    if (!state.active || !clean || clean === state.appliedTitle) return;
    state.appliedTitle = clean;
    client.send({type: 'set-room-title', title: clean});
};

export default {
    init,
    attachWorkspace,
    detachWorkspace,
    suspendWorkspaceEvents,
    resumeWorkspaceEvents,
    paintRev,
    setAppearance,
    setRoomTitle,
    // Which room this tab is in, for anything that needs to ask the server
    // about it — the history panel is the first.
    get roomName () {
        return (overlay.self && overlay.self.room) ||
            (client.session && client.session.room) || '';
    }
};
