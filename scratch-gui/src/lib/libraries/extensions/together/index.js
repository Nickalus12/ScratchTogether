/* Together — multiplayer game blocks for Squiggle rooms.
 * Runs as a builtin (main thread) so it can reach window.SquiggleNet.
 * Talks only to that bridge; never opens its own socket. */

// eslint-disable-next-line max-len
const menuIconURI = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCIgdmlld0JveD0iMCAwIDQwIDQwIj48cmVjdCB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHJ4PSI4IiBmaWxsPSIjOTk2NmZmIi8+PGNpcmNsZSBjeD0iMTMiIGN5PSIxNCIgcj0iNSIgZmlsbD0iI2ZmZiIvPjxjaXJjbGUgY3g9IjI3IiBjeT0iMTQiIHI9IjUiIGZpbGw9IiNmZmYiLz48cGF0aCBkPSJNNS41IDMxYzAtNC4yIDMuNC03LjUgNy41LTcuNWgwYzEuNCAwIDIuNy40IDMuOCAxLjFDMTggMjIuOSAxOS45IDIyIDIyIDIyaDBjNC4xIDAgNy41IDMuMyA3LjUgNy41VjMzSDUuNXYtMnoiIGZpbGw9IiNmZmYiLz48L3N2Zz4=';

const str = v => (v == null ? '' : String(v));

const getNet = () => (typeof window !== 'undefined' ? window.SquiggleNet : null);

/*
 * How much this extension is allowed to put on the wire.
 *
 * A `forever` loop containing `broadcast game message` runs at the project's
 * frame rate, so one child holding the green flag sends ~30 messages a second
 * to every other player, and nothing between here and the socket was slowing
 * that down — the server relays `game` traffic reliably and unthrottled, and
 * it fans out per peer. Six players in a room is 900 relayed messages a
 * second, from one loop nobody thought was unusual.
 *
 * So there is a budget. Under it, messages go immediately and nothing changes.
 * Over it, they coalesce by name and flush on the next frame: distinct events
 * still all arrive, and a name repeated within one frame collapses to its
 * latest value, which is what the receiving side would have ended up with
 * anyway.
 */
const OUT_PER_SEC = 25;
const VAR_FLUSH_MS = 50;
// Beyond this the sender is in a runaway loop and dropping is kinder than an
// unbounded queue eating the tab's memory.
const MAX_PENDING = 64;
const MAX_INBOX = 64;

class TogetherBlocks {
    constructor (runtime) {
        this.runtime = runtime;
        this._shared = Object.create(null);
        this._lastMessageName = '';
        this._lastMessageValue = '';
        this._lastJoiner = '';
        this._lastLeaver = '';
        this._unsubs = [];
        this._bound = false;

        /*
         * Incoming messages wait here and are handed to hats one per frame.
         *
         * They used to be delivered the instant they arrived, which quietly
         * broke the reporters: two messages in the same frame both wrote
         * `game message name` before either hat's script got to run, so both
         * scripts read the second one. With "when I receive [score]" that was
         * rare enough to look like a glitch. With "when I receive ANY game
         * message" — a block whose entire purpose is handling several kinds —
         * it would be the normal case.
         */
        this._inbox = [];
        this._inboxDropped = 0;

        // Outbound budget + coalescing buffers.
        this._tokens = OUT_PER_SEC;
        this._tokensAt = 0;
        this._pendingMsgs = new Map();
        this._pendingVars = new Map();
        this._varTimer = null;
        this._warnedFlood = false;

        this._onGame = this._onGame.bind(this);
        this._onGameState = this._onGameState.bind(this);
        this._onPeerJoined = this._onPeerJoined.bind(this);
        this._onPeerLeft = this._onPeerLeft.bind(this);
        this._onBridgeReady = this._onBridgeReady.bind(this);
        this._onStep = this._onStep.bind(this);
        this._onDisposed = this._onDisposed.bind(this);

        // Event-driven bind — no polling. Also try immediately + on each opcode.
        if (typeof window !== 'undefined') {
            window.addEventListener('SquiggleNetReady', this._onBridgeReady);
        }
        this._ensureBound();

        // One tick of the VM's own clock. Everything time-based here rides on
        // it rather than a timer of its own, so a paused project cannot keep
        // delivering messages to scripts that are not running.
        runtime.on('BEFORE_EXECUTE', this._onStep);
        runtime.on('RUNTIME_DISPOSED', this._onDisposed);
    }

    /*
     * The clock, as a method so a test can replace it. Rate limiting that can
     * only be observed by actually waiting is rate limiting that does not get
     * tested, and this one decides whether a child's game feels responsive or
     * whether a runaway loop takes the room down.
     */
    _now () {
        return Date.now();
    }

