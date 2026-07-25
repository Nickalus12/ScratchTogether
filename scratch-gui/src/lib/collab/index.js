/* ScratchTogether sync engine.
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

import client from './client';
import showLogin from './login';
import overlay from './overlay';

const state = {
    vm: null,
    workspace: null,
    ScratchBlocks: null,
    active: false,
    applyingRemote: false,
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
    skipNextSnapshot: false // drop the stale room snapshot after an offline-edit rejoin
};

// Presence/cursor traffic is pointless with nobody in the room.
const hasPeers = () => overlay.peers.size > 0;

// Send presence only when it actually changed (or as a 3s keepalive refresh).
const sendPresence = fields => {
    if (!state.active) return;
    const now = Date.now();
    const next = {
        status: fields.status !== undefined ? fields.status : state.lastPresence.status,
        sprite: fields.sprite !== undefined ? fields.sprite : state.lastPresence.sprite
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
    let t = state.targetByName.get(name);
    if (t && t.blocks) return t;
    // Stale after rename/add — rebuild once.
    rebuildTargetIndex();
    return state.targetByName.get(name) || null;
};

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
        const out = await state.vm.saveProjectSb3();
        // Drop if we went inactive / started applying remote mid-zip.
        if (!state.active || state.applyingRemote) return;
        const b64 = typeof out.arrayBuffer === 'function' ?
            await blobToB64(out) :
            b64FromBuffer(out);
        if (b64 === state.lastSnapshotB64) return; // nothing actually changed
        state.lastSnapshotB64 = b64;
        client.send({type: 'snapshot', b64, cacheOnly: cacheOnly === true});
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

const scheduleSnapshot = cacheOnly => {
    if (!state.active || state.applyingRemote) return;
    if (!client.connected) state.offlineEdits = true;
    // A pending relay snapshot must not be downgraded by a later cacheOnly request.
    state.pendingSnapshotCacheOnly = state.snapshotTimer ?
        (state.pendingSnapshotCacheOnly && cacheOnly === true) :
        cacheOnly === true;
    clearTimeout(state.snapshotTimer);
    // cacheOnly snapshots only refresh the server's copy for late joiners — the
    // live edits already reached everyone. Zipping the whole project is the
    // expensive part (multi-MB in game rooms), so do it rarely and when idle.
    const wait = state.pendingSnapshotCacheOnly ?
        Math.max(1500, 20000 - (Date.now() - (state.lastCacheSnapAt || 0))) :
        1000;
    state.snapshotTimer = setTimeout(() => {
        state.snapshotTimer = null;
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
    }, wait);
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
}

const applySnapshot = async msg => {
    if (!state.vm || !msg || !msg.b64) return;
    // Reconnect with edits made while offline and nobody else in the room:
    // our local copy is the newest truth — the welcome handler already pushed
    // it, so drop the stale room snapshot instead of reverting the user's work.
    if (state.skipNextSnapshot) {
        state.skipNextSnapshot = false;
        return;
    }
    // Reconnects re-deliver the room snapshot — if it's the state we already
    // have (usually our own), don't reload the project out from under us.
    if (msg.b64 === state.lastSnapshotB64) return;
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
    state.applyingRemote = true;
    state.snapshotLoading = true;
    try {
        await state.vm.loadProject(bufferFromB64(msg.b64));
        // Only mark applied after a successful load — failed loads must retry.
        state.lastSnapshotB64 = msg.b64;
        rebuildTargetIndex();
        const restored = findTargetByName(keepTarget);
        if (restored) state.vm.setEditingTarget(restored.id);
        if (msg.author && msg.author !== 'server') {
            overlay.toast(`🔄 Project synced from ${msg.author}`, msg.color);
        }
    } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[collab] failed to apply snapshot', e);
    } finally {
        state.snapshotLoading = false;
        state.applyingRemote = false;
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

// Any of these mutating the project means assets/structure changed -> resync all.
const SNAPSHOT_METHODS = [
    'addSprite', 'deleteSprite', 'duplicateSprite',
    'addCostume', 'addCostumeFromLibrary', 'deleteCostume', 'duplicateCostume',
    'addSound', 'deleteSound', 'duplicateSound',
    'updateSoundBuffer', 'addBackdrop',
    'shareBlocksToTarget', 'shareCostumeToTarget', 'shareSoundToTarget'
];
// NOT here: updateSvg/updateBitmap (paint syncs live) and renames/reorders
// (targeted messages below) — a full zip + reload for a rename was the main
// source of editor stutter.

// Light operations relay as tiny targeted messages instead of snapshots.
// buildMsg runs BEFORE the mutation so it can capture pre-change names.
const wrapTargeted = (vm, method, buildMsg) => {
    if (typeof vm[method] !== 'function') return;
    const original = vm[method].bind(vm);
    vm[method] = (...args) => {
        const msg = (state.active && !state.applyingRemote) ? buildMsg(...args) : null;
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
            const result = original(...args);
            Promise.resolve(result).then(scheduleSnapshot, () => {});
            return result;
        };
    }

    // User opening a local .sb3 should push it to the room too.
    const originalLoad = vm.loadProject.bind(vm);
    vm.loadProject = (...args) => {
        const result = originalLoad(...args);
        if (!state.applyingRemote) {
            Promise.resolve(result).then(scheduleSnapshot, () => {});
        }
        return result;
    };

    const originalGreenFlag = vm.greenFlag.bind(vm);
    vm.greenFlag = (...args) => {
        if (state.active && !state.applyingRemote) {
            client.send({type: 'vm-action', action: 'greenFlag'});
            sendPresence({status: '▶ playing'});
        }
        return originalGreenFlag(...args);
    };

    const originalStopAll = vm.stopAll.bind(vm);
    vm.stopAll = (...args) => {
        if (state.active && !state.applyingRemote) {
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
        const result = originalPostSpriteInfo(data);
        // While the project is RUNNING each machine simulates independently —
        // syncing positions mid-game makes the simulations fight (rubber-band
        // "lag"). Positions converge naturally when play stops.
        if (state.active && !state.applyingRemote && !state.projectRunning && hasPeers()) {
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

    const targetNameById = id => {
        const t = vm.runtime.getTargetById(id);
        return t ? t.getName() : null;
    };
    wrapTargeted(vm, 'renameSprite', (targetId, newName) => {
        const target = targetNameById(targetId);
        return target ? {target, newName} : null;
    });
    wrapTargeted(vm, 'renameCostume', (index, newName) =>
        ({target: editingTargetName(), index, newName}));
    wrapTargeted(vm, 'renameSound', (index, newName) =>
        ({target: editingTargetName(), index, newName}));
    wrapTargeted(vm, 'reorderCostume', (targetId, from, to) => {
        const target = targetNameById(targetId);
        return target ? {target, from, to} : null;
    });
    wrapTargeted(vm, 'reorderSound', (targetId, from, to) => {
        const target = targetNameById(targetId);
        return target ? {target, from, to} : null;
    });
    wrapTargeted(vm, 'reorderTarget', (from, to) => ({from, to}));

    // Live paint sync — vector strokes relay per edit-commit; bitmap edits are
    // heavier (raw pixels) so they relay with a trailing debounce. Both also
    // refresh the server's cached .sb3 (cacheOnly) for late joiners.
    const originalUpdateSvg = vm.updateSvg.bind(vm);
    vm.updateSvg = (costumeIndex, svg, rotationCenterX, rotationCenterY) => {
        const result = originalUpdateSvg(costumeIndex, svg, rotationCenterX, rotationCenterY);
        if (state.active && !state.applyingRemote) {
            const target = editingTargetName();
            if (target && hasPeers()) {
                client.send({
                    type: 'vm-action',
                    action: 'updateSvg',
                    target,
                    costumeIndex,
                    svg,
                    rotationCenterX,
                    rotationCenterY
                });
                sendPresence({status: '🎨 painting', sprite: target});
            }
            scheduleSnapshot(true);
        }
        return result;
    };

    const originalUpdateBitmap = vm.updateBitmap.bind(vm);
    vm.updateBitmap = (costumeIndex, bitmap, rotationCenterX, rotationCenterY, bitmapResolution) => {
        const result = originalUpdateBitmap(costumeIndex, bitmap, rotationCenterX, rotationCenterY, bitmapResolution);
        if (state.active && !state.applyingRemote) {
            const target = editingTargetName();
            if (target && hasPeers()) {
                // Copy the pixel view only — bitmap.data.buffer may be a larger
                // ArrayBuffer shared with other views (byteOffset !== 0).
                const pixels = bitmap.data;
                const pixelCopy = pixels.buffer.slice(
                    pixels.byteOffset,
                    pixels.byteOffset + pixels.byteLength
                );
                state.pendingBitmap = {
                    type: 'vm-action',
                    action: 'updateBitmap',
                    target,
                    costumeIndex,
                    width: bitmap.width,
                    height: bitmap.height,
                    sourceWidth: bitmap.sourceWidth,
                    sourceHeight: bitmap.sourceHeight,
                    data: b64FromBuffer(pixelCopy),
                    rotationCenterX,
                    rotationCenterY,
                    bitmapResolution
                };
                clearTimeout(state.bitmapTimer);
                state.bitmapTimer = setTimeout(() => {
                    if (state.pendingBitmap) client.send(state.pendingBitmap);
                    state.pendingBitmap = null;
                }, 250);
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

    // Frame interpolation: render at the display's refresh rate while game
    // logic keeps its designed tick (30fps for most Scratch games) — smooth
    // motion without changing gameplay speed. Loading a project can reset
    // runtime options, so re-assert on every load.
    vm.runtime.on('PROJECT_LOADED', () => {
        rebuildTargetIndex();
        try {
            vm.setInterpolation(true);
        } catch (e) { /* older vm */ }
    });
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
    if (!state.active || state.applyingRemote || state.workspaceSuspended) return;
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
        return;
    }
    if (state.pendingBlockMoves.size) flushBlockMoves();
    client.send({type: 'block-event', target, event: json});
    sendPresence({status: '✏️ coding', sprite: target});
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

