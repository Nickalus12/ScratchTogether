/* Together — multiplayer game blocks for Squiggle rooms.
 * Runs as a builtin (main thread) so it can reach window.SquiggleNet.
 * Talks only to that bridge; never opens its own socket. */

// eslint-disable-next-line max-len
const menuIconURI = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCIgdmlld0JveD0iMCAwIDQwIDQwIj48cmVjdCB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHJ4PSI4IiBmaWxsPSIjOTk2NmZmIi8+PGNpcmNsZSBjeD0iMTMiIGN5PSIxNCIgcj0iNSIgZmlsbD0iI2ZmZiIvPjxjaXJjbGUgY3g9IjI3IiBjeT0iMTQiIHI9IjUiIGZpbGw9IiNmZmYiLz48cGF0aCBkPSJNNS41IDMxYzAtNC4yIDMuNC03LjUgNy41LTcuNWgwYzEuNCAwIDIuNy40IDMuOCAxLjFDMTggMjIuOSAxOS45IDIyIDIyIDIyaDBjNC4xIDAgNy41IDMuMyA3LjUgNy41VjMzSDUuNXYtMnoiIGZpbGw9IiNmZmYiLz48L3N2Zz4=';

const str = v => (v == null ? '' : String(v));

const getNet = () => (typeof window !== 'undefined' ? window.SquiggleNet : null);

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

        this._onGame = this._onGame.bind(this);
        this._onGameState = this._onGameState.bind(this);
        this._onPeerJoined = this._onPeerJoined.bind(this);
        this._onPeerLeft = this._onPeerLeft.bind(this);
        this._onBridgeReady = this._onBridgeReady.bind(this);

        // Event-driven bind — no polling. Also try immediately + on each opcode.
        if (typeof window !== 'undefined') {
            window.addEventListener('SquiggleNetReady', this._onBridgeReady);
        }
        this._ensureBound();

        runtime.on('RUNTIME_DISPOSED', () => this.dispose());
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
    }

    _onGame (msg) {
        if (!msg || typeof msg !== 'object') return;
        if (msg.action === 'msg') {
            this._lastMessageName = str(msg.name);
            this._lastMessageValue = str(msg.value);
            // Match field is the shadow TEXT of the string arg (case-insensitive).
            this.runtime.startHats('together_whenGameMessage', {
                TEXT: this._lastMessageName
            });
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
        this._lastMessageName = name;
        this._lastMessageValue = value;
        // Fire local hats so sender scripts can react (Scratch-style broadcast).
        this.runtime.startHats('together_whenGameMessage', {TEXT: name});
        const net = getNet();
        if (net) {
            net.send({type: 'game', action: 'msg', name, value});
        }
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
        const net = getNet();
        if (net) {
            net.send({type: 'game', action: 'var', name, value});
        }
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
        const net = getNet();
        if (net) {
            net.send({type: 'game', action: 'var', name, value: next});
        }
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
        if (!net) return 1;
        // Self + peers
        const n = (net.peers && net.peers.length) || 0;
        return (net.playerName ? 1 : 0) + n;
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
