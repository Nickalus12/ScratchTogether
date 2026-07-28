/* Renders annotations on workspace comments.
 *
 * Everything here is a wrapper around scratch-blocks' own comment methods, so
 * an un-annotated comment behaves exactly as it always did. The text on disk
 * stays the single source of truth — nothing is cached on the comment object,
 * because `content_` is what collab and .sb3 round-trip and anything else
 * would drift from it. */

import {TYPES, compose, isSection, parse, summarize, typeInfo} from './index';

const HEADER_CLASS = 'sq-comment-header';
const ICON_SIZE = 32;

let patched = false;
let menuEl = null;

const injectStyles = () => {
    if (document.getElementById('sq-annotation-styles')) return;
    const style = document.createElement('style');
    style.id = 'sq-annotation-styles';
    style.textContent = `
.${HEADER_CLASS} { display:flex; align-items:center; gap:6px; height:100%;
    font:600 12px ui-rounded,"Segoe UI",Helvetica,Arial,sans-serif; }
.${HEADER_CLASS} .sq-type { flex:0 0 auto; width:20px; height:20px; padding:0; border:0;
    display:flex; align-items:center; justify-content:center; cursor:pointer;
    border-radius:6px; font-size:12px; line-height:1; color:#fff; background:#7c5cff; }
.${HEADER_CLASS} .sq-type:hover { filter:brightness(1.12); }
.${HEADER_CLASS} .sq-title { flex:1 1 auto; min-width:0; border:0; outline:0; padding:0;
    background:transparent; font:inherit; color:#1f2340; text-overflow:ellipsis; }
.${HEADER_CLASS} .sq-title::placeholder { color:rgba(31,35,64,.42); font-weight:500; }
.${HEADER_CLASS}.sq-marked .sq-title { color:#fff; }
.${HEADER_CLASS}.sq-marked .sq-title::placeholder { color:rgba(255,255,255,.7); }
.sq-type-menu { position:fixed; z-index:100001; background:#161c36; color:#f2f4fb;
    border:1px solid rgba(255,255,255,.11); border-radius:12px; padding:5px;
    box-shadow:0 18px 50px -12px rgba(0,0,0,.7); min-width:172px;
    font:600 13px ui-rounded,"Segoe UI",Helvetica,Arial,sans-serif; }
.sq-type-menu button { display:flex; align-items:center; gap:9px; width:100%; padding:7px 9px;
    background:transparent; border:0; border-radius:8px; color:inherit; font:inherit;
    cursor:pointer; text-align:left; }
.sq-type-menu button:hover { background:rgba(255,255,255,.07); }
.sq-type-menu .sq-swatch { width:18px; height:18px; border-radius:5px; color:#fff;
    display:flex; align-items:center; justify-content:center; font-size:11px; flex:0 0 auto; }
.sq-type-menu .sq-check { margin-left:auto; opacity:.85; }
@keyframes sq-comment-flash {
    0%,100% { filter:none; }
    30%,70% { filter:drop-shadow(0 0 9px #a855f7) brightness(1.06); } }
.sq-comment-flash { animation:sq-comment-flash 1.1s ease-in-out; }
`;
    document.head.appendChild(style);
};

const closeMenu = () => {
    if (menuEl) {
        menuEl.remove();
        menuEl = null;
    }
};

document.addEventListener('mousedown', e => {
    if (menuEl && !menuEl.contains(e.target)) closeMenu();
}, true);

const openTypeMenu = (comment, anchor) => {
    closeMenu();
    const current = parse(comment.content_ || '');
    menuEl = document.createElement('div');
    menuEl.className = 'sq-type-menu';
    for (const t of TYPES) {
        const btn = document.createElement('button');
        const swatch = document.createElement('span');
        swatch.className = 'sq-swatch';
        swatch.style.background = t.color;
        swatch.textContent = t.icon;
        btn.appendChild(swatch);
        btn.appendChild(document.createTextNode(t.label));
        if (t.id === current.type && current.marked) {
            const check = document.createElement('span');
            check.className = 'sq-check';
            check.textContent = '✓';
            btn.appendChild(check);
        }
        btn.addEventListener('click', () => {
            const p = parse(comment.content_);
            comment.setText(compose(t.id, p.title, p.body));
            closeMenu();
        });
        menuEl.appendChild(btn);
    }
    document.body.appendChild(menuEl);
    const r = anchor.getBoundingClientRect();
    const h = menuEl.offsetHeight;
    menuEl.style.left = `${Math.min(r.left, window.innerWidth - menuEl.offsetWidth - 8)}px`;
    menuEl.style.top = `${r.bottom + h > window.innerHeight ? Math.max(8, r.top - h) : r.bottom + 4}px`;
};

const buildHeader = comment => {
    const svgNs = 'http://www.w3.org/2000/svg';
    const htmlNs = 'http://www.w3.org/1999/xhtml';

    const fo = document.createElementNS(svgNs, 'foreignObject');
    fo.setAttribute('class', 'sq-comment-header-fo');
    const body = document.createElementNS(htmlNs, 'body');
    body.setAttribute('xmlns', htmlNs);
    body.className = 'blocklyMinimalBody';
    const wrap = document.createElementNS(htmlNs, 'div');
    wrap.className = HEADER_CLASS;

    const typeBtn = document.createElementNS(htmlNs, 'button');
    typeBtn.className = 'sq-type';
    typeBtn.setAttribute('title', 'Change comment type');

    const title = document.createElementNS(htmlNs, 'input');
    title.className = 'sq-title';
    title.setAttribute('type', 'text');
    title.setAttribute('placeholder', 'Add a title…');

    wrap.appendChild(typeBtn);
    wrap.appendChild(title);
    body.appendChild(wrap);
    fo.appendChild(body);

    // The top bar is a drag handle; without this, using the header drags the
    // comment instead of typing in it.
    for (const ev of ['mousedown', 'pointerdown', 'touchstart']) {
        wrap.addEventListener(ev, e => e.stopPropagation(), true);
    }

    typeBtn.addEventListener('click', e => {
        e.stopPropagation();
        openTypeMenu(comment, typeBtn);
    });

    const pushTitle = () => {
        const p = parse(comment.content_);
        const next = compose(p.type, title.value, p.body);
        if (next !== comment.content_) comment.setText(next);
    };
    title.addEventListener('input', pushTitle);
    title.addEventListener('change', pushTitle);
    title.addEventListener('keydown', e => {
        if (e.key === 'Enter') title.blur();
        e.stopPropagation();
    });

    comment.sqHeader_ = {fo, wrap, typeBtn, title};
    comment.getSvgRoot().appendChild(fo);
    return comment.sqHeader_;
};

