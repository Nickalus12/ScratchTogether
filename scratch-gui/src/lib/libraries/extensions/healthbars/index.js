const menuIconURI = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCIgdmlld0JveD0iMCAwIDQwIDQwIj48cmVjdCB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHJ4PSI4IiBmaWxsPSIjRkY0NDQ0Ii8+PHBhdGggZD0iTTEyIDE1YTUgNSAwIDAgMSA1LTVjMS40IDAgMi43LjYgMy41IDEuN2MuOC0xLjEgMi4xLTEuNyAzLjUtNWE1IDUgMCAwIDEgNSA1YzAgNS43LTcuNiAxMC41LTEyIDE0Yy00LjQtMy41LTEyLTguMy0xMi0xNHoiIGZpbGw9IiNmZmYiLz48L3N2Zz4=';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

class Popup {
    constructor(text, color) {
        this.text = text;
        this.color = color;
        this.elapsed = 0;
        this.duration = 1;
        this.xJitter = (Math.random() * 2 - 1) * 10;
    }
}

class HealthBar {
    constructor(id, x, y, max) {
        this.id = id;
        this.x = x;
        this.y = y;
        this.width = 120;
        this.height = 18;
        this.maxHealth = max;
        this.health = max;
        this.style = "modern";
        this.label = "";
        this.visible = true;
        this.showDamageNumbers = true;
        this.flashOnDamage = true;
        this.flashElapsed = 999;
        this.popups = [];
    }

    get pct() {
        return this.maxHealth <= 0 ? 0 : clamp(this.health / this.maxHealth, 0, 1);
    }

    changeHealth(delta) {
        const before = this.health;
        this.health = clamp(this.health + delta, 0, this.maxHealth);
        const actualDelta = this.health - before;
        if (actualDelta !== 0 && this.showDamageNumbers) {
            const text = (actualDelta > 0 ? "+" : "") + Math.round(actualDelta);
            const color = actualDelta > 0 ? "#4CAF50" : "#FF4444";
            this.popups.push(new Popup(text, color));
        }
        if (actualDelta < 0 && this.flashOnDamage) {
            this.flashElapsed = 0;
        }
    }
}

class ThunderboltHealthBars {
    constructor(runtime) {
        this.runtime = runtime;
        this.bars = new Map();
        this.canvas = null;
        this.ctx = null;
        this.lastTime = null;
        this._setupCanvas();
        this._loop = this._loop.bind(this);
        requestAnimationFrame(this._loop);
    }

