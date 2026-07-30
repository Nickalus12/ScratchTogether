const menuIconURI = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCIgdmlld0JveD0iMCAwIDQwIDQwIj48cmVjdCB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHJ4PSI4IiBmaWxsPSIjRkZENTAwIi8+PHBhdGggZD0iTTIwIDEybDEuNSAzLjVsMy41IDEuNWwtMy41IDEuNWwtMS41IDMuNWwtMS41LTMuNWwtMy41LTEuNWwzLjUtMS41bDEuNS0zLjV6IiBmaWxsPSIjZmZmIi8+PC9zdmc+';

class Particle {
    constructor(x, y, vx, vy, size, color, life, gravity, fade, shape, trail) {
        this.x = x;
        this.y = y;
        this.vx = vx;
        this.vy = vy;
        this.size = size;
        this.color = color;
        this.life = life;
        this.maxLife = life;
        this.gravity = gravity;
        this.fade = fade;
        this.shape = shape;
        this.trailEnabled = trail;
        this.history = [];
    }

    update(dt, trailLength) {
        if (this.trailEnabled) {
            this.history.push({ x: this.x, y: this.y });
            if (this.history.length > trailLength) this.history.shift();
        }
        this.vy += this.gravity * dt;
        this.x += this.vx * dt;
        this.y += this.vy * dt;
        this.life -= dt;
        return this.life > 0;
    }

    get alpha() {
        if (!this.fade) return 1;
        return Math.max(0, this.life / this.maxLife);
    }
}

class ParticleSystem {
    constructor(id) {
        this.id = id;
        this.particles = [];
        this.gravity = 200;
        this.running = true;
        this.shape = "circle";
        this.trailEnabled = false;
        this.trailLength = 8;
    }

    emit(count, x, y, color, size, speed, lifetime, spread) {
        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2 * (spread / 360);
            const baseAngle = -Math.PI / 2 - (Math.PI * (spread / 360));
            const finalAngle = baseAngle + angle;
            const s = speed * (0.5 + Math.random() * 0.5);
            const vx = Math.cos(finalAngle) * s;
            const vy = Math.sin(finalAngle) * s;
            this.particles.push(
                new Particle(
                    x, y, vx, vy, size, color, lifetime, this.gravity, true,
                    this.shape, this.trailEnabled
                )
            );
        }
    }

    update(dt) {
        if (!this.running) return;
        this.particles = this.particles.filter((p) => p.update(dt, this.trailLength));
    }

    clear() {
        this.particles = [];
    }
}

class ThunderboltSystem {
    constructor(runtime) {
        this.runtime = runtime;
        this.systems = new Map();
        this.canvas = null;
        this.ctx = null;
        this.lastTime = null;
        this.shakeDuration = 0;
        this.shakeIntensity = 0;
        this.shakeElapsed = 0;
        this._setupCanvas();
        this._loop = this._loop.bind(this);
        requestAnimationFrame(this._loop);
    }