const layoutHeader = (comment, SB) => {
    const h = comment.sqHeader_;
    if (!h) return;
    const inset = SB.WorkspaceCommentSvg.TOP_BAR_ICON_INSET || 0;
    const barHeight = SB.WorkspaceCommentSvg.TOP_BAR_HEIGHT;
    const border = SB.WorkspaceCommentSvg.BORDER_WIDTH;
    const left = inset + ICON_SIZE;
    const width = Math.max(0, comment.getHeightWidth().width - left - inset - ICON_SIZE);
    h.fo.setAttribute('x', left);
    h.fo.setAttribute('y', border);
    h.fo.setAttribute('width', width);
    h.fo.setAttribute('height', barHeight);
    // A minimized comment shows Blockly's own centered label instead.
    h.fo.setAttribute('display', comment.isMinimized() ? 'none' : '');
};

const applyAnnotation = (comment, SB) => {
    const p = parse(comment.content_ || '');
    const info = typeInfo(p.type);
    const section = isSection(p.type);

    if (comment.textarea_ && comment.textarea_.value !== p.body) {
        comment.textarea_.value = p.body;
    }

    if (comment.svgRect_) {
        comment.svgRect_.style.fill = section ? 'none' : info.tint;
        comment.svgRect_.style.stroke = p.marked ? info.color : '';
        comment.svgRect_.style.strokeWidth = section ? '2px' : '';
    }
    if (comment.svgHandleTarget_) {
        comment.svgHandleTarget_.style.fill = p.marked ? info.color : '';
        comment.svgHandleTarget_.style.fillOpacity = p.marked ? '1' : '';
    }
    // The body inside the foreignObject carries its own yellow background,
    // which would paint straight over the tinted rect behind it.
    const bodyEl = comment.foreignObject_ && comment.foreignObject_.firstElementChild;
    if (bodyEl) bodyEl.style.background = p.marked ? info.tint : '';
    // A section is a label around other people's blocks — the interior must
    // not swallow clicks meant for them.
    if (comment.foreignObject_) {
        comment.foreignObject_.style.display = section ? 'none' : '';
    }

    const h = comment.sqHeader_;
    if (h) {
        // An untyped comment gets a muted button, so "no type yet" doesn't
        // look like it has been deliberately marked as a note.
        h.typeBtn.style.background = p.marked ? info.color : 'rgba(0,0,0,.22)';
        h.typeBtn.textContent = p.marked ? info.icon : '＋';
        h.typeBtn.setAttribute('title', p.marked ? `${info.label} — click to change` : 'Add a type');
        h.wrap.classList.toggle('sq-marked', p.marked);
        if (document.activeElement !== h.title && h.title.value !== p.title) {
            h.title.value = p.title;
        }
        layoutHeader(comment, SB);
    }
};

/**
 * Wrap scratch-blocks' comment rendering so annotations show up. Idempotent.
 * @param {object} SB the scratch-blocks module
 */
const patchComments = SB => {
    if (patched || !SB || !SB.WorkspaceCommentSvg) return;
    patched = true;
    injectStyles();

    const proto = SB.WorkspaceCommentSvg.prototype;
    const origRender = proto.render;
    const origSetText = proto.setText;
    const origSetSize = proto.setSize;
    const origGetLabel = proto.getLabelText;
    const origDispose = proto.dispose;

    proto.render = function () {
        const wasRendered = this.rendered_;
        origRender.call(this);
        if (!wasRendered && this.rendered_ && !this.RTL) {
            // RTL mirrors the whole comment group, which would mirror the
            // header's text with it. Colours still apply; the header does not.
            buildHeader(this);
        }
        applyAnnotation(this, SB);
    };

    // Blockly's own textarea handler passes the visible body back in, which no
    // longer carries the marker. Re-attach it from what is already on disk
    // rather than letting an edit silently strip the annotation.
    proto.setText = function (text) {
        let full = text;
        if (!parse(text).marked) {
            const current = parse(this.content_ || '');
            if (current.marked) full = compose(current.type, current.title, text);
        }
        origSetText.call(this, full);
        applyAnnotation(this, SB);
    };

    proto.setSize = function (width, height) {
        origSetSize.call(this, width, height);
        layoutHeader(this, SB);
    };

    proto.getLabelText = function () {
        const p = parse(this.content_ || '');
        if (p.marked) {
            const info = typeInfo(p.type);
            return `${info.icon} ${summarize(p) || info.label}`;
        }
        return origGetLabel.call(this);
    };

    proto.dispose = function () {
        if (this.sqHeader_) {
            this.sqHeader_.fo.remove();
            this.sqHeader_ = null;
        }
        origDispose.call(this);
    };
};

export {patchComments, closeMenu};
