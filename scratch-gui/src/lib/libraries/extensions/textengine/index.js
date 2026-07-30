const menuIconURI = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCIgdmlld0JveD0iMCAwIDQwIDQwIj4gPHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjQwIiByeD0iOCIgZmlsbD0iIzk5NjZGRiIvPiA8cGF0aCBkPSJNMTQgMTJoMTJ2M2gtNHYxM2gtM3YtMTNoLTR2LTN6IiBmaWxsPSIjZmZmIi8+PC9zdmc+';

const GOOGLE_FONTS = ["Bangers", "Press Start 2P", "Pacifico", "Permanent Marker", "Luckiest Guy"];

function injectGoogleFonts() {
    if (typeof document === 'undefined') return;
    const families = GOOGLE_FONTS.map((f) => "family=" + f.replace(/ /g, "+")).join("&");
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?${families}&display=swap`;
    document.head.appendChild(link);
}

const clamp01 = (n) => Math.max(0, Math.min(1, n));

class TextObject {
    constructor(id, text, x, y) {
        this.id = id;
        this.text = text;
        this.x = x;
        this.y = y;
        this.font = "Arial";
        this.size = 32;
        this.color = "#FFFFFF";
        this.outlineColor = null;
        this.outlineWidth = 0;
        this.align = "center";
        this.bold = false;
        this.italic = false;
        this.visible = true;
        this.animation = "none";
        this.animSpeed = 1;
        this.elapsed = 0;
    }

    get fontString() {
        const style = this.italic ? "italic " : "";
        const weight = this.bold ? "bold " : "";
        return `${style}${weight}${this.size}px "${this.font}"`;
    }
}

class ThunderboltText {
    constructor(runtime) {
        this.runtime = runtime;
        this.objects = new Map();
        this.canvas = null;
        this.ctx = null;
        this.lastTime = null;
        injectGoogleFonts();
        this._setupCanvas();
        this._loop = this._loop.bind(this);
        requestAnimationFrame(this._loop);
    }

    _setupCanvas() {
        const stageCanvas = this.runtime.renderer.canvas;
        const overlay = document.createElement("canvas");
        overlay.style.position = "absolute";
        overlay.style.pointerEvents = "none";
        overlay.style.zIndex = "12";
        overlay.width = stageCanvas.width;
        overlay.height = stageCanvas.height;

        const syncPosition = () => {
            const rect = stageCanvas.getBoundingClientRect();
            const parentRect = stageCanvas.parentElement.getBoundingClientRect();
            overlay.style.left = rect.left - parentRect.left + "px";
            overlay.style.top = rect.top - parentRect.top + "px";
            overlay.style.width = rect.width + "px";
            overlay.style.height = rect.height + "px";
            overlay.width = stageCanvas.width;
            overlay.height = stageCanvas.height;
        };

        stageCanvas.parentElement.style.position =
            stageCanvas.parentElement.style.position || "relative";
        stageCanvas.parentElement.appendChild(overlay);
        syncPosition();

        new ResizeObserver(syncPosition).observe(stageCanvas);
        window.addEventListener("resize", syncPosition);

        this.canvas = overlay;
        this.ctx = overlay.getContext("2d");
    }

    _stageToCanvas(x, y) {
        const w = this.canvas.width;
        const h = this.canvas.height;
        return {
            x: w / 2 + x * (w / 480),
            y: h / 2 - y * (h / 360),
        };
    }

    _loop(timestamp) {
        if (this.lastTime === null) this.lastTime = timestamp;
        const dt = Math.min(0.05, (timestamp - this.lastTime) / 1000);
        this.lastTime = timestamp;
        const time = timestamp / 1000;

        if (!this.canvas || !this.ctx) return;

        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        const scale = this.canvas.width / 480;

        for (const obj of this.objects.values()) {
            if (!obj.visible) continue;
            obj.elapsed += dt;
            this._drawObject(obj, time, scale);
        }

        requestAnimationFrame(this._loop);
    }

    _drawObject(obj, time, scale) {
        const ctx = this.ctx;
        ctx.font = `${obj.italic ? "italic " : ""}${obj.bold ? "bold " : ""}${obj.size * scale}px "${obj.font}"`;
        ctx.textBaseline = "middle";

        const chars = obj.text.split("");
        const widths = chars.map((c) => ctx.measureText(c).width);
        const totalWidth = widths.reduce((a, b) => a + b, 0);

        let startXOffset;
        if (obj.align === "left") startXOffset = 0;
        else if (obj.align === "right") startXOffset = -totalWidth;
        else startXOffset = -totalWidth / 2;

        const { x: cx, y: cy } = this._stageToCanvas(obj.x, obj.y);

        let revealCount = chars.length;
        let entranceProgress = 1;

        if (obj.animation === "typewriter") {
            const charsPerSec = Math.max(0.1, obj.animSpeed) * 8;
            revealCount = Math.floor(obj.elapsed * charsPerSec);
        } else if (obj.animation === "fadein" || obj.animation === "bounce") {
            const duration = 0.6 / Math.max(0.1, obj.animSpeed);
            entranceProgress = clamp01(obj.elapsed / duration);
        }

        let cursor = startXOffset;
        for (let i = 0; i < chars.length; i++) {
            const ch = chars[i];
            const w = widths[i];
            let dx = 0;
            let dy = 0;
            let alpha = 1;
            let charScale = 1;
            let color = obj.color;

            if (obj.animation === "typewriter") {
                if (i >= revealCount) {
                    cursor += w;
                    continue;
                }
            } else if (obj.animation === "wave") {
                dy = Math.sin(time * obj.animSpeed * 4 + i * 0.5) * (obj.size * scale * 0.15);
            } else if (obj.animation === "shake") {
                dx = (Math.random() * 2 - 1) * obj.animSpeed * 2 * scale;
                dy = (Math.random() * 2 - 1) * obj.animSpeed * 2 * scale;
            } else if (obj.animation === "rainbow") {
                const hue = (time * obj.animSpeed * 60 + i * 25) % 360;
                color = `hsl(${hue}, 90%, 65%)`;
            } else if (obj.animation === "pulse") {
                charScale = 1 + 0.12 * Math.sin(time * obj.animSpeed * 4);
            } else if (obj.animation === "glitch") {
                if (Math.random() < 0.05 * obj.animSpeed) {
                    dx = (Math.random() * 2 - 1) * obj.size * scale * 0.2;
                    dy = (Math.random() * 2 - 1) * obj.size * scale * 0.2;
                    color = ["#00FFFF", "#FF00FF", "#FFFF00"][Math.floor(Math.random() * 3)];
                }
            } else if (obj.animation === "fadein") {
                const stagger = clamp01(entranceProgress * chars.length - i);
                alpha = clamp01(stagger);
            } else if (obj.animation === "bounce") {
                const stagger = clamp01(entranceProgress * chars.length - i);
                const eased = stagger < 1 ? 1 - Math.pow(1 - stagger, 3) : 1;
                const overshoot = stagger < 1 ? Math.sin(stagger * Math.PI) * 0.3 : 0;
                dy = (1 - eased) * -(obj.size * scale) - overshoot * (obj.size * scale * 0.2);
                alpha = clamp01(stagger * 3);
            }

            const px = cx + cursor + w / 2 + dx;
            const py = cy + dy;

            ctx.save();
            ctx.globalAlpha = alpha;
            ctx.translate(px, py);
            ctx.scale(charScale, charScale);
            ctx.textAlign = "center";

            if (obj.outlineColor && obj.outlineWidth > 0) {
                ctx.lineWidth = obj.outlineWidth * scale;
                ctx.strokeStyle = obj.outlineColor;
                ctx.strokeText(ch, 0, 0);
            }

            ctx.fillStyle = color;
            ctx.fillText(ch, 0, 0);
            ctx.restore();

            cursor += w;
        }
    }

    _getObj(id, createIfMissing) {
        if (!this.objects.has(id) && createIfMissing) {
            this.objects.set(id, new TextObject(id, "", 0, 0));
        }
        return this.objects.get(id);
    }

    getInfo() {
        return {
            id: "thunderbolttext",
            name: "Thunderbolt Text",
            color1: "#9966FF",
            color2: "#774DCB",
            color3: "#552299",
            menuIconURI: menuIconURI,
            blockIconURI: menuIconURI,
            blocks: [
                {
                    opcode: "createText",
                    blockType: "command",
                    text: "create text [ID] saying [TEXT] at x:[X] y:[Y]",
                    arguments: {
                        ID: { type: "string", defaultValue: "title" },
                        TEXT: { type: "string", defaultValue: "Hello!" },
                        X: { type: "number", defaultValue: 0 },
                        Y: { type: "number", defaultValue: 0 },
                    },
                },
                {
                    opcode: "setText",
                    blockType: "command",
                    text: "set text [ID] to [TEXT]",
                    arguments: {
                        ID: { type: "string", defaultValue: "title" },
                        TEXT: { type: "string", defaultValue: "Hello!" },
                    },
                },
                {
                    opcode: "setPosition",
                    blockType: "command",
                    text: "set position of [ID] to x:[X] y:[Y]",
                    arguments: {
                        ID: { type: "string", defaultValue: "title" },
                        X: { type: "number", defaultValue: 0 },
                        Y: { type: "number", defaultValue: 0 },
                    },
                },
                "---",
                {
                    opcode: "setFont",
                    blockType: "command",
                    text: "set font of [ID] to [FONT]",
                    arguments: {
                        ID: { type: "string", defaultValue: "title" },
                        FONT: { type: "string", menu: "fonts", defaultValue: "Arial" },
                    },
                },
                {
                    opcode: "setSize",
                    blockType: "command",
                    text: "set size of [ID] to [SIZE]",
                    arguments: {
                        ID: { type: "string", defaultValue: "title" },
                        SIZE: { type: "number", defaultValue: 32 },
                    },
                },
                {
                    opcode: "setColor",
                    blockType: "command",
                    text: "set color of [ID] to [COLOR]",
                    arguments: {
                        ID: { type: "string", defaultValue: "title" },
                        COLOR: { type: "color", defaultValue: "#FFFFFF" },
                    },
                },
                {
                    opcode: "setOutline",
                    blockType: "command",
                    text: "set outline of [ID] to [COLOR] width [WIDTH]",
                    arguments: {
                        ID: { type: "string", defaultValue: "title" },
                        COLOR: { type: "color", defaultValue: "#000000" },
                        WIDTH: { type: "number", defaultValue: 3 },
                    },
                },
                {
                    opcode: "setStyle",
                    blockType: "command",
                    text: "set [ID] bold: [BOLD] italic: [ITALIC]",
                    arguments: {
                        ID: { type: "string", defaultValue: "title" },
                        BOLD: { type: "string", menu: "onOff", defaultValue: "off" },
                        ITALIC: { type: "string", menu: "onOff", defaultValue: "off" },
                    },
                },
                {
                    opcode: "setAlign",
                    blockType: "command",
                    text: "set alignment of [ID] to [ALIGN]",
                    arguments: {
                        ID: { type: "string", defaultValue: "title" },
                        ALIGN: { type: "string", menu: "align", defaultValue: "center" },
                    },
                },
                "---",
                {
                    opcode: "setAnimation",
                    blockType: "command",
                    text: "animate [ID] with [ANIMATION] at speed [SPEED]",
                    arguments: {
                        ID: { type: "string", defaultValue: "title" },
                        ANIMATION: { type: "string", menu: "animations", defaultValue: "wave" },
                        SPEED: { type: "number", defaultValue: 1 },
                    },
                },
                {
                    opcode: "hasFinishedTyping",
                    blockType: "Boolean",
                    text: "has [ID] finished typing?",
                    arguments: {
                        ID: { type: "string", defaultValue: "title" },
                    },
                },
                "---",
                {
                    opcode: "showText",
                    blockType: "command",
                    text: "show text [ID]",
                    arguments: {
                        ID: { type: "string", defaultValue: "title" },
                    },
                },
                {
                    opcode: "hideText",
                    blockType: "command",
                    text: "hide text [ID]",
                    arguments: {
                        ID: { type: "string", defaultValue: "title" },
                    },
                },
                {
                    opcode: "deleteText",
                    blockType: "command",
                    text: "delete text [ID]",
                    arguments: {
                        ID: { type: "string", defaultValue: "title" },
                    },
                },
            ],
            menus: {
                onOff: { acceptReporters: false, items: ["on", "off"] },
                align: { acceptReporters: false, items: ["left", "center", "right"] },
                animations: {
                    acceptReporters: false,
                    items: ["none", "typewriter", "wave", "shake", "rainbow", "pulse", "glitch", "fadein", "bounce"],
                },
                fonts: {
                    acceptReporters: false,
                    items: [
                        "Arial", "Georgia", "Courier New", "Comic Sans MS", "Impact",
                        "Verdana", "Times New Roman", ...GOOGLE_FONTS,
                    ],
                },
            },
        };
    }

    createText(args) {
        const obj = new TextObject(args.ID, args.TEXT, Number(args.X), Number(args.Y));
        this.objects.set(args.ID, obj);
    }

    setText(args) {
        const obj = this._getObj(args.ID, true);
        obj.text = args.TEXT;
        obj.elapsed = 0;
    }

    setPosition(args) {
        const obj = this._getObj(args.ID, true);
        obj.x = Number(args.X);
        obj.y = Number(args.Y);
    }

    setFont(args) {
        const obj = this._getObj(args.ID, true);
        obj.font = args.FONT;
    }

    setSize(args) {
        const obj = this._getObj(args.ID, true);
        obj.size = Number(args.SIZE);
    }

    setColor(args) {
        const obj = this._getObj(args.ID, true);
        obj.color = args.COLOR;
    }

    setOutline(args) {
        const obj = this._getObj(args.ID, true);
        obj.outlineColor = args.COLOR;
        obj.outlineWidth = Number(args.WIDTH);
    }

    setStyle(args) {
        const obj = this._getObj(args.ID, true);
        obj.bold = args.BOLD === "on";
        obj.italic = args.ITALIC === "on";
    }

    setAlign(args) {
        const obj = this._getObj(args.ID, true);
        obj.align = args.ALIGN;
    }

    setAnimation(args) {
        const obj = this._getObj(args.ID, true);
        obj.animation = args.ANIMATION;
        obj.animSpeed = Number(args.SPEED);
        obj.elapsed = 0;
    }

    hasFinishedTyping(args) {
        const obj = this._getObj(args.ID, false);
        if (!obj) return true;
        if (obj.animation !== "typewriter") return true;
        const charsPerSec = Math.max(0.1, obj.animSpeed) * 8;
        return Math.floor(obj.elapsed * charsPerSec) >= obj.text.length;
    }

    showText(args) {
        const obj = this._getObj(args.ID, true);
        obj.visible = true;
    }

    hideText(args) {
        const obj = this._getObj(args.ID, true);
        obj.visible = false;
    }

    deleteText(args) {
        this.objects.delete(args.ID);
    }
}

export default ThunderboltText;