const housekeep = () => {
    if (!state.active) return;

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
    if (state.orphanBlockEvents.length) {
        const cutoff = Date.now() - 8000;
        state.orphanBlockEvents = state.orphanBlockEvents.filter(m => (m._queuedAt || 0) > cutoff);
    }

    if (!state.cursorShown) return;
    let workspaceVisible = false;
    try {
        if (state.workspace && !document.hidden) {
            const rect = state.workspace.getParentSvg().getBoundingClientRect();
            workspaceVisible = rect.width > 10 && rect.height > 10;
        }
    } catch (e) { /* mid-teardown */ }
    if (!workspaceVisible) {
        state.cursorShown = false;
        if (hasPeers()) client.send({type: 'cursor', hide: true});
    }
};

const startHousekeeping = () => {
    if (state.housekeepTimer) return;
    state.housekeepTimer = setInterval(housekeep, 1000);
};

const stopHousekeeping = () => {
    if (state.housekeepTimer) {
        clearInterval(state.housekeepTimer);
        state.housekeepTimer = null;
    }
};

// ------------------------------------------------- incoming: application ---

const applyBlockEvent = msg => {
    if (state.snapshotLoading) {
        // Don't apply into a half-loaded project — replay after the load.
        if (state.queuedBlockEvents.length < 500) state.queuedBlockEvents.push(msg);
        return;
    }
    const target = findTargetByName(msg.target);
    if (!target) {
        // Sprite not here yet (snapshot in flight / rename race) — hold briefly.
        if (state.orphanBlockEvents.length < 200) {
            msg._queuedAt = Date.now();
            state.orphanBlockEvents.push(msg);
        }
        return;
    }
    const vmEvent = jsonToVmEvent(msg.event);
    if (!vmEvent) return;

    state.applyingRemote = true;
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
        state.applyingRemote = false;
    }
};

