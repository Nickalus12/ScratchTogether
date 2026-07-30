/* Stroke-level merging for simultaneous costume painting.
 *
 * SVG: scratch-paint exports are structurally stable —
 *   <svg w h viewBox="0,0,w,h"><g transform="translate(-ox,-oy)"><g layer>…paths…</g></g></svg>
 * with absolute path coordinates (the translate wrapper absorbs canvas growth)
 * and deterministic paper.js serialization. So concurrent edits can be merged
 * per-stroke: diff the sender's previous export against their new one (leaf
 * elements by content signature), then replay the adds/removes onto the
 * receiver's current costume. Anything unexpected falls back to full replace.
 *
 * Bitmap: diff the changed-pixel bounding rect + mask; the receiver composites
 * exactly those pixels onto their current bitmap. Disjoint brush areas merge
 * perfectly; overlapping pixels are last-write-wins.
 */

export const hashStr = s => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = (((h << 5) + h) + s.charCodeAt(i)) | 0;
    return String(h);
};

const LEAF_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'image', 'use']);
const STYLE_ATTRS = [
    'fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linecap',
    'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset',
    'stroke-opacity', 'opacity', 'font-family', 'font-size', 'font-weight', 'style'
];
const MAX_DELTA_OPS = 200;

const parseSvg = text => {
    try {
        const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
        if (doc.querySelector('parsererror')) return null;
        return doc;
    } catch (e) {
        return null;
    }
};

const serialize = el => new XMLSerializer().serializeToString(el);

const styleOf = (el, parentStyle) => {
    let style = parentStyle;
    let copied = false;
    for (const a of STYLE_ATTRS) {
        const v = el.getAttribute(a);
        if (v !== null) {
            if (!copied) {
                style = Object.assign({}, parentStyle);
                copied = true;
            }
            style[a] = v;
        }
    }
    return style;
};

const styleSig = style => {
    const keys = Object.keys(style).sort();
    let out = '';
    for (const k of keys) out += `${k}=${style[k]};`;
    return out;
};

/** Depth-first leaves with their effective inherited style. */
const collectLeaves = svgEl => {
    const leaves = [];
    const walk = (el, parentStyle) => {
        const tag = el.tagName ? el.tagName.toLowerCase() : '';
        if (tag === 'defs') return;
        const style = styleOf(el, parentStyle);
        if (LEAF_TAGS.has(tag)) {
            leaves.push({el, style, sig: `${serialize(el)}|${styleSig(style)}`});
            return;
        }
        for (const child of el.children) walk(child, style);
    };
    for (const child of svgEl.children) walk(child, {});
    return leaves;
};

const countBySig = leaves => {
    const m = new Map();
    for (const l of leaves) m.set(l.sig, (m.get(l.sig) || 0) + 1);
    return m;
};

/** Diff two exports of the same costume into stroke-level adds/removes.
 *  Returns null when the delta is degenerate (fall back to full replace). */
export const diffSvg = (prevText, newText) => {
    const prevDoc = parseSvg(prevText);
    const newDoc = parseSvg(newText);
    if (!prevDoc || !newDoc) return null;
    const prevLeaves = collectLeaves(prevDoc.documentElement);
    const newLeaves = collectLeaves(newDoc.documentElement);
    const pc = countBySig(prevLeaves);
    const nc = countBySig(newLeaves);
    const adds = [];
    const removes = [];
    const consumed = new Map();
    for (const leaf of newLeaves) {
        const surplus = (nc.get(leaf.sig) || 0) - (pc.get(leaf.sig) || 0);
        if (surplus <= 0) continue;
        const used = consumed.get(leaf.sig) || 0;
        if (used < surplus) {
            adds.push({el: serialize(leaf.el), style: leaf.style});
            consumed.set(leaf.sig, used + 1);
        }
    }
    for (const [sig, n] of pc) {
        const gone = n - (nc.get(sig) || 0);
        if (gone > 0) removes.push([sig, gone]);
    }
    if (adds.length + removes.length > MAX_DELTA_OPS) return null;
    return {adds, removes};
};

/** Geometry of a scratch-paint export: absolute origin + size. */
const exportGeometry = svgEl => {
    const w = parseFloat(svgEl.getAttribute('width'));
    const h = parseFloat(svgEl.getAttribute('height'));
    const wrapper = svgEl.querySelector(':scope > g');
    if (!wrapper || !Number.isFinite(w) || !Number.isFinite(h)) return null;
    const m = /translate\(\s*(-?[\d.eE+]+)\s*[, ]\s*(-?[\d.eE+]+)\s*\)/.exec(wrapper.getAttribute('transform') || '');
    if (!m) return null;
    return {ox: -parseFloat(m[1]), oy: -parseFloat(m[2]), w, h, wrapper};
};

const NS = 'http://www.w3.org/2000/svg';

/** Merge a sender's stroke delta into the receiver's current costume SVG.
 *  centers are the receiver's current rotation center (viewBox-relative).
 *  Returns {svg, rotationCenterX, rotationCenterY} or null (caller falls back). */
