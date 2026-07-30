const menuIconURI = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCIgdmlld0JveD0iMCAwIDQwIDQwIj48cmVjdCB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHJ4PSI4IiBmaWxsPSIjRkY2NjgwIi8+PHBhdGggZD0iTTEyIDEyaDE2djEyaC0xNnYtMTJ6TTggMjBoMnY0aC0ydi00ek0zMCAyMGgydjRoLTJ2LTR6IiBmaWxsPSIjZmZmIi8+PC9zdmc+';

const clamp01 = (n) => Math.max(0, Math.min(1, n));
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

class ThunderboltVFX {
    constructor(runtime) {
        this.runtime = runtime;
        this.stageCanvas = runtime.renderer.canvas;
        this.overlay = null;
        this.ctx = null;
        this.lastTime = null;

        this.shake = { elapsed: 0, duration: 0, intensity: 0 };
        this.zoom = { elapsed: 0, duration: 0, amount: 0 };
        this.tilt = { from: 0, to: 0, elapsed: 0, duration: 0, current: 0 };
        this.flash = { r: 255, g: 255, b: 255, elapsed: 0, duration: 0 };
        this.vignette = { elapsed: 0, duration: 0, intensity: 0 };

        this._setupOverlay();
        this._loop = this._loop.bind(this);
        requestAnimationFrame(this._loop);
    }

    _setupOverlay() {
        const stageCanvas = this.stageCanvas;
        const overlay = document.createElement("canvas");
        overlay.style.position = "absolute";
        overlay.style.pointerEvents = "none";
        overlay.style.zIndex = "11";
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

        this.overlay = overlay;
        this.ctx = overlay.getContext("2d");

        stageCanvas.style.transformOrigin = "center center";
    }

    _loop(timestamp) {
        if (this.lastTime === null) this.lastTime = timestamp;
        const dt = Math.min(0.05, (timestamp - this.lastTime) / 1000);
        this.lastTime = timestamp;

        let shakeX = 0;
        let shakeY = 0;
        let zoomScale = 1;
        let tiltDeg = this.tilt.current;

        if (this.shake.elapsed < this.shake.duration) {
            this.shake.elapsed += dt;
            const falloff = 1 - this.shake.elapsed / this.shake.duration;
            shakeX = (Math.random() * 2 - 1) * this.shake.intensity * falloff;
            shakeY = (Math.random() * 2 - 1) * this.shake.intensity * falloff;
        }

        if (this.zoom.elapsed < this.zoom.duration) {
            this.zoom.elapsed += dt;
            const progress = clamp01(this.zoom.elapsed / this.zoom.duration);
            zoomScale = 1 + this.zoom.amount * Math.sin(Math.PI * progress);
        }

        if (this.tilt.elapsed < this.tilt.duration) {
            this.tilt.elapsed += dt;
            const progress = clamp01(this.tilt.elapsed / this.tilt.duration);
            const eased = easeOutCubic(progress);
            this.tilt.current = this.tilt.from + (this.tilt.to - this.tilt.from) * eased;
            tiltDeg = this.tilt.current;
        }

        if (this.stageCanvas) {
            this.stageCanvas.style.transform =
                `translate(${shakeX}px, ${shakeY}px) scale(${zoomScale}) rotate(${tiltDeg}deg)`;
        }

        if (!this.overlay || !this.ctx) return;

        this.ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
        const w = this.overlay.width;
        const h = this.overlay.height;

        if (this.flash.elapsed < this.flash.duration) {
            this.flash.elapsed += dt;
            const progress = clamp01(this.flash.elapsed / this.flash.duration);
            const alpha = 1 - progress;
            this.ctx.fillStyle = `rgba(${this.flash.r}, ${this.flash.g}, ${this.flash.b}, ${alpha})`;
            this.ctx.fillRect(0, 0, w, h);
        }

        if (this.vignette.elapsed < this.vignette.duration) {
            this.vignette.elapsed += dt;
            const progress = clamp01(this.vignette.elapsed / this.vignette.duration);
            const pulse = Math.sin(Math.PI * progress);
            const alpha = this.vignette.intensity * pulse;
            const gradient = this.ctx.createRadialGradient(
                w / 2, h / 2, h * 0.25,
                w / 2, h / 2, h * 0.75
            );
            gradient.addColorStop(0, "rgba(0,0,0,0)");
            gradient.addColorStop(1, `rgba(0,0,0,${alpha})`);
            this.ctx.fillStyle = gradient;
            this.ctx.fillRect(0, 0, w, h);
        }

        requestAnimationFrame(this._loop);
    }

    _hexToRgb(hex) {
        const clean = hex.replace("#", "");
        const bigint = parseInt(clean, 16);
        return {
            r: (bigint >> 16) & 255,
            g: (bigint >> 8) & 255,
            b: bigint & 255,
        };
    }

