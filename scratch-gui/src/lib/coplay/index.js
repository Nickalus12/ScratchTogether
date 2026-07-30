/* Playing together on a project that was never built for it.
 *
 * Activated by ?coplay=<CODE> on the embed player. Everyone loads the same
 * project; one person (the DRIVER) has the controller. Their keyboard and
 * mouse are forwarded to every other VM, so one set of hands plays the game
 * everywhere at once.
 *
 * Forwarded input alone is not enough. Two copies of a Scratch project drift
 * apart the moment anything uses a random number, a timer, or the order clones
 * happen to be created in — and once they drift, a watcher is playing a
 * different game that merely looks similar. So the driver also broadcasts the
 * world, and everyone else reconciles against it.
 *
 * The three things that make it feel immediate rather than merely correct:
 *
 *   1. Input is never batched. A keypress is one small frame, sent the
 *      instant it happens, and the server relays without touching it.
 *   2. The world sync is a DELTA. Ten times a second, only what actually
 *      changed goes out, with a full keyframe every two seconds so a watcher
 *      who missed something recovers on its own.
 *   3. A watcher does not snap to the driver's positions — its own VM is
 *      running the same game, so it is usually nearly right. It eases out the
 *      small error over ~100ms and only jumps when the error is big enough
 *      that easing would look like a mistake. This is the difference between
 *      "smooth" and "juddering at 10Hz", and it is most of the feel.
 *
 * Known limits, stated rather than hidden: clones and pen trails belong to the
 * machine that made them, so a project built almost entirely out of clones
 * looks approximate to a watcher. Sound plays locally. Neither is worth fixing
 * by streaming video, which would cost more bandwidth than everything else on
 * this site combined.
 */

// 10Hz of deltas is plenty when the watcher is simulating between them, and a
// keyframe every 2s bounds how long any drift can survive.
const SYNC_MS = 100;
const KEYFRAME_MS = 2000;
// 30Hz of mouse is smooth to the eye and a third of the traffic of 60.
const MOUSE_MS = 33;
// How long to spread a small correction over. Longer is smoother and laggier;
// ~1.5 sync intervals lands on "you cannot see it happening".
const EASE_MS = 150;
// Past this many stage units the sprite is somewhere else entirely and easing
// would read as a slide across the screen rather than a correction.
const SNAP_UNITS = 60;
const PING_MS = 4000;

const state = {
    vm: null,
    ws: null,
    code: null,
    name: '',
    me: null,
    driver: null,
    players: [],
    queue: [],
    active: false,
    applying: false, // guard: applying remote state must not echo back
    syncTimer: null,
    pingTimer: null,
    lastMouseAt: 0,
    lastKeyframeAt: 0,
    sentWorld: new Map(), // driver: last value sent per target, for deltas
    corrections: new Map(), // watcher: in-flight eases
    rafId: null,
    latency: null,
    pingSentAt: 0,
    listeners: {},
    reconnectAt: 800,
    closedForGood: false
};

const emit = (event, detail) => {
    (state.listeners[event] || []).forEach(fn => {
        try {
            fn(detail);
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error('[coplay] listener', event, e);
        }
    });
    // The panel around the player lives in the host page, outside this bundle.
    try {
        window.parent.postMessage({source: 'squiggle-coplay', event, detail}, location.origin);
    } catch (e) { /* different origin — the panel just won't update */ }
};

const isDriving = () => !!state.me && state.driver === state.me.id;

const send = msg => {
    if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(msg));
};

// ------------------------------------------------------------- the world ---

const originals = vm => vm.runtime.targets.filter(t => t.isOriginal);

/*
 * One sprite's visible state, rounded to what the eye can tell apart. The
 * rounding is what makes delta comparison work: without it, floating-point
 * noise in a physics loop marks every sprite dirty on every frame and the
 * "delta" is the whole world.
 */
const snapshotTarget = t => ({
    x: Math.round(t.x * 4) / 4,
    y: Math.round(t.y * 4) / 4,
    d: Math.round(t.direction * 2) / 2,
    c: t.currentCostume,
    v: t.visible ? 1 : 0,
    s: Math.round(t.size)
});

const sameTarget = (a, b) =>
    a && b && a.x === b.x && a.y === b.y && a.d === b.d &&
    a.c === b.c && a.v === b.v && a.s === b.s;

/*
 * What changed since last time. `force` produces a keyframe — everything,
 * regardless — which is how a watcher that missed a frame gets back in step.
 */