    /**
     * Refill the outbound budget from elapsed time.
     * @param {number} now milliseconds, from _now()
     */
    _refill (now) {
        if (!this._tokensAt) {
            this._tokensAt = now;
            return;
        }
        const elapsed = now - this._tokensAt;
        if (elapsed <= 0) return;
        this._tokensAt = now;
        const earned = (elapsed / 1000) * OUT_PER_SEC;
        this._tokens = Math.min(OUT_PER_SEC, this._tokens + earned);
    }

    /**
     * One frame: deliver at most one incoming message, then spend whatever
     * outbound budget has accrued on anything that had to wait.
     */
    _onStep () {
        const now = this._now();
        this._refill(now);

        if (this._inbox.length) {
            const next = this._inbox.shift();
            this._lastMessageName = next.name;
            this._lastMessageValue = next.value;
            this.runtime.startHats('together_whenGameMessage', {TEXT: next.name});
            this.runtime.startHats('together_whenAnyGameMessage');
        }

        if (this._pendingMsgs.size) {
            const net = getNet();
            for (const [name, value] of this._pendingMsgs) {
                if (this._tokens < 1) break;
                this._tokens -= 1;
                this._pendingMsgs.delete(name);
                if (net) net.send({type: 'game', action: 'msg', name, value});
            }
        }
    }

    /**
     * Hold a message for the next frame. The single door into the inbox, so
     * local and remote messages are delivered by exactly the same path.
     * @param {string} name message name, already non-empty
     * @param {string} value message value
     */
    _queueIncoming (name, value) {
        if (this._inbox.length >= MAX_INBOX) {
            this._inbox.shift();
            this._inboxDropped++;
            if (!this._warnedFlood) {
                this._warnedFlood = true;
                // eslint-disable-next-line no-console
                console.warn('[together] game messages are arriving faster than the ' +
                    'project can handle them — the oldest are being dropped');
            }
        }
        this._inbox.push({name, value});
    }

    _onDisposed () {
        this.dispose();
    }

    _onBridgeReady () {
        this._ensureBound();
    }

    _ensureBound () {
        const net = getNet();
        if (!net || this._bound) return;
        this._bound = true;
        this._unsubs.push(net.on('game', this._onGame));
        this._unsubs.push(net.on('game-state', this._onGameState));
        this._unsubs.push(net.on('peer-joined', this._onPeerJoined));
        this._unsubs.push(net.on('peer-left', this._onPeerLeft));
        // Seed from bridge cache in case game-state replay already fired.
        const vars = net.sharedVars;
        if (vars) {
            for (const key of Object.keys(vars)) {
                this._shared[key] = vars[key];
            }
        }
    }

    dispose () {
        if (typeof window !== 'undefined') {
            window.removeEventListener('SquiggleNetReady', this._onBridgeReady);
        }
        for (let i = 0; i < this._unsubs.length; i++) {
            try {
                this._unsubs[i]();
            } catch (e) { /* bridge gone */ }
        }
        this._unsubs = [];
        this._bound = false;

        /*
         * The runtime listeners have to come off too. They were left attached,
         * so loading a second project stacked another pair on the same runtime
         * and the step handler ran once per project ever opened — each with
         * its own inbox, all firing hats into the current one.
         */
        if (this.runtime && this.runtime.off) {
            this.runtime.off('BEFORE_EXECUTE', this._onStep);
            this.runtime.off('RUNTIME_DISPOSED', this._onDisposed);
        }

        // And the state goes with it. Shared variables belonged to the room
        // and the project that just closed; reading them out of the next one
        // is a stale answer wearing a current-looking block.
        this._shared = Object.create(null);
        this._inbox = [];
        this._pendingMsgs.clear();
        this._pendingVars.clear();
        if (this._varTimer) {
            clearTimeout(this._varTimer);
            this._varTimer = null;
        }
        this._lastMessageName = '';
        this._lastMessageValue = '';
        this._lastJoiner = '';
        this._lastLeaver = '';
    }

    _onGame (msg) {
        if (!msg || typeof msg !== 'object') return;
        if (msg.action === 'msg') {
            const name = str(msg.name);
            if (!name) return;
            /*
             * Queued, not delivered. _onStep hands these to hats one per frame
             * so that `game message name` and `game message value` are the
             * ones belonging to the hat that is running, rather than whichever
             * message happened to arrive last in the frame.
             */
            this._queueIncoming(name, str(msg.value));
        } else if (msg.action === 'var') {
            const name = str(msg.name);
            if (name) this._shared[name] = msg.value == null ? '' : msg.value;
        }
    }

