const menuIconURI = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCIgdmlld0JveD0iMCAwIDQwIDQwIj4gPHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjQwIiByeD0iOCIgZmlsbD0iI0ZGQzkwMCIvPiA8cGF0aCBkPSJNMjAgMTBhMyAzIDAgMCAwLTMgM3YxMCAzIDAgMCAwIDMgM2gxMGEzIDMgIDAgMCAwIDMtM3YtMTBhMyAzIDAgMCAwLTMtM0gyMHpNMjAgMTJoMTBhMSAxIDAgMCAxIDEtMXYxMGExIDEgMCAwIDEtMSAxSDIwYTEgMSAwIDAgMS0xLTFWMTNhMSAxIDAgMCAxIDEtMXoiIGZpbGw9IiNmZmYiLz48L3N2Zz4=';

class ThunderboltCooldowns {
    constructor (runtime) {
        this.runtime = runtime;
        this._cooldowns = new Map();
    }

    getInfo () {
        return {
            id: 'thunderboltcooldowns',
            name: 'Thunderbolt Cooldowns',
            color1: '#FFC800',
            color2: '#E6B400',
            color3: '#B38C00',
            menuIconURI: menuIconURI,
            blockIconURI: menuIconURI,
            blocks: [
                {
                    opcode: 'startCooldown',
                    blockType: 'command',
                    text: 'start cooldown [NAME] for [SECS] secs',
                    arguments: {
                        NAME: { type: 'string', defaultValue: 'attack' },
                        SECS: { type: 'number', defaultValue: 1 }
                    }
                },
                {
                    opcode: 'resetCooldown',
                    blockType: 'command',
                    text: 'reset cooldown [NAME]',
                    arguments: {
                        NAME: { type: 'string', defaultValue: 'attack' }
                    }
                },
                {
                    opcode: 'addTimeToCooldown',
                    blockType: 'command',
                    text: 'add [SECS] secs to cooldown [NAME]',
                    arguments: {
                        SECS: { type: 'number', defaultValue: 1 },
                        NAME: { type: 'string', defaultValue: 'attack' }
                    }
                },
                '---',
                {
                    opcode: 'isReady',
                    blockType: 'Boolean',
                    text: 'cooldown [NAME] is ready?',
                    arguments: {
                        NAME: { type: 'string', defaultValue: 'attack' }
                    }
                },
                {
                    opcode: 'isOnCooldown',
                    blockType: 'Boolean',
                    text: 'cooldown [NAME] is active?',
                    arguments: {
                        NAME: { type: 'string', defaultValue: 'attack' }
                    }
                },
                '---',
                {
                    opcode: 'timeLeft',
                    blockType: 'reporter',
                    text: 'time left on cooldown [NAME]',
                    arguments: {
                        NAME: { type: 'string', defaultValue: 'attack' }
                    }
                },
                {
                    opcode: 'percentLeft',
                    blockType: 'reporter',
                    text: '% left on cooldown [NAME]',
                    arguments: {
                        NAME: { type: 'string', defaultValue: 'attack' }
                    }
                },
                {
                    opcode: 'totalDuration',
                    blockType: 'reporter',
                    text: 'duration of cooldown [NAME]',
                    arguments: {
                        NAME: { type: 'string', defaultValue: 'attack' }
                    }
                }
            ]
        };
    }

    _get (name) {
        return this._cooldowns.get(String(name));
    }

    _remaining (entry) {
        if (!entry) return 0;
        const ms = entry.readyAt - Date.now();
        return ms > 0 ? ms / 1000 : 0;
    }

    startCooldown (args) {
        const name = String(args.NAME);
        const secs = Math.max(0, Number(args.SECS));
        this._cooldowns.set(name, {
            readyAt: Date.now() + secs * 1000,
            duration: secs
        });
    }

    resetCooldown (args) {
        this._cooldowns.delete(String(args.NAME));
    }

    addTimeToCooldown (args) {
        const name = String(args.NAME);
        const addSecs = Number(args.SECS);
        const entry = this._get(name);
        if (entry) {
            entry.readyAt += addSecs * 1000;
            entry.duration += addSecs;
        } else {
            this._cooldowns.set(name, {
                readyAt: Date.now() + addSecs * 1000,
                duration: addSecs
            });
        }
    }

    isReady (args) {
        return this._remaining(this._get(String(args.NAME))) <= 0;
    }

    isOnCooldown (args) {
        return this._remaining(this._get(String(args.NAME))) > 0;
    }

    timeLeft (args) {
        return Math.round(this._remaining(this._get(String(args.NAME))) * 100) / 100;
    }

    percentLeft (args) {
        const entry = this._get(String(args.NAME));
        if (!entry || entry.duration <= 0) return 0;
        const remaining = this._remaining(entry);
        return Math.round((remaining / entry.duration) * 10000) / 100;
    }

    totalDuration (args) {
        const entry = this._get(String(args.NAME));
        return entry ? entry.duration : 0;
    }
}

export default ThunderboltCooldowns;