export const mergeSvg = (currentText, incomingFullText, delta, centerX, centerY) => {
    const curDoc = parseSvg(currentText);
    const incDoc = parseSvg(incomingFullText);
    if (!curDoc || !incDoc || !delta) return null;
    const cur = exportGeometry(curDoc.documentElement);
    const inc = exportGeometry(incDoc.documentElement);
    if (!cur || !inc) return null;

    // Removes: erase matching leaves (multiset) from the current tree. Track
    // what remains so adds can dedup against it.
    const presentSigs = new Set();
    const budget = new Map(delta.removes);
    for (const leaf of collectLeaves(curDoc.documentElement)) {
        const left = budget.get(leaf.sig);
        if (left > 0) {
            leaf.el.remove();
            budget.set(leaf.sig, left - 1);
        } else {
            presentSigs.add(leaf.sig);
        }
    }

    // Adds: append each new stroke (with its effective style wrapped around it)
    // into the receiver's painting layer, keeping absolute coordinates.
    let layer = null;
    for (const g of cur.wrapper.children) {
        if ((g.getAttribute('data-paper-data') || '').includes('isPaintingLayer')) layer = g;
    }
    const host = layer || cur.wrapper;
    for (const add of delta.adds) {
        const frag = parseSvg(`<svg xmlns="${NS}" xmlns:xlink="http://www.w3.org/1999/xlink">${add.el}</svg>`);
        if (!frag || !frag.documentElement.firstElementChild) return null;
        // Dedup: an identical stroke already present means we've seen this add
        // (serializer drift can echo strokes) — never double-draw it.
        const addSig = `${add.el}|${styleSig(add.style || {})}`;
        if (presentSigs.has(addSig)) continue;
        presentSigs.add(addSig);
        const el = curDoc.importNode(frag.documentElement.firstElementChild, true);
        const styleKeys = Object.keys(add.style || {});
        if (styleKeys.length) {
            const wrap = curDoc.createElementNS(NS, 'g');
            for (const k of styleKeys) {
                if (el.getAttribute(k) === null) wrap.setAttribute(k, add.style[k]);
            }
            wrap.appendChild(el);
            host.appendChild(wrap);
        } else {
            host.appendChild(el);
        }
    }

    // Union canvas: keep every absolute coordinate valid, grow the crop box.
    const minX = Math.min(cur.ox, inc.ox);
    const minY = Math.min(cur.oy, inc.oy);
    const maxX = Math.max(cur.ox + cur.w, inc.ox + inc.w);
    const maxY = Math.max(cur.oy + cur.h, inc.oy + inc.h);
    const W = maxX - minX;
    const H = maxY - minY;
    const svgEl = curDoc.documentElement;
    cur.wrapper.setAttribute('transform', `translate(${-minX},${-minY})`);
    svgEl.setAttribute('width', String(W));
    svgEl.setAttribute('height', String(H));
    svgEl.setAttribute('viewBox', `0,0,${W},${H}`);

    // Preserve the receiver's absolute rotation center through the re-crop.
    const absCX = cur.ox + (Number.isFinite(centerX) ? centerX : cur.w / 2);
    const absCY = cur.oy + (Number.isFinite(centerY) ? centerY : cur.h / 2);
    return {
        svg: serialize(svgEl),
        rotationCenterX: absCX - minX,
        rotationCenterY: absCY - minY
    };
};

// ------------------------------------------------------------------ bitmap ---

/** Changed-pixel bounding rect between two same-size RGBA buffers.
 *  Returns {px, py, pw, ph, patch: ImageData, mask: Uint8ClampedArray} or null. */
export const diffBitmap = (prevPixels, nextPixels, width, height) => {
    if (!prevPixels || prevPixels.length !== nextPixels.length) return null;
    const prev32 = new Uint32Array(prevPixels.buffer, prevPixels.byteOffset, width * height);
    const next32 = new Uint32Array(nextPixels.buffer, nextPixels.byteOffset, width * height);
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y++) {
        const row = y * width;
        for (let x = 0; x < width; x++) {
            if (prev32[row + x] !== next32[row + x]) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }
    if (maxX < 0) return null; // identical
    const pw = (maxX - minX) + 1;
    const ph = (maxY - minY) + 1;
    const patch = new ImageData(pw, ph);
    const patch32 = new Uint32Array(patch.data.buffer);
    const mask = new Uint8ClampedArray(pw * ph);
    for (let y = 0; y < ph; y++) {
        const srcRow = (minY + y) * width;
        const dstRow = y * pw;
        for (let x = 0; x < pw; x++) {
            const src = srcRow + minX + x;
            patch32[dstRow + x] = next32[src];
            if (prev32[src] !== next32[src]) mask[dstRow + x] = 255;
        }
    }
    return {px: minX, py: minY, pw, ph, patch, mask};
};

/** Copy masked patch pixels onto base (in place). Buffers are RGBA. */
export const compositePatch = (basePixels, baseWidth, patchPixels, maskAlpha, px, py, pw, ph) => {
    const base32 = new Uint32Array(basePixels.buffer, basePixels.byteOffset, basePixels.length / 4);
    const patch32 = new Uint32Array(patchPixels.buffer, patchPixels.byteOffset, patchPixels.length / 4);
    for (let y = 0; y < ph; y++) {
        const srcRow = y * pw;
        const dstRow = ((py + y) * baseWidth) + px;
        for (let x = 0; x < pw; x++) {
            if (maskAlpha[srcRow + x] > 127) base32[dstRow + x] = patch32[srcRow + x];
        }
    }
};

export default {hashStr, diffSvg, mergeSvg, diffBitmap, compositePatch};