    _onGameState (msg) {
        const vars = msg && msg.vars;
        if (!vars || typeof vars !== 'object') return;
        for (const key of Object.keys(vars)) {
            this._shared[key] = vars[key];
        }
    }

    _onPeerJoined (msg) {
        this._lastJoiner = (msg && msg.peer && msg.peer.name) || '';
        this.runtime.startHats('together_whenPlayerJoins');
    }

    _onPeerLeft (msg) {
        this._lastLeaver = (msg && msg.name) || '';
        this.runtime.startHats('together_whenPlayerLeaves');
    }

    getInfo () {
        return {
            id: 'together',
            name: 'Together',
            color1: '#9966ff',
            color2: '#855cd6',
            color3: '#774dcb',
            menuIconURI: menuIconURI,
            blockIconURI: menuIconURI,
            blocks: [
                {
                    opcode: 'broadcastGameMessage',
                    blockType: 'command',
                    text: 'broadcast game message [NAME] with [VALUE]',
                    arguments: {
                        NAME: {
                            type: 'string',
                            defaultValue: 'score'
                        },
                        VALUE: {
                            type: 'string',
                            defaultValue: '1'
                        }
                    }
                },
                {
                    opcode: 'whenGameMessage',
                    blockType: 'event',
                    text: 'when I receive game message [NAME]',
                    isEdgeActivated: false,
                    shouldRestartExistingThreads: true,
                    arguments: {
                        NAME: {
                            type: 'string',
                            defaultValue: 'score'
                        }
                    }
                },
                /*
                 * The catch-all. "when I receive [score]" makes you name every
                 * message up front, which is fine until you are writing the
                 * thing that logs them, relays them, or reacts to whatever the
                 * other player just did — and then you are stuck adding a hat
                 * per message and editing it whenever the game changes.
                 *
                 * Inside this hat, `game message name` and `game message
                 * value` tell you which one arrived, so one script can handle
                 * all of them.
                 */
                {
                    opcode: 'whenAnyGameMessage',
                    blockType: 'event',
                    text: 'when I receive any game message',
                    isEdgeActivated: false,
                    shouldRestartExistingThreads: true
                },
                {
                    opcode: 'gameMessageName',
                    blockType: 'reporter',
                    text: 'game message name',
                    disableMonitor: true
                },
                {
                    opcode: 'gameMessageValue',
                    blockType: 'reporter',
                    text: 'game message value',
                    disableMonitor: false
                },
                '---',
                {
                    opcode: 'setSharedVariable',
                    blockType: 'command',
                    text: 'set shared variable [NAME] to [VALUE]',
                    arguments: {
                        NAME: {
                            type: 'string',
                            defaultValue: 'score'
                        },
                        VALUE: {
                            type: 'string',
                            defaultValue: '0'
                        }
                    }
                },
                {
                    opcode: 'changeSharedVariable',
                    blockType: 'command',
                    text: 'change shared variable [NAME] by [VALUE]',
                    arguments: {
                        NAME: {
                            type: 'string',
                            defaultValue: 'score'
                        },
                        VALUE: {
                            type: 'number',
                            defaultValue: 1
                        }
                    }
                },
                {
                    opcode: 'getSharedVariable',
                    blockType: 'reporter',
                    text: 'shared variable [NAME]',
                    arguments: {
                        NAME: {
                            type: 'string',
                            defaultValue: 'score'
                        }
                    }
                },
                '---',
                {
                    opcode: 'myPlayerName',
                    blockType: 'reporter',
                    text: 'my player name'
                },
                {
                    opcode: 'otherPlayers',
                    blockType: 'reporter',
                    text: 'other players'
                },
                {
                    opcode: 'playerCount',
                    blockType: 'reporter',
                    text: 'player count'
                },
                {
                    opcode: 'whenPlayerJoins',
                    blockType: 'event',
                    text: 'when a player joins',
                    isEdgeActivated: false,
                    shouldRestartExistingThreads: false
                },
                {
                    opcode: 'whenPlayerLeaves',
                    blockType: 'event',
                    text: 'when a player leaves',
                    isEdgeActivated: false,
                    shouldRestartExistingThreads: false
                },
                {
                    opcode: 'lastPlayerJoined',
                    blockType: 'reporter',
                    text: 'last player joined',
                    disableMonitor: true
                },
                {
                    opcode: 'lastPlayerLeft',
                    blockType: 'reporter',
                    text: 'last player left',
                    disableMonitor: true
                },
                {
                    opcode: 'connected',
                    blockType: 'Boolean',
                    text: 'connected to room?'
                }
            ]
        };
    }

