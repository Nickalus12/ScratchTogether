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
    lastCursorSent: 0,
    lastSpriteInfoSent: 0,
    pendingSpriteInfo: null, // trailing sprite-info so the final drag position always lands
    spriteInfoTimer: null,
    lastPresence: {status: null, sprite: null, sentAt: 0},
    lastSnapshotB64: null, // dedup — skip re-broadcasting identical project state
    localTab: 0, // 0 code / 1 costumes / 2 sounds
    pendingRemotePaint: new Map(), // deferred remote paint edits while locally painting
    initialized: false
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

const bufferFromB64 = b64 => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
};

const editingTargetName = () => {
    const t = state.vm && state.vm.editingTarget;
    return t ? t.getName() : null;
};

const findTargetByName = name => {
    if (!state.vm || !name) return null;
    return state.vm.runtime.targets.find(t => t.isOriginal && t.getName() === name) || null;
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
    try {
        if (cacheOnly === true) state.lastCacheSnapAt = Date.now();
        const out = await state.vm.saveProjectSb3();
        const b64 = typeof out.arrayBuffer === 'function' ?
            await blobToB64(out) :
            b64FromBuffer(out);
        if (b64 === state.lastSnapshotB64) return; // nothing actually changed
        state.lastSnapshotB64 = b64;
        client.send({type: 'snapshot', b64, cacheOnly: cacheOnly === true});
    } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[collab] snapshot failed', e);
    }
};

const scheduleSnapshot = cacheOnly => {
    if (!state.active || state.applyingRemote) return;
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
        if (flag && typeof window.requestIdleCallback === 'function') {
            window.requestIdleCallback(() => sendSnapshotNow(true), {timeout: 8000});
        } else {
            sendSnapshotNow(flag);
        }
    }, wait);
};

const applySnapshot = async msg => {
    if (!state.vm) return;
    const keepTarget = editingTargetName();
    state.applyingRemote = true;
    try {
        state.lastSnapshotB64 = msg.b64;
        await state.vm.loadProject(bufferFromB64(msg.b64));
        const restored = findTargetByName(keepTarget);
        if (restored) state.vm.setEditingTarget(restored.id);
        if (msg.author && msg.author !== 'server') {
            overlay.toast(`🔄 Project synced from ${msg.author}`, msg.color);
        }
    } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[collab] failed to apply snapshot', e);
    } finally {
        state.applyingRemote = false;
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
                state.pendingBitmap = {
                    type: 'vm-action',
                    action: 'updateBitmap',
                    target,
                    costumeIndex,
                    width: bitmap.width,
                    height: bitmap.height,
                    sourceWidth: bitmap.sourceWidth,
                    sourceHeight: bitmap.sourceHeight,
                    data: b64FromBuffer(bitmap.data.buffer),
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
        try {
            vm.setInterpolation(true);
        } catch (e) { /* older vm */ }
    });
};

// ------------------------------------------------ outgoing: block events ---

const onWorkspaceEvent = e => {
    if (!state.active || state.applyingRemote || state.workspaceSuspended) return;
    if (e.type === 'ui') {
        return;
    }
    if (!RELAYED_BLOCK_EVENTS.has(e.type)) return;
    const target = editingTargetName();
    if (!target) return;
    let json;
    try {
        json = e.toJson();
    } catch (err) {
        return;
    }
    client.send({type: 'block-event', target, event: json});
    sendPresence({status: '✏️ coding', sprite: target});
};

const onWorkspaceMouseMove = evt => {
    if (!state.active || !state.workspace || !hasPeers()) return;
    const now = Date.now();
    if (now - state.lastCursorSent < 40) return;
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
const currentTabIndex = () => {
    const tabs = [...document.querySelectorAll('ul[role="tablist"] li[role="tab"]')].slice(0, 3);
    const idx = tabs.findIndex(t => t.getAttribute('aria-selected') === 'true');
    return idx === -1 ? 0 : idx;
};

const TAB_STATUS = ['here', '🎨 painting', '🎵 sounds'];

// Remote paint edits for the costume the local user is actively painting are
// deferred — applying them mid-edit resets scratch-paint's working state
// (color picker included). They flush as soon as the tab changes.
const flushPendingPaint = () => {
    const queued = [...state.pendingRemotePaint.values()];
    state.pendingRemotePaint.clear();
    queued.forEach(msg => applyVmAction(msg));
};

// 1s housekeeping: cursor-hide when our blocks view disappears, and tab
// presence so peers see "🎨 painting" the moment someone opens that editor.
setInterval(() => {
    if (!state.active) return;

    const tab = currentTabIndex();
    if (tab !== state.localTab) {
        const wasPainting = state.localTab === 1;
        state.localTab = tab;
        sendPresence({status: TAB_STATUS[tab] || 'here', sprite: editingTargetName()});
        if (wasPainting) flushPendingPaint();
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
}, 1000);

// ------------------------------------------------- incoming: application ---

const applyBlockEvent = msg => {
    const target = findTargetByName(msg.target);
    if (!target) {
        // We don't know this sprite yet — a snapshot is likely in flight; skip.
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
                // Workspace drifted from VM (rare) — reload it from the VM.
                state.vm.refreshWorkspace();
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
            if (target) state.vm.renameSprite(target.id, msg.newName);
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

// ------------------------------------------------------------- wiring up ---

const wireSocket = () => {
    client.on('welcome', msg => {
        state.active = true;
        overlay.setConnected(true);
        overlay.setSelf(client.session.name, msg.color, msg.room);
        overlay.setPeers(msg.peers, msg.id);
        overlay.setProjects(msg.projects);
        overlay.toast(`Welcome, ${client.session.name}! Room: ${msg.room}`, msg.color);
        // First one in an empty room seeds it with the current project.
        if (!msg.hasSnapshot && msg.peers.length <= 1) {
            sendSnapshotNow();
        }
        state.lastPresence = {status: null, sprite: null, sentAt: 0};
        client.send({type: 'presence', sprite: editingTargetName(), status: 'here'});
    });
    client.on('disconnected', () => overlay.setConnected(false));
    client.on('peer-joined', msg => {
        overlay.addPeer(msg.peer.id, msg.peer.name, msg.peer.color);
        overlay.toast(`👋 ${msg.peer.name} joined!`, msg.peer.color);
        // Re-announce so the newcomer immediately sees our sprite/status.
        client.send({
            type: 'presence',
            sprite: state.lastPresence.sprite || editingTargetName(),
            status: state.lastPresence.status || 'here'
        });
    });
    client.on('peer-left', msg => {
        overlay.removePeer(msg.id);
        overlay.toast(`${msg.name} left`, '#8a8fa3');
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
};

// ------------------------------------------------------------- public API ---

const init = async vm => {
    if (state.initialized) return;
    state.initialized = true;
    state.vm = vm;

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