const captureDelta = (vm, force) => {
    const targets = [];
    for (const t of originals(vm)) {
        const name = t.getName();
        const now = snapshotTarget(t);
        if (!force && sameTarget(state.sentWorld.get(name), now)) continue;
        state.sentWorld.set(name, now);
        targets.push({n: name, ...now});
    }

    const vars = [];
    for (const t of originals(vm)) {
        const tname = t.getName();
        for (const id of Object.keys(t.variables || {})) {
            const v = t.variables[id];
            // A scoreboard is worth syncing; a thousand-element working list
            // is not, and would dominate every frame it appeared in.
            if (v.type === 'list' && Array.isArray(v.value) && v.value.length > 100) continue;
            const key = `${tname}::${id}`;
            const serialised = Array.isArray(v.value) ? v.value.join('') : String(v.value);
            if (!force && state.sentWorld.get(key) === serialised) continue;
            state.sentWorld.set(key, serialised);
            vars.push({t: tname, i: id, v: v.value});
        }
    }
    return {targets, vars, key: !!force};
};

/*
 * Reconcile against the driver. Discrete things (costume, visibility, size,
 * direction) are applied at once — there is no halfway house for a costume.
 * Position is eased, because that is the one a human watches continuously.
 */
const applyWorld = (vm, world) => {
    if (!world || !Array.isArray(world.targets)) return;
    state.applying = true;
    try {
        for (const s of world.targets) {
            const t = vm.runtime.targets.find(x => x.isOriginal && x.getName() === s.n);
            if (!t) continue;

            if (Number.isFinite(s.c) && s.c !== t.currentCostume) t.setCostume(s.c);
            if (!t.isStage) {
                if (Number.isFinite(s.d)) t.setDirection(s.d);
                if (Number.isFinite(s.s)) t.setSize(s.s);
                if (typeof s.v === 'number') t.setVisible(!!s.v);

                if (Number.isFinite(s.x) && Number.isFinite(s.y)) {
                    const dx = s.x - t.x;
                    const dy = s.y - t.y;
                    if (Math.hypot(dx, dy) > SNAP_UNITS) {
                        t.setXY(s.x, s.y, true);
                        state.corrections.delete(s.n);
                    } else if (dx || dy) {
                        state.corrections.set(s.n, {
                            x: s.x, y: s.y, fromX: t.x, fromY: t.y, at: Date.now()
                        });
                    }
                }
            }
        }
        for (const v of world.vars || []) {
            const t = vm.runtime.targets.find(x => x.isOriginal && x.getName() === v.t);
            if (!t || !t.variables || !t.variables[v.i]) continue;
            t.variables[v.i].value = v.v;
        }
        vm.runtime.requestRedraw();
    } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[coplay] could not apply world', e);
    } finally {
        state.applying = false;
    }
};

/*
 * Ease the outstanding corrections a frame at a time. Runs only while there is
 * something to correct — an idle session costs nothing.
 */
/*
 * Ease the outstanding corrections a frame at a time. Runs only while there is
 * something to correct — an idle session costs nothing. Named so it can ask
 * for the next frame of itself without a forward reference.
 */
const runCorrections = function step () {
    state.rafId = null;
    if (!state.vm || !state.corrections.size) return;
    const now = Date.now();
    state.applying = true;
    try {
        for (const [name, c] of state.corrections) {
            const t = state.vm.runtime.targets.find(x => x.isOriginal && x.getName() === name);
            if (!t) {
                state.corrections.delete(name);
                continue;
            }
            const p = Math.min(1, (now - c.at) / EASE_MS);
            // Smoothstep: no visible kick at either end of the correction.
            const e = p * p * (3 - (2 * p));
            t.setXY(c.fromX + ((c.x - c.fromX) * e), c.fromY + ((c.y - c.fromY) * e), true);
            if (p >= 1) state.corrections.delete(name);
        }
        state.vm.runtime.requestRedraw();
    } catch (e) { /* target vanished mid-ease */ } finally {
        state.applying = false;
    }
    if (state.corrections.size) state.rafId = requestAnimationFrame(step);
};

const scheduleCorrections = () => {
    if (state.rafId !== null) return;
    state.rafId = requestAnimationFrame(runCorrections);
};

// ---------------------------------------------------------------- inputs ---

const applyInput = msg => {
    const vm = state.vm;
    if (!vm) return;
    state.applying = true;
    try {
        if (msg.kind === 'keydown' || msg.kind === 'keyup') {
            vm.postIOData('keyboard', {key: msg.key, isDown: msg.kind === 'keydown'});
        } else if (msg.kind === 'mousemove' || msg.kind === 'mousedown' || msg.kind === 'mouseup') {
            const data = {
                x: msg.x,
                y: msg.y,
                canvasWidth: vm.runtime.stageWidth,
                canvasHeight: vm.runtime.stageHeight
            };
            if (msg.kind !== 'mousemove') data.isDown = msg.kind === 'mousedown';
            vm.postIOData('mouse', data);
        } else if (msg.kind === 'flag') {
            vm.start();
            vm.greenFlag();
        } else if (msg.kind === 'stop') {
            vm.stopAll();
        }
    } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[coplay] could not apply input', e);
    } finally {
        state.applying = false;
    }
};

