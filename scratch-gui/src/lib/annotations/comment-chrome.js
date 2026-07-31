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
/* The header sits on top of the comment's own drag bar, which is the only
   handle a section comment has. Rather than intercept presses and try to hand
   them back to Blockly — which cannot work, because a comment drag is armed by
   the workspace handler further along the same event — the header is simply
   transparent to the pointer. Presses land on the bar underneath and drag
   natively. The type button opts back in; the title opts in only while it is
   being edited (see focusTitle). */
.${HEADER_CLASS} { display:flex; align-items:center; gap:6px; height:100%;
    pointer-events:none;
    font:600 12px ui-rounded,"Segoe UI",Helvetica,Arial,sans-serif; }
.${HEADER_CLASS} .sq-type { flex:0 0 auto; width:20px; height:20px; padding:0; border:0;
    pointer-events:auto;
    display:flex; align-items:center; justify-content:center; cursor:pointer;
    border-radius:6px; font-size:12px; line-height:1; color:#fff; background:#7c5cff; }
.${HEADER_CLASS} .sq-title.sq-editing { pointer-events:auto; }
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

/* Press-vs-drag settling happens at DOCUMENT capture, not on the header:
 * during a drag Blockly's gesture binds its own document-capture mouseup and
 * stops propagation, so a header-level listener never hears it. These are
 * registered at module load — before any gesture's — so they always run first. */
/* Editing needs the pointer for the caret and selection, so the title takes it
 * back for as long as it is focused and gives it up on blur — otherwise the
 * top bar would stop being a drag handle the moment anyone typed a title. */
const focusTitle = title => {
    title.classList.add('sq-editing');
    setTimeout(() => title.focus(), 0);
};
const releaseTitle = title => title.classList.remove('sq-editing');

let activePress = null; // {x, y, title}
const inRect = (el, x, y) => {
    const r = el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
};

/*
 * One pair of document listeners for every comment on the workspace, rather
 * than a pair per comment.
 *
 * Each comment used to register its own capture-phase mousedown and touchstart
 * and measure its own header inside them, so a project with forty comments ran
 * eighty handlers and forced eighty layouts on every single click anywhere in
 * the editor. The press cannot be found from the event target — the header is
 * deliberately transparent to the pointer, so the target is always the drag bar
 * underneath — but the comment it belongs to can be, and that is enough to
 * narrow the hit test to exactly one rectangle.
 */
const ROOT_CLASS = 'sq-annotated-comment';
const headerByRoot = new WeakMap(); // comment svg root -> {comment, wrap, title}

const notePress = e => {
    const p = (e.touches && e.touches[0]) || e;
    const target = e.target;
    if (!target || typeof target.closest !== 'function') return;
    const root = target.closest(`.${ROOT_CLASS}`);
    const entry = root && headerByRoot.get(root);
    if (!entry || !entry.comment.sqHeader_ || entry.comment.isMinimized()) return;
    if (!inRect(entry.wrap, p.clientX, p.clientY)) return;
    activePress = {x: p.clientX, y: p.clientY, title: entry.title};
};
for (const ev of ['mousedown', 'touchstart']) {
    document.addEventListener(ev, notePress, true);
}
const settlePress = e => {
    if (!activePress) return;
    const p = (e.changedTouches && e.changedTouches[0]) || e;
    const press = activePress;
    activePress = null;
    const dx = p.clientX - press.x;
    const dy = p.clientY - press.y;
    // A press that moved was a drag. A clean release over the title means the
    // user wanted to type a heading — the title ignores the pointer until then,
    // so the hit test is geometric rather than a DOM target check.
    if ((dx * dx) + (dy * dy) < 25 && inRect(press.title, p.clientX, p.clientY)) {
        focusTitle(press.title);
    }
};
for (const ev of ['mouseup', 'pointerup', 'touchend']) {
    document.addEventListener(ev, settlePress, true);
}

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

    typeBtn.addEventListener('click', e => {
        e.stopPropagation();
        openTypeMenu(comment, typeBtn);
    });
    // The button takes the pointer, so a press on it would otherwise be read
    // as a press on the title strip when it comes back up.
    typeBtn.addEventListener('mousedown', () => {
        activePress = null;
    });

    const pushTitle = () => {
        const p = parse(comment.content_);
        const next = compose(p.type, title.value, p.body);
        if (next !== comment.content_) comment.setText(next);
    };
    title.addEventListener('input', pushTitle);
    title.addEventListener('change', pushTitle);
    title.addEventListener('blur', () => releaseTitle(title));
    title.addEventListener('keydown', e => {
        if (e.key === 'Enter') title.blur();
        e.stopPropagation();
    });

    comment.sqHeader_ = {fo, wrap, typeBtn, title};
    /* Presses are not intercepted at all — the header is pointer-transparent,
     * so a press on the bar reaches Blockly's own handle and drags the comment
     * exactly as it does on an un-annotated one. All the shared document
     * listener records is where the press began, so a release that never moved
     * can be treated as "edit the title"; this is what lets it find its way
     * back from the pressed element to this header. */
    const root = comment.getSvgRoot();
    root.classList.add(ROOT_CLASS);
    headerByRoot.set(root, {comment, wrap, title});
    root.appendChild(fo);
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

    /* Never while they are typing in it. Assigning `value` moves the caret to
     * the end, so a partner's edit landing mid-sentence used to throw the
     * cursor across the box — the title has been guarded against exactly this
     * since it was written, and the body was not. Comment bodies are still
     * last-write-wins; this only stops the write happening under the hands of
     * the person composing one. */
    if (comment.textarea_ && comment.textarea_.value !== p.body &&
        document.activeElement !== comment.textarea_) {
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
        const root = this.getSvgRoot && this.getSvgRoot();
        if (root) headerByRoot.delete(root);
        if (this.sqHeader_) {
            this.sqHeader_.fo.remove();
            this.sqHeader_ = null;
        }
        origDispose.call(this);
    };
};

export {patchComments, closeMenu};