const applySpriteInfo = msg => {
    if (state.projectRunning) return; // don't fight the running simulation
    const target = findTargetByName(msg.target);
    if (!target) return;
    const d = msg.data || {};
    state.applyingRemote = true;
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
    state.applyingRemote = false;
};

const applyVmAction = msg => {
    state.applyingRemote = true;
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
        } else if (msg.action === 'renameCostume' || msg.action === 'renameSound') {
            // these operate on vm.editingTarget — impersonate briefly
            const target = findTargetByName(msg.target);
            if (target) {
                const prev = state.vm.editingTarget;
                state.vm.editingTarget = target;
                try {
                    state.vm[msg.action](msg.index, msg.newName);
                } finally {
                    state.vm.editingTarget = prev;
                }
            }
        } else if (msg.action === 'reorderCostume' || msg.action === 'reorderSound') {
            const target = findTargetByName(msg.target);
            if (target) state.vm[msg.action](target.id, msg.from, msg.to);
        } else if (msg.action === 'reorderTarget') {
            state.vm.reorderTarget(msg.from, msg.to);
        } else if (msg.action === 'updateSvg' || msg.action === 'updateBitmap') {
            // Never stomp an open paint editor: applying a remote edit to the
            // sprite the local user is painting resets scratch-paint's working
            // state (selection, color picker). Defer until they leave the tab.
            if (state.localTab === 1 && msg.target === editingTargetName()) {
                state.pendingRemotePaint.set(`${msg.target}|${msg.costumeIndex}|${msg.action}`, msg);
                state.applyingRemote = false;
                return;
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
        state.applyingRemote = false;
    }
};