/*
 * Capture the driver's input in the capture phase, so we see it before the VM
 * does and never compete with it — the driver's own game is driven by the
 * browser exactly as usual and we only copy what happened.
 */
const wireDriverCapture = () => {
    const typingSomewhere = target => {
        const tag = (target && target.tagName) || '';
        return tag === 'INPUT' || tag === 'TEXTAREA' || (target && target.isContentEditable);
    };

    const onKey = e => {
        if (!state.active || !isDriving() || state.applying) return;
        if (typingSomewhere(e.target)) return; // chatting is not playing
        send({type: 'play-input', kind: e.type === 'keydown' ? 'keydown' : 'keyup', key: e.key});
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('keyup', onKey, true);

    const stageCoords = e => {
        const canvas = document.querySelector('canvas');
        if (!canvas) return null;
        const r = canvas.getBoundingClientRect();
        if (!r.width || !r.height) return null;
        if (e.clientX < r.left || e.clientX > r.right ||
            e.clientY < r.top || e.clientY > r.bottom) return null;
        const w = state.vm ? state.vm.runtime.stageWidth : 480;
        const h = state.vm ? state.vm.runtime.stageHeight : 360;
        return {
            x: (((e.clientX - r.left) / r.width) * w) - (w / 2),
            y: (h / 2) - (((e.clientY - r.top) / r.height) * h)
        };
    };

    document.addEventListener('mousemove', e => {
        if (!state.active || !isDriving() || state.applying) return;
        const now = Date.now();
        if (now - state.lastMouseAt < MOUSE_MS) return;
        const p = stageCoords(e);
        if (!p) return;
        state.lastMouseAt = now;
        send({type: 'play-input', kind: 'mousemove', x: p.x, y: p.y});
    }, true);

    ['mousedown', 'mouseup'].forEach(kind => {
        document.addEventListener(kind, e => {
            if (!state.active || !isDriving() || state.applying) return;
            const p = stageCoords(e);
            if (!p) return;
            send({type: 'play-input', kind, x: p.x, y: p.y});
        }, true);
    });

    // Touch, so a phone can drive too.
    document.addEventListener('touchmove', e => {
        if (!state.active || !isDriving() || !e.touches.length) return;
        const now = Date.now();
        if (now - state.lastMouseAt < MOUSE_MS) return;
        const p = stageCoords(e.touches[0]);
        if (!p) return;
        state.lastMouseAt = now;
        send({type: 'play-input', kind: 'mousemove', x: p.x, y: p.y});
    }, true);
};

// ------------------------------------------------------------- the socket ---

const wsUrl = () => `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;

const pushRoster = () => {
    emit('roster', {
        players: state.players,
        driver: state.driver,
        me: state.me,
        queue: state.queue,
        driving: isDriving()
    });
};

const stopTimers = () => {
    if (state.syncTimer) clearInterval(state.syncTimer);
    if (state.pingTimer) clearInterval(state.pingTimer);
    state.syncTimer = null;
    state.pingTimer = null;
};

const startTimers = () => {
    stopTimers();
    state.syncTimer = setInterval(() => {
        if (!state.vm || !state.active || !isDriving()) return;
        try {
            const now = Date.now();
            const keyframe = now - state.lastKeyframeAt >= KEYFRAME_MS;
            const delta = captureDelta(state.vm, keyframe);
            if (keyframe) state.lastKeyframeAt = now;
            // Nothing moved — say nothing. A paused game costs no traffic.
            if (!delta.targets.length && !delta.vars.length) return;
            send({type: 'play-sync', targets: delta.targets, vars: delta.vars, key: delta.key});
        } catch (e) {
            // eslint-disable-next-line no-console
            console.warn('[coplay] sync failed', e);
        }
    }, SYNC_MS);

    state.pingTimer = setInterval(() => {
        if (!state.active) return;
        state.pingSentAt = Date.now();
        send({type: 'play-ping'});
    }, PING_MS);
    state.pingSentAt = Date.now();
    send({type: 'play-ping'});
};


const handle = msg => {
    switch (msg.type) {
    case 'play-welcome':
        state.me = msg.you;
        state.driver = msg.driver;
        state.players = msg.players || [];
        state.queue = msg.queue || [];
        state.active = true;
        emit('status', {connected: true, code: msg.code, projectId: msg.projectId});
        pushRoster();
        // Land in the game as it is now, not at its title screen.
        if (msg.sync) {
            applyWorld(state.vm, msg.sync);
            state.corrections.clear();
        }
        if (msg.running && !isDriving()) {
            try {
                state.vm.start();
            } catch (e) { /* VM still booting */ }
        }
        startTimers();
        break;

    case 'play-roster':
        state.players = msg.players || [];
        state.queue = msg.queue || state.queue;
        pushRoster();
        break;

    case 'play-driver': {
        const wasDriving = isDriving();
        state.driver = msg.driver;
        state.queue = msg.queue || [];
        if (isDriving() !== wasDriving) {
            // Taking over: forget corrections meant for a watcher, and start
            // from the world as it stands rather than replaying old deltas.
            state.corrections.clear();
            state.sentWorld.clear();
        }
        pushRoster();
        emit('driver', {driving: isDriving(), by: msg.by || null});
        break;
    }

    case 'play-input':
        if (!isDriving()) applyInput(msg);
        break;

    case 'play-sync':
        if (!isDriving()) {
            applyWorld(state.vm, msg);
            if (state.corrections.size) scheduleCorrections();
        }
        break;

    case 'play-pong':
        state.latency = Date.now() - state.pingSentAt;
        emit('latency', {ms: state.latency});
        break;

    case 'play-joined':
        emit('joined', msg.player);
        break;

    case 'play-left':
        emit('left', {id: msg.id, name: msg.name});
        break;

    case 'play-ask':
        emit('ask', {from: msg.from, name: msg.name});
        break;

    case 'play-chat':
        emit('chat', msg);
        break;

    case 'play-blocked':
        emit('blocked', {message: msg.message});
        break;

    case 'play-error':
        if (msg.error === 'no-such-session' || msg.error === 'session-full') {
            state.closedForGood = true;
        }
        emit('error', {error: msg.error});
        break;

    default:
        break;
    }
};

const connect = () => {
    if (state.closedForGood) return;
    let ws;
    try {
        ws = new WebSocket(wsUrl());
    } catch (e) {
        emit('status', {connected: false, error: 'no-socket'});
        return;
    }
    state.ws = ws;

    ws.addEventListener('open', () => {
        state.reconnectAt = 800;
        const join = {type: 'play-join', code: state.code};
        if (state.name) join.name = state.name;
        send(join);
    });

    ws.addEventListener('message', ev => {
        let msg;
        try {
            msg = JSON.parse(ev.data);
        } catch (e) {
            return;
        }
        handle(msg);
    });

    ws.addEventListener('close', () => {
        state.active = false;
        stopTimers();
        emit('status', {connected: false});
        // A dropped connection should not end the afternoon — back off and
        // rejoin. The session survives on the server for half an hour.
        setTimeout(connect, state.reconnectAt);
        state.reconnectAt = Math.min(state.reconnectAt * 2, 15000);
    });
};

// ------------------------------------------------------------- public API ---

const init = (vm, {code, name}) => {
    if (!code || state.code) return;
    state.vm = vm;
    state.code = String(code).toUpperCase();
    state.name = name || '';
    wireDriverCapture();
    connect();

    // Green flag and stop are inputs like any other: the driver pressing one
    // should start or stop everyone's game.
    vm.on('PROJECT_START', () => {
        if (state.active && isDriving() && !state.applying) {
            send({type: 'play-input', kind: 'flag'});
        }
    });
    vm.on('PROJECT_RUN_STOP', () => {
        if (state.active && isDriving() && !state.applying) {
            send({type: 'play-input', kind: 'stop'});
        }
    });

    // Commands from the panel around the player.
    window.addEventListener('message', ev => {
        if (ev.origin !== location.origin) return;
        const d = ev.data;
        if (!d || d.source !== 'squiggle-coplay-host') return;
        if (d.action === 'pass') send({type: 'play-pass', to: d.to});
        else if (d.action === 'ask') send({type: 'play-ask'});
        else if (d.action === 'chat') send({type: 'play-chat', text: d.text});
        else if (d.action === 'roster') pushRoster();
    });
};

const on = (event, fn) => {
    (state.listeners[event] = state.listeners[event] || []).push(fn);
    return () => {
        const list = state.listeners[event] || [];
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
    };
};

export default {
    init,
    on,
    isDriving,
    get players () {
        return state.players;
    },
    get code () {
        return state.code;
    },
    get latency () {
        return state.latency;
    }
};