    _setupCanvas() {
        const stageCanvas = this.runtime.renderer.canvas;
        const overlay = document.createElement("canvas");
        overlay.style.position = "absolute";
        overlay.style.pointerEvents = "none";
        overlay.style.zIndex = "13";
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

    _roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    _drawModern(bar, cx, cy, w, h, scale) {
        const ctx = this.ctx;
        const pad = 3 * scale;

        ctx.fillStyle = "rgba(20, 20, 25, 0.7)";
        this._roundRect(ctx, cx - w / 2, cy - h / 2, w, h, h / 2);
        ctx.fill();

        const innerW = (w - pad * 2) * bar.pct;
        if (innerW > 0) {
            const hue = bar.pct * 120;
            const gradient = ctx.createLinearGradient(cx - w / 2, 0, cx + w / 2, 0);
            gradient.addColorStop(0, `hsl(${hue}, 85%, 45%)`);
            gradient.addColorStop(1, `hsl(${hue}, 85%, 60%)`);
            ctx.fillStyle = gradient;
            this._roundRect(ctx, cx - w / 2 + pad, cy - h / 2 + pad, innerW, h - pad * 2, (h - pad * 2) / 2);
            ctx.fill();
        }

        ctx.lineWidth = Math.max(1, 1.5 * scale);
        ctx.strokeStyle = "rgba(255,255,255,0.6)";
        this._roundRect(ctx, cx - w / 2, cy - h / 2, w, h, h / 2);
        ctx.stroke();

        if (bar.flashElapsed < 0.2) {
            ctx.globalAlpha = 1 - bar.flashElapsed / 0.2;
            ctx.fillStyle = "#FFFFFF";
            this._roundRect(ctx, cx - w / 2, cy - h / 2, w, h, h / 2);
            ctx.fill();
            ctx.globalAlpha = 1;
        }
    }

    _drawGem(ctx, x, y, r) {
        ctx.save();
        ctx.translate(x, y);
        ctx.beginPath();
        ctx.moveTo(0, -r);
        ctx.lineTo(r * 0.75, 0);
        ctx.lineTo(0, r);
        ctx.lineTo(-r * 0.75, 0);
        ctx.closePath();
        const grad = ctx.createLinearGradient(0, -r, 0, r);
        grad.addColorStop(0, "#FFF3C4");
        grad.addColorStop(0.5, "#E8B923");
        grad.addColorStop(1, "#8A6210");
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.strokeStyle = "#5C3E08";
        ctx.lineWidth = Math.max(0.5, r * 0.15);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(-r * 0.2, -r * 0.3, r * 0.18, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.fill();
        ctx.restore();
    }

    _drawFinial(ctx, x, y, r) {
        ctx.save();
        const grad = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
        grad.addColorStop(0, "#FFF3C4");
        grad.addColorStop(0.6, "#D4AF37");
        grad.addColorStop(1, "#8A6210");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#5C3E08";
        ctx.lineWidth = Math.max(0.5, r * 0.2);
        ctx.stroke();
        ctx.restore();
    }

    _drawMedieval(bar, cx, cy, w, h, scale) {
        const ctx = this.ctx;
        const border = Math.max(4, 6 * scale);
        const left = cx - w / 2;
        const top = cy - h / 2;

        const goldGrad = ctx.createLinearGradient(0, top - border, 0, top + h + border);
        goldGrad.addColorStop(0, "#FFE68A");
        goldGrad.addColorStop(0.45, "#D4AF37");
        goldGrad.addColorStop(1, "#7A560C");
        ctx.fillStyle = goldGrad;
        ctx.fillRect(left - border, top - border, w + border * 2, h + border * 2);

        const woodInset = border * 0.45;
        ctx.fillStyle = "#2A1608";
        ctx.fillRect(left - woodInset, top - woodInset, w + woodInset * 2, h + woodInset * 2);

        ctx.fillStyle = "#1C120A";
        ctx.fillRect(left, top, w, h);

        const innerW = w * bar.pct;
        if (innerW > 0) {
            const gradient = ctx.createLinearGradient(left, 0, left + innerW, 0);
            gradient.addColorStop(0, "#5A0A0A");
            gradient.addColorStop(1, "#B22222");
            ctx.fillStyle = gradient;
            ctx.fillRect(left, top, innerW, h);

            ctx.fillStyle = "rgba(255,255,255,0.12)";
            ctx.fillRect(left, top, innerW, h * 0.35);
        }

        ctx.strokeStyle = "#E8C766";
        ctx.lineWidth = Math.max(1, scale);
        ctx.strokeRect(left + 0.5, top + 0.5, w - 1, h - 1);

        const gemR = Math.max(2.5, 3.2 * scale);
        const gemCorners = [
            [left - border / 2, top - border / 2],
            [left + w + border / 2, top - border / 2],
            [left - border / 2, top + h + border / 2],
            [left + w + border / 2, top + h + border / 2],
        ];
        for (const [gx, gy] of gemCorners) this._drawGem(ctx, gx, gy, gemR);

        const finialR = Math.max(3, h * 0.32);
        this._drawFinial(ctx, left - border - finialR * 0.5, cy, finialR);
        this._drawFinial(ctx, left + w + border + finialR * 0.5, cy, finialR);

        if (bar.flashElapsed < 0.2) {
            ctx.globalAlpha = (1 - bar.flashElapsed / 0.2) * 0.8;
            ctx.fillStyle = "#FFFFFF";
            ctx.fillRect(left, top, w, h);
            ctx.globalAlpha = 1;
        }
    }

    _drawMinimal(bar, cx, cy, w, h, scale) {
        const ctx = this.ctx;
        const barH = Math.max(3, h * 0.4);
        const left = cx - w / 2;
        const top = cy - barH / 2;

        ctx.fillStyle = "rgba(255,255,255,0.18)";
        this._roundRect(ctx, left, top, w, barH, barH / 2);
        ctx.fill();

        const innerW = w * bar.pct;
        if (innerW > 0) {
            ctx.fillStyle = bar.pct > 0.3 ? "#FFFFFF" : "#FF5C5C";
            this._roundRect(ctx, left, top, Math.max(innerW, barH), barH, barH / 2);
            ctx.fill();
        }

        if (bar.flashElapsed < 0.2) {
            ctx.globalAlpha = 1 - bar.flashElapsed / 0.2;
            ctx.fillStyle = "#FFFFFF";
            this._roundRect(ctx, left, top, w, barH, barH / 2);
            ctx.fill();
            ctx.globalAlpha = 1;
        }
    }

    _drawNeon(bar, cx, cy, w, h, scale) {
        const ctx = this.ctx;
        const left = cx - w / 2;
        const top = cy - h / 2;
        const hue = bar.pct * 120;
        const r = Math.max(2, 4 * scale);

        ctx.fillStyle = "rgba(8, 10, 20, 0.75)";
        this._roundRect(ctx, left, top, w, h, r);
        ctx.fill();

        ctx.save();
        ctx.shadowColor = `hsl(${hue}, 100%, 60%)`;
        ctx.shadowBlur = 10 * scale;
        ctx.strokeStyle = `hsl(${hue}, 100%, 65%)`;
        ctx.lineWidth = Math.max(1.5, 2 * scale);
        this._roundRect(ctx, left, top, w, h, r);
        ctx.stroke();
        ctx.restore();

        const pad = Math.max(2, 2.5 * scale);
        const innerW = (w - pad * 2) * bar.pct;
        if (innerW > 0) {
            ctx.save();
            ctx.shadowColor = `hsl(${hue}, 100%, 70%)`;
            ctx.shadowBlur = 8 * scale;
            const grad = ctx.createLinearGradient(left, 0, left + w, 0);
            grad.addColorStop(0, `hsl(${hue}, 100%, 35%)`);
            grad.addColorStop(1, `hsl(${hue}, 100%, 65%)`);
            ctx.fillStyle = grad;
            this._roundRect(ctx, left + pad, top + pad, innerW, h - pad * 2, Math.max(1, r - pad));
            ctx.fill();
            ctx.restore();
        }

        if (bar.flashElapsed < 0.2) {
            ctx.globalAlpha = 1 - bar.flashElapsed / 0.2;
            ctx.fillStyle = "#FFFFFF";
            this._roundRect(ctx, left, top, w, h, r);
            ctx.fill();
            ctx.globalAlpha = 1;
        }
    }

    _drawPixel(bar, cx, cy, w, h, scale) {
        const ctx = this.ctx;
        const smoothingWasEnabled = ctx.imageSmoothingEnabled;
        ctx.imageSmoothingEnabled = false;

        const left = cx - w / 2;
        const top = cy - h / 2;
        const border = Math.max(2, 3 * scale);

        ctx.fillStyle = "#000000";
        ctx.fillRect(left - border, top - border, w + border * 2, h + border * 2);

        const segments = 10;
        const gap = Math.max(1, scale * 0.8);
        const segW = (w - gap * (segments - 1)) / segments;
        const filledSegments = bar.pct * segments;
        const segColor = bar.pct > 0.5 ? "#4CD137" : bar.pct > 0.25 ? "#F5A623" : "#E74C3C";

        for (let i = 0; i < segments; i++) {
            const segLeft = left + i * (segW + gap);

            ctx.fillStyle = "#241f1f";
            ctx.fillRect(segLeft, top, segW, h);

            const fillAmount = clamp(filledSegments - i, 0, 1);
            if (fillAmount > 0) {
                const fw = segW * fillAmount;
                ctx.fillStyle = segColor;
                ctx.fillRect(segLeft, top, fw, h);

                ctx.fillStyle = "rgba(255,255,255,0.35)";
                ctx.fillRect(segLeft, top, fw, Math.max(1, h * 0.25));
            }
        }

        ctx.imageSmoothingEnabled = smoothingWasEnabled;

        if (bar.flashElapsed < 0.2) {
            ctx.globalAlpha = (1 - bar.flashElapsed / 0.2) * 0.8;
            ctx.fillStyle = "#FFFFFF";
            ctx.fillRect(left, top, w, h);
            ctx.globalAlpha = 1;
        }
    }

    _loop(timestamp) {
        if (this.lastTime === null) this.lastTime = timestamp;
        const dt = Math.min(0.05, (timestamp - this.lastTime) / 1000);
        this.lastTime = timestamp;

        if (!this.canvas || !this.ctx) return;

        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        const scale = this.canvas.width / 480;

        for (const bar of this.bars.values()) {
            if (!bar.visible) continue;
            bar.flashElapsed += dt;

            const { x: cx, y: cy } = this._stageToCanvas(bar.x, bar.y);
            const w = bar.width * scale;
            const h = bar.height * scale;

            switch (bar.style) {
                case "medieval":
                    this._drawMedieval(bar, cx, cy, w, h, scale);
                    break;
                case "minimal":
                    this._drawMinimal(bar, cx, cy, w, h, scale);
                    break;
                case "neon":
                    this._drawNeon(bar, cx, cy, w, h, scale);
                    break;
                case "pixel":
                    this._drawPixel(bar, cx, cy, w, h, scale);
                    break;
                default:
                    this._drawModern(bar, cx, cy, w, h, scale);
                    break;
            }

            if (bar.label) {
                this.ctx.font = `bold ${13 * scale}px Arial`;
                this.ctx.textAlign = "center";
                this.ctx.fillStyle = "#FFFFFF";
                this.ctx.strokeStyle = "rgba(0,0,0,0.8)";
                this.ctx.lineWidth = 3 * scale;
                this.ctx.strokeText(bar.label, cx, cy - h / 2 - 8 * scale);
                this.ctx.fillText(bar.label, cx, cy - h / 2 - 8 * scale);
            }

            bar.popups = bar.popups.filter((p) => {
                p.elapsed += dt;
                if (p.elapsed >= p.duration) return false;
                const progress = p.elapsed / p.duration;
                const riseY = -30 * scale * progress;
                const alpha = 1 - progress;
                this.ctx.globalAlpha = alpha;
                this.ctx.font = `bold ${16 * scale}px Arial`;
                this.ctx.textAlign = "center";
                this.ctx.fillStyle = p.color;
                this.ctx.strokeStyle = "rgba(0,0,0,0.8)";
                this.ctx.lineWidth = 3 * scale;
                const px = cx + p.xJitter * scale;
                const py = cy - h / 2 - 20 * scale + riseY;
                this.ctx.strokeText(p.text, px, py);
                this.ctx.fillText(p.text, px, py);
                this.ctx.globalAlpha = 1;
                return true;
            });
        }

        requestAnimationFrame(this._loop);
    }

    _getBar(id, createIfMissing) {
        if (!this.bars.has(id) && createIfMissing) {
            this.bars.set(id, new HealthBar(id, 0, 0, 100));
        }
        return this.bars.get(id);
    }

    getInfo() {
        return {
            id: "thunderbolthealthbars",
            name: "Thunderbolt Health Bars",
            color1: "#FF4444",
            color2: "#CC3333",
            color3: "#990000",
            menuIconURI: menuIconURI,
            blockIconURI: menuIconURI,
            blocks: [
                {
                    opcode: "createBar",
                    blockType: "command",
                    text: "create health bar [ID] with max health [MAX] at x:[X] y:[Y]",
                    arguments: {
                        ID: { type: "string", defaultValue: "player" },
                        MAX: { type: "number", defaultValue: 100 },
                        X: { type: "number", defaultValue: 0 },
                        Y: { type: "number", defaultValue: 150 },
                    },
                },
                {
                    opcode: "setStyle",
                    blockType: "command",
                    text: "set style of [ID] to [STYLE]",
                    arguments: {
                        ID: { type: "string", defaultValue: "player" },
                        STYLE: { type: "string", menu: "styles", defaultValue: "modern" },
                    },
                },
                {
                    opcode: "setPosition",
                    blockType: "command",
                    text: "set position of [ID] to x:[X] y:[Y]",
                    arguments: {
                        ID: { type: "string", defaultValue: "player" },
                        X: { type: "number", defaultValue: 0 },
                        Y: { type: "number", defaultValue: 150 },
                    },
                },
                {
                    opcode: "setSize",
                    blockType: "command",
                    text: "set size of [ID] to width [W] height [H]",
                    arguments: {
                        ID: { type: "string", defaultValue: "player" },
                        W: { type: "number", defaultValue: 120 },
                        H: { type: "number", defaultValue: 18 },
                    },
                },
                {
                    opcode: "setLabel",
                    blockType: "command",
                    text: "set label of [ID] to [LABEL]",
                    arguments: {
                        ID: { type: "string", defaultValue: "player" },
                        LABEL: { type: "string", defaultValue: "Boss" },
                    },
                },
                "---",
                {
                    opcode: "setHealth",
                    blockType: "command",
                    text: "set health of [ID] to [VALUE]",
                    arguments: {
                        ID: { type: "string", defaultValue: "player" },
                        VALUE: { type: "number", defaultValue: 100 },
                    },
                },
                {
                    opcode: "changeHealth",
                    blockType: "command",
                    text: "change health of [ID] by [VALUE]",
                    arguments: {
                        ID: { type: "string", defaultValue: "player" },
                        VALUE: { type: "number", defaultValue: -10 },
                    },
                },
                {
                    opcode: "setMaxHealth",
                    blockType: "command",
                    text: "set max health of [ID] to [MAX]",
                    arguments: {
                        ID: { type: "string", defaultValue: "player" },
                        MAX: { type: "number", defaultValue: 100 },
                    },
                },
                {
                    opcode: "health",
                    blockType: "reporter",
                    text: "health of [ID]",
                    arguments: {
                        ID: { type: "string", defaultValue: "player" },
                    },
                },
                {
                    opcode: "maxHealth",
                    blockType: "reporter",
                    text: "max health of [ID]",
                    arguments: {
                        ID: { type: "string", defaultValue: "player" },
                    },
                },
                {
                    opcode: "healthPercent",
                    blockType: "reporter",
                    text: "health percent of [ID]",
                    arguments: {
                        ID: { type: "string", defaultValue: "player" },
                    },
                },
                {
                    opcode: "isDead",
                    blockType: "Boolean",
                    text: "is [ID] dead?",
                    arguments: {
                        ID: { type: "string", defaultValue: "player" },
                    },
                },
                "---",
                {
                    opcode: "setDamageNumbers",
                    blockType: "command",
                    text: "turn damage numbers [ONOFF] for [ID]",
                    arguments: {
                        ID: { type: "string", defaultValue: "player" },
                        ONOFF: { type: "string", menu: "onOff", defaultValue: "on" },
                    },
                },
                {
                    opcode: "setFlashOnDamage",
                    blockType: "command",
                    text: "turn flash on damage [ONOFF] for [ID]",
                    arguments: {
                        ID: { type: "string", defaultValue: "player" },
                        ONOFF: { type: "string", menu: "onOff", defaultValue: "on" },
                    },
                },
                {
                    opcode: "showBar",
                    blockType: "command",
                    text: "show health bar [ID]",
                    arguments: {
                        ID: { type: "string", defaultValue: "player" },
                    },
                },
                {
                    opcode: "hideBar",
                    blockType: "command",
                    text: "hide health bar [ID]",
                    arguments: {
                        ID: { type: "string", defaultValue: "player" },
                    },
                },
                {
                    opcode: "deleteBar",
                    blockType: "command",
                    text: "delete health bar [ID]",
                    arguments: {
                        ID: { type: "string", defaultValue: "player" },
                    },
                },
            ],
            menus: {
                onOff: { acceptReporters: false, items: ["on", "off"] },
                styles: { acceptReporters: false, items: ["modern", "medieval", "minimal", "neon", "pixel"] },
            },
        };
    }

    createBar(args) {
        const bar = new HealthBar(args.ID, Number(args.X), Number(args.Y), Number(args.MAX));
        this.bars.set(args.ID, bar);
    }

    setStyle(args) {
        this._getBar(args.ID, true).style = args.STYLE;
    }

    setPosition(args) {
        const bar = this._getBar(args.ID, true);
        bar.x = Number(args.X);
        bar.y = Number(args.Y);
    }

    setSize(args) {
        const bar = this._getBar(args.ID, true);
        bar.width = Number(args.W);
        bar.height = Number(args.H);
    }

    setLabel(args) {
        this._getBar(args.ID, true).label = args.LABEL;
    }

    setHealth(args) {
        const bar = this._getBar(args.ID, true);
        bar.health = clamp(Number(args.VALUE), 0, bar.maxHealth);
    }

    changeHealth(args) {
        const bar = this._getBar(args.ID, true);
        bar.changeHealth(Number(args.VALUE));
    }

    setMaxHealth(args) {
        const bar = this._getBar(args.ID, true);
        bar.maxHealth = Math.max(1, Number(args.MAX));
        bar.health = clamp(bar.health, 0, bar.maxHealth);
    }

    health(args) {
        const bar = this._getBar(args.ID, false);
        return bar ? bar.health : 0;
    }

    maxHealth(args) {
        const bar = this._getBar(args.ID, false);
        return bar ? bar.maxHealth : 0;
    }

    healthPercent(args) {
        const bar = this._getBar(args.ID, false);
        return bar ? Math.round(bar.pct * 100) : 0;
    }

    isDead(args) {
        const bar = this._getBar(args.ID, false);
        return bar ? bar.health <= 0 : false;
    }

    setDamageNumbers(args) {
        this._getBar(args.ID, true).showDamageNumbers = args.ONOFF === "on";
    }

    setFlashOnDamage(args) {
        this._getBar(args.ID, true).flashOnDamage = args.ONOFF === "on";
    }

    showBar(args) {
        this._getBar(args.ID, true).visible = true;
    }

    hideBar(args) {
        this._getBar(args.ID, true).visible = false;
    }

    deleteBar(args) {
        this.bars.delete(args.ID);
    }
}

export default ThunderboltHealthBars;