    broadcastGameMessage (args) {
        this._ensureBound();
        const name = str(args.NAME);
        if (!name) return;
        const value = str(args.VALUE);

        /*
         * The sender hears its own broadcast, through the same queue as
         * everyone else's.
         *
         * This used to start the hats right here, which reintroduced the exact
         * bug the queue exists to fix, only locally: two broadcasts in one
         * frame — `broadcast score` then `broadcast lives`, a completely
         * ordinary pair — and both hats' scripts read "lives", because the
         * second call overwrote the reporters before either thread ran.
         *
         * Going through the queue also means a game behaves the same whoever
         * sent the message, which matters more than the frame of latency it
         * costs: a bug that only appears when YOU are the host is the worst
         * kind to be told about.
         */
        this._queueIncoming(name, value);

        const net = getNet();
        if (!net) return;
        this._refill(this._now());
        if (this._tokens >= 1) {
            this._tokens -= 1;
            net.send({type: 'game', action: 'msg', name, value});
            return;
        }
        // Over budget: hold it by name and let the next frame send it. A name
        // repeated inside one frame keeps its latest value, which is what the
        // other side would have been left with regardless.
        if (this._pendingMsgs.size >= MAX_PENDING && !this._pendingMsgs.has(name)) return;
        this._pendingMsgs.set(name, value);
    }

    gameMessageName () {
        return this._lastMessageName;
    }

    gameMessageValue () {
        return this._lastMessageValue;
    }

    setSharedVariable (args) {
        this._ensureBound();
        const name = str(args.NAME);
        if (!name) return;
        // Preserve numbers from numeric inputs so math reporters stay numeric.
        let value = args.VALUE;
        if (value == null) value = '';
        else if (typeof value !== 'number' && typeof value !== 'boolean') value = str(value);
        // Skip no-op writes — cuts socket + disk work when a loop sets the same value.
        if (this._shared[name] === value) return;
        this._shared[name] = value;
        this._queueVar(name, value);
    }

    /*
     * Shared variables coalesce for free: they are last-write-wins by design,
     * so sending only the newest value for a name loses nothing at all. A
     * script setting a player's position every frame becomes one write per
     * 50ms instead of one per frame, and the value that lands is the same.
     *
     * The local cache is updated by the caller before this, so reporters read
     * the new value immediately regardless of when it goes out.
     */
    _queueVar (name, value) {
        this._pendingVars.set(name, value);
        if (this._varTimer) return;
        this._varTimer = setTimeout(() => {
            this._varTimer = null;
            const net = getNet();
            const pending = this._pendingVars;
            this._pendingVars = new Map();
            if (!net) return;
            for (const [key, val] of pending) {
                net.send({type: 'game', action: 'var', name: key, value: val});
            }
        }, VAR_FLUSH_MS);
    }

    changeSharedVariable (args) {
        this._ensureBound();
        const name = str(args.NAME);
        if (!name) return;
        const cur = Number(this._shared[name]);
        const delta = Number(args.VALUE);
        const next = (Number.isFinite(cur) ? cur : 0) + (Number.isFinite(delta) ? delta : 0);
        if (this._shared[name] === next) return;
        this._shared[name] = next;
        this._queueVar(name, next);
    }

    getSharedVariable (args) {
        const name = str(args.NAME);
        if (!name) return '';
        const v = this._shared[name];
        return v == null ? '' : v;
    }

    myPlayerName () {
        this._ensureBound();
        const net = getNet();
        return (net && net.playerName) || '';
    }

    otherPlayers () {
        this._ensureBound();
        const net = getNet();
        if (!net) return '';
        // Prefer pre-joined string from the bridge (rebuilt only on join/leave).
        if (typeof net.peersText === 'string') return net.peersText;
        return (net.peers || []).join(', ');
    }

    playerCount () {
        this._ensureBound();
        const net = getNet();
        /*
         * You always count. It used to return 0 whenever the bridge existed
         * but had no player name yet — signed in but not through the room
         * handshake — while returning 1 when there was no bridge at all. So
         * the block read 1 alone offline, 0 alone online, and games dividing
         * by it or checking `= 1` broke for the first second of every session.
         */
        const others = (net && net.peers && net.peers.length) || 0;
        return 1 + others;
    }

    lastPlayerJoined () {
        return this._lastJoiner;
    }

    lastPlayerLeft () {
        return this._lastLeaver;
    }

    connected () {
        this._ensureBound();
        const net = getNet();
        return !!(net && net.connected);
    }
}

export default TogetherBlocks;
