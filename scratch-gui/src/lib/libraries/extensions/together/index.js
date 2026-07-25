/* Together — multiplayer game blocks for ScratchTogether rooms.
 * Runs as a builtin (main thread) so it can reach window.ScratchTogetherNet.
 * Talks only to that bridge; never opens its own socket. */

// eslint-disable-next-line max-len
const menuIconURI = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCIgdmlld0JveD0iMCAwIDQwIDQwIj48cmVjdCB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHJ4PSI4IiBmaWxsPSIjOTk2NmZmIi8+PGNpcmNsZSBjeD0iMTMiIGN5PSIxNCIgcj0iNSIgZmlsbD0iI2ZmZiIvPjxjaXJjbGUgY3g9IjI3IiBjeT0iMTQiIHI9IjUiIGZpbGw9IiNmZmYiLz48cGF0aCBkPSJNNS41IDMxYzAtNC4yIDMuNC03LjUgNy41LTcuNWgwYzEuNCAwIDIuNy40IDMuOCAxLjFDMTQgMjIuOSAxOS45IDIyIDIyIDIyaDBjNC4xIDAgNy41IDMuMyA3LjUgNy41VjMzSDUuNXYtMnoiIGZpbGw9IiNmZmYiLz48L3N2Zz4=';

const str = v => (v == null ? '' : String(v));

const getNet = () => {
    if (typeof window === 'undefined') return null;
    return window.ScratchTogetherNet || null;
};

class TogetherBlocks {
    constructor (runtime) {
        this.runtime = runtime;
        this._shared = Object.create(null);
        this._lastMessageValue = '';
        this._lastJoiner = '';
        this._lastLeaver = '';
        this._unsubs = [];
        this._bound = false;

        this._onGame = this._onGame.bind(this);
        this._onGameState = this._onGameState.bind(this);
        this._onPeerJoined = this._onPeerJoined.bind(this);
        this._onPeerLeft = this._onPeerLeft.bind(this);

        // Bind as soon as the collab bridge appears (login may finish after load).
        this._bindTimer = setInterval(() => this._ensureBound(), 250);
        this._ensureBound();

        runtime.on('PROJECT_STOP_ALL', () => {
            // Keep shared vars across stop — they are room state, not sprite state.
        });
    }

    _ensureBound () {
        const net = getNet();
        if (!net || this._bound) return;
        this._bound = true;
        this._unsubs.push(net.on('game', this._onGame));
        this._unsubs.push(net.on('game-state', this._onGameState));
        this._unsubs.push(net.on('peer-joined', this._onPeerJoined));
        this._unsubs.push(net.on('peer-left', this._onPeerLeft));
        if (this._bindTimer) {
            clearInterval(this._bindTimer);
            this._bindTimer = null;
        }
    }

    dispose () {
        if (this._bindTimer) {
            clearInterval(this._bindTimer);
            this._bindTimer = null;
        }
        for (const off of this._unsubs) {
            try {
                off();
            } catch (e) { /* bridge gone */ }
        }
        this._unsubs = [];
        this._bound = false;
    }

    _onGame (msg) {
        if (!msg || typeof msg !== 'object') return;
        if (msg.action === 'msg') {
            this._lastMessageValue = str(msg.value);
            // Match field is the shadow TEXT of the string arg (case-insensitive).
            this.runtime.startHats('together_whenGameMessage', {
                TEXT: str(msg.name)
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
                }
            ]
        };
    }

    broadcastGameMessage (args) {
        this._ensureBound();
        const name = str(args.NAME);
        const value = str(args.VALUE);
        this._lastMessageValue = value;
        // Fire local hats so sender scripts can react (Scratch-style broadcast).
        this.runtime.startHats('together_whenGameMessage', {TEXT: name});
        const net = getNet();
        if (net) {
            net.send({type: 'game', action: 'msg', name, value});
        }
    }

    gameMessageValue () {
        return this._lastMessageValue;
    }

    setSharedVariable (args) {
        this._ensureBound();
        const name = str(args.NAME);
        if (!name) return;
        const value = args.VALUE == null ? '' : args.VALUE;
        this._shared[name] = value;
        const net = getNet();
        if (net) {
            net.send({type: 'game', action: 'var', name, value});
        }
    }

    getSharedVariable (args) {
        const name = str(args.NAME);
        if (!name) return '';
        const v = this._shared[name];
        return v == null ? '' : v;
    }

    myPlayerName () {
        const net = getNet();
        return (net && net.playerName) || '';
    }

    otherPlayers () {
        const net = getNet();
        if (!net || !net.peers) return '';
        return net.peers.join(', ');
    }
}

export default TogetherBlocks;