    _setupCanvas() {
        const stageCanvas = this.runtime.renderer.canvas;
        const overlay = document.createElement("canvas");
        overlay.style.position = "absolute";
        overlay.style.pointerEvents = "none";
        overlay.style.zIndex = "10";
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

    _drawShape(ctx, shape, x, y, size) {
        switch (shape) {
            case "square":
                ctx.beginPath();
                ctx.rect(x - size, y - size, size * 2, size * 2);
                ctx.fill();
                break;
            case "triangle":
                ctx.beginPath();
                ctx.moveTo(x, y - size);
                ctx.lineTo(x - size, y + size);
                ctx.lineTo(x + size, y + size);
                ctx.closePath();
                ctx.fill();
                break;
            case "star": {
                const spikes = 5;
                const outerR = size;
                const innerR = size / 2.5;
                let rot = (Math.PI / 2) * 3;
                const step = Math.PI / spikes;
                ctx.beginPath();
                ctx.moveTo(x, y - outerR);
                for (let i = 0; i < spikes; i++) {
                    let sx = x + Math.cos(rot) * outerR;
                    let sy = y + Math.sin(rot) * outerR;
                    ctx.lineTo(sx, sy);
                    rot += step;
                    sx = x + Math.cos(rot) * innerR;
                    sy = y + Math.sin(rot) * innerR;
                    ctx.lineTo(sx, sy);
                    rot += step;
                }
                ctx.closePath();
                ctx.fill();
                break;
            }
            case "circle":
            default:
                ctx.beginPath();
                ctx.arc(x, y, size, 0, Math.PI * 2);
                ctx.fill();
                break;
        }
    }

    _loop(timestamp) {
        if (this.lastTime === null) this.lastTime = timestamp;
        const dt = Math.min(0.05, (timestamp - this.lastTime) / 1000);
        this.lastTime = timestamp;

        if (!this.canvas || !this.ctx) return;

        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        this.ctx.save();

        if (this.shakeElapsed < this.shakeDuration) {
            this.shakeElapsed += dt;
            const falloff = 1 - this.shakeElapsed / this.shakeDuration;
            const dx = (Math.random() * 2 - 1) * this.shakeIntensity * falloff;
            const dy = (Math.random() * 2 - 1) * this.shakeIntensity * falloff;
            this.ctx.translate(dx, dy);
        }

        const scale = this.canvas.width / 480;

        for (const system of this.systems.values()) {
            system.update(dt);
            for (const p of system.particles) {
                const { x, y } = this._stageToCanvas(p.x, p.y);
                const drawSize = Math.max(1, p.size * scale);

                if (p.trailEnabled && p.history.length > 1) {
                    for (let i = 0; i < p.history.length; i++) {
                        const pt = this._stageToCanvas(p.history[i].x, p.history[i].y);
                        const trailAlpha = p.alpha * ((i + 1) / p.history.length) * 0.5;
                        this.ctx.globalAlpha = trailAlpha;
                        this.ctx.fillStyle = p.color;
                        this._drawShape(this.ctx, p.shape, pt.x, pt.y, drawSize * 0.6);
                    }
                }

                this.ctx.globalAlpha = p.alpha;
                this.ctx.fillStyle = p.color;
                this._drawShape(this.ctx, p.shape, x, y, drawSize);
            }
        }
        this.ctx.globalAlpha = 1;
        this.ctx.restore();

        requestAnimationFrame(this._loop);
    }

    _getSystem(id) {
        if (!this.systems.has(id)) {
            this.systems.set(id, new ParticleSystem(id));
        }
        return this.systems.get(id);
    }

    getInfo() {
        return {
            id: "thunderboltparticlesystem",
            name: "Thunderbolt Particles",
            color1: "#FFD500",
            color2: "#E6C200",
            color3: "#CCAA00",
            menuIconURI: menuIconURI,
            blockIconURI: menuIconURI,
            blocks: [
                {
                    opcode: "createSystem",
                    blockType: "command",
                    text: "create particle system [ID]",
                    arguments: {
                        ID: { type: "string", defaultValue: "sparkles" },
                    },
                },
                {
                    opcode: "emit",
                    blockType: "command",
                    text: "emit [COUNT] particles at x:[X] y:[Y] color [COLOR] size [SIZE] speed [SPEED] lifetime [LIFE] spread [SPREAD] in [ID]",
                    arguments: {
                        COUNT: { type: "number", defaultValue: 10 },
                        X: { type: "number", defaultValue: 0 },
                        Y: { type: "number", defaultValue: 0 },
                        COLOR: { type: "color", defaultValue: "#FFD500" },
                        SIZE: { type: "number", defaultValue: 5 },
                        SPEED: { type: "number", defaultValue: 100 },
                        LIFE: { type: "number", defaultValue: 1 },
                        SPREAD: { type: "number", defaultValue: 360 },
                        ID: { type: "string", defaultValue: "sparkles" },
                    },
                },
                {
                    opcode: "setShape",
                    blockType: "command",
                    text: "set particle shape to [SHAPE] for [ID]",
                    arguments: {
                        SHAPE: { type: "string", menu: "shapes", defaultValue: "circle" },
                        ID: { type: "string", defaultValue: "sparkles" },
                    },
                },
                {
                    opcode: "setTrail",
                    blockType: "command",
                    text: "set trail [TRAIL] with length [LENGTH] for [ID]",
                    arguments: {
                        TRAIL: { type: "string", menu: "onOff", defaultValue: "on" },
                        LENGTH: { type: "number", defaultValue: 8 },
                        ID: { type: "string", defaultValue: "sparkles" },
                    },
                },
                {
                    opcode: "setGravity",
                    blockType: "command",
                    text: "set gravity to [GRAVITY] for [ID]",
                    arguments: {
                        GRAVITY: { type: "number", defaultValue: 200 },
                        ID: { type: "string", defaultValue: "sparkles" },
                    },
                },
                {
                    opcode: "setRunning",
                    blockType: "command",
                    text: "set [ID] running [RUNNING]",
                    arguments: {
                        ID: { type: "string", defaultValue: "sparkles" },
                        RUNNING: {
                            type: "string",
                            menu: "onOff",
                            defaultValue: "on",
                        },
                    },
                },
                {
                    opcode: "clearSystem",
                    blockType: "command",
                    text: "clear particles in [ID]",
                    arguments: {
                        ID: { type: "string", defaultValue: "sparkles" },
                    },
                },
                {
                    opcode: "particleCount",
                    blockType: "reporter",
                    text: "particle count in [ID]",
                    arguments: {
                        ID: { type: "string", defaultValue: "sparkles" },
                    },
                },
                "---",
                {
                    opcode: "shakeScreen",
                    blockType: "command",
                    text: "shake screen for [DURATION] seconds with intensity [INTENSITY]",
                    arguments: {
                        DURATION: { type: "number", defaultValue: 0.5 },
                        INTENSITY: { type: "number", defaultValue: 10 },
                    },
                },
            ],
            menus: {
                onOff: {
                    acceptReporters: false,
                    items: ["on", "off"],
                },
                shapes: {
                    acceptReporters: false,
                    items: ["circle", "square", "triangle", "star"],
                },
            },
        };
    }

    createSystem(args) {
        this._getSystem(args.ID);
    }

    emit(args) {
        const system = this._getSystem(args.ID);
        system.emit(
            Math.max(0, Math.round(args.COUNT)),
            Number(args.X),
            Number(args.Y),
            args.COLOR,
            Number(args.SIZE),
            Number(args.SPEED),
            Number(args.LIFE),
            Number(args.SPREAD)
        );
    }

    setShape(args) {
        const system = this._getSystem(args.ID);
        system.shape = args.SHAPE;
    }

    setTrail(args) {
        const system = this._getSystem(args.ID);
        system.trailEnabled = args.TRAIL === "on";
        system.trailLength = Math.max(1, Math.round(Number(args.LENGTH)));
    }

    setGravity(args) {
        const system = this._getSystem(args.ID);
        system.gravity = Number(args.GRAVITY);
    }

    setRunning(args) {
        const system = this._getSystem(args.ID);
        system.running = args.RUNNING === "on";
    }

    clearSystem(args) {
        const system = this._getSystem(args.ID);
        system.clear();
    }

    particleCount(args) {
        const system = this._getSystem(args.ID);
        return system.particles.length;
    }

    shakeScreen(args) {
        this.shakeDuration = Math.max(0, Number(args.DURATION));
        this.shakeIntensity = Math.max(0, Number(args.INTENSITY));
        this.shakeElapsed = 0;
    }
}

export default ThunderboltSystem;