    getInfo() {
        return {
            id: "thunderboltvfx",
            name: "Thunderbolt VFX",
            color1: "#FF6680",
            color2: "#E6415C",
            color3: "#CC2244",
            menuIconURI: menuIconURI,
            blockIconURI: menuIconURI,
            blocks: [
                {
                    opcode: "impactFrame",
                    blockType: "command",
                    text: "impact frame! flash [COLOR] zoom [ZOOM] shake [SHAKE] duration [DURATION]",
                    arguments: {
                        COLOR: { type: "color", defaultValue: "#FFFFFF" },
                        ZOOM: { type: "number", defaultValue: 0.15 },
                        SHAKE: { type: "number", defaultValue: 12 },
                        DURATION: { type: "number", defaultValue: 0.25 },
                    },
                },
                "---",
                {
                    opcode: "screenFlash",
                    blockType: "command",
                    text: "screen flash [COLOR] for [DURATION] seconds",
                    arguments: {
                        COLOR: { type: "color", defaultValue: "#FFFFFF" },
                        DURATION: { type: "number", defaultValue: 0.3 },
                    },
                },
                {
                    opcode: "zoomPunch",
                    blockType: "command",
                    text: "zoom punch by [AMOUNT] over [DURATION] seconds",
                    arguments: {
                        AMOUNT: { type: "number", defaultValue: 0.2 },
                        DURATION: { type: "number", defaultValue: 0.3 },
                    },
                },
                {
                    opcode: "shakeScreen",
                    blockType: "command",
                    text: "shake screen for [DURATION] seconds with intensity [INTENSITY]",
                    arguments: {
                        DURATION: { type: "number", defaultValue: 0.5 },
                        INTENSITY: { type: "number", defaultValue: 10 },
                    },
                },
                {
                    opcode: "tiltCamera",
                    blockType: "command",
                    text: "tilt camera to [DEGREES] degrees over [DURATION] seconds",
                    arguments: {
                        DEGREES: { type: "number", defaultValue: 5 },
                        DURATION: { type: "number", defaultValue: 0.4 },
                    },
                },
                {
                    opcode: "vignettePulse",
                    blockType: "command",
                    text: "vignette pulse intensity [INTENSITY] over [DURATION] seconds",
                    arguments: {
                        INTENSITY: { type: "number", defaultValue: 0.6 },
                        DURATION: { type: "number", defaultValue: 0.6 },
                    },
                },
                "---",
                {
                    opcode: "resetCamera",
                    blockType: "command",
                    text: "reset camera",
                },
            ],
        };
    }

    impactFrame(args) {
        const { r, g, b } = this._hexToRgb(args.COLOR);
        const duration = Math.max(0.01, Number(args.DURATION));
        this.flash = { r, g, b, elapsed: 0, duration: duration * 0.6 };
        this.zoom = { elapsed: 0, duration, amount: Number(args.ZOOM) };
        this.shake = { elapsed: 0, duration, intensity: Number(args.SHAKE) };
    }

    screenFlash(args) {
        const { r, g, b } = this._hexToRgb(args.COLOR);
        this.flash = { r, g, b, elapsed: 0, duration: Math.max(0.01, Number(args.DURATION)) };
    }

    zoomPunch(args) {
        this.zoom = {
            elapsed: 0,
            duration: Math.max(0.01, Number(args.DURATION)),
            amount: Number(args.AMOUNT),
        };
    }

    shakeScreen(args) {
        this.shake = {
            elapsed: 0,
            duration: Math.max(0.01, Number(args.DURATION)),
            intensity: Math.max(0, Number(args.INTENSITY)),
        };
    }

    tiltCamera(args) {
        this.tilt = {
            from: this.tilt.current,
            to: Number(args.DEGREES),
            elapsed: 0,
            duration: Math.max(0.01, Number(args.DURATION)),
            current: this.tilt.current,
        };
    }

    vignettePulse(args) {
        this.vignette = {
            elapsed: 0,
            duration: Math.max(0.01, Number(args.DURATION)),
            intensity: clamp01(Number(args.INTENSITY)),
        };
    }

    resetCamera() {
        this.shake = { elapsed: 0, duration: 0, intensity: 0 };
        this.zoom = { elapsed: 0, duration: 0, amount: 0 };
        this.tilt = { from: 0, to: 0, elapsed: 0, duration: 0, current: 0 };
        this.flash = { r: 255, g: 255, b: 255, elapsed: 0, duration: 0 };
        this.vignette = { elapsed: 0, duration: 0, intensity: 0 };
        if (this.stageCanvas) this.stageCanvas.style.transform = "";
    }
}

export default ThunderboltVFX;