const applyRemoteSvg = msg => {
    // _updateSvg takes the costume object directly — no editingTarget games.
    const target = findTargetByName(msg.target);
    const costume = target && target.getCostumes()[msg.costumeIndex];
    if (costume) {
        state.vm._updateSvg(costume, msg.svg, msg.rotationCenterX, msg.rotationCenterY);
    }
};

const applyRemoteBitmap = msg => {
    const target = findTargetByName(msg.target);
    const costume = target && target.getCostumes()[msg.costumeIndex];
    if (costume) {
        const bytes = new Uint8ClampedArray(bufferFromB64(msg.data));
        const imageData = new ImageData(bytes, msg.width, msg.height);
        imageData.sourceWidth = msg.sourceWidth;
        imageData.sourceHeight = msg.sourceHeight;
        state.vm._updateBitmap(
            costume, imageData,
            msg.rotationCenterX, msg.rotationCenterY, msg.bitmapResolution
        );
    }
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
            console.error('[collab] ScratchTogetherNet handler error', type, e);
        }
    }
};

const installNetBridge = () => {
    if (typeof window === 'undefined') return;
    if (window.ScratchTogetherNet && window.ScratchTogetherNet.__st) return;
    window.ScratchTogetherNet = {
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
    try {
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
        overlay.setSelf(client.session.name, msg.color, msg.room);
        overlay.setPeers(msg.peers, msg.id);
        overlay.setProjects(msg.projects);
        overlay.toast(
            isReconnect ? '🔌 Reconnected!' : `Welcome, ${client.session.name}! Room: ${msg.room}`,
            msg.color
        );
        rebuildTargetIndex();
        // First one in an empty room seeds it with the current project.
        if (!msg.hasSnapshot && msg.peers.length <= 1) {
            sendSnapshotNow();
        } else if (isReconnect && state.offlineEdits && msg.peers.length <= 1) {
            // We kept editing through a connection blip and nobody else is in
            // the room — push our newer state instead of letting the server's
            // stale snapshot revert it. (With others online, theirs wins.)
            state.skipNextSnapshot = true;
            sendSnapshotNow();
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
    client.on('peer-joined', msg => {
        overlay.addPeer(msg.peer.id, msg.peer.name, msg.peer.color);
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
        msg.hide ? null : {x: msg.x, y: msg.y, sprite: msg.sprite}
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

const init = async vm => {
    if (state.initialized) return;
    state.initialized = true;
    state.vm = vm;
    installNetBridge(); // idempotent — already installed at module load

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
};

// blocks.jsx rebuilds the whole workspace from VM state on workspaceUpdate
// (sprite switch, project load). Those synthetic create/delete events must not
// be rebroadcast. Blockly fires listeners from a setTimeout(0) queue, so the
// resume must be deferred past the queue drain (which was scheduled first).
const suspendWorkspaceEvents = () => {
    state.workspaceSuspended = true;
};
const resumeWorkspaceEvents = () => {
    setTimeout(() => {
        state.workspaceSuspended = false;
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

export default {init, attachWorkspace, detachWorkspace, suspendWorkspaceEvents, resumeWorkspaceEvents};
