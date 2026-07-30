/* Comment annotations — the model.
 *
 * An annotation is a marker on the first line of an ordinary Scratch comment:
 *
 *     [!warn] Don't reorder these
 *     the timer breaks if you do
 *
 * Keeping it inside the comment text is what makes the feature free: comments
 * already ride the collab `comment_change` events and already land in the
 * .sb3, so annotations sync and save with no extra plumbing, and a project
 * opened in vanilla Scratch still shows the note with the marker as plain text
 * rather than losing it. */

// `id` is the wire format — it is written into project files. Renaming one
// orphans every comment that already used it.
//
// Two constraints, both enforced by test/unit/util/annotations.test.js:
//
//   1. Every `color` carries white header text, so each is held at >= 4.5:1
//      against white — several are a shade darker than the brand palette.
//   2. No two colours may look alike. The first version of this palette put
//      to-do and idea 2.8 CIELAB units apart, which is under the threshold at
//      which a person can see any difference at all; careful and bug were a
//      similar pair of reds. The types are now spread around the wheel, and
//      the test measures that rather than merely checking the hex strings
//      differ — which is what let identical-looking colours ship.
//
// Icons carry meaning where colour can't: to-do and done are the same
// checkbox, empty and ticked, so the pair reads as one idea in two states.
const TYPES = [
    {id: 'note', label: 'Note', icon: '✎', color: '#7c3aed', tint: '#f1ebff'},
    {id: 'step', label: 'Step', icon: '➊', color: '#0e7490', tint: '#e3f6fb'},
    {id: 'todo', label: 'To-do', icon: '☐', color: '#2563eb', tint: '#e8efff'},
    {id: 'done', label: 'Done', icon: '☑', color: '#16803c', tint: '#e5f7ec'},
    {id: 'warn', label: 'Careful', icon: '⚠', color: '#a16207', tint: '#fdf5e0'},
    {id: 'bug', label: 'Bug', icon: '⊗', color: '#dc2626', tint: '#ffe9e9'},
    {id: 'idea', label: 'Idea', icon: '★', color: '#db2777', tint: '#ffe9f3'},
    {id: 'section', label: 'Section', icon: '▤', color: '#4b5563', tint: 'none'}
];

const BY_ID = new Map(TYPES.map(t => [t.id, t]));

const DEFAULT_TYPE = 'note';

const typeInfo = id => BY_ID.get(id) || BY_ID.get(DEFAULT_TYPE);

const isSection = id => id === 'section';

// Only line 1, and only a type we actually ship — so a comment whose body
// happens to open with bracket text is left alone instead of being swallowed.
const MARKER_RE = /^\[!([a-z][a-z0-9-]*)\][ \t]*([^\n]*)(?:\n([\s\S]*))?$/;

/**
 * @param {string} text raw comment text
 * @returns {{type: string, title: string, body: string, marked: boolean}} parsed
 */
const parse = text => {
    const raw = typeof text === 'string' ? text : '';
    const m = MARKER_RE.exec(raw);
    if (m && BY_ID.has(m[1])) {
        return {type: m[1], title: m[2].trim(), body: m[3] || '', marked: true};
    }
    return {type: DEFAULT_TYPE, title: '', body: raw, marked: false};
};

/**
 * Inverse of parse. An untitled plain note composes back to bare text so that
 * ordinary comments never gain a marker they did not ask for.
 * @param {string} type type id
 * @param {string} title heading
 * @param {string} body remaining text
 * @returns {string} comment text
 */
const compose = (type, title, body) => {
    const t = BY_ID.has(type) ? type : DEFAULT_TYPE;
    const heading = (title || '').replace(/[\r\n]+/g, ' ').trim();
    if (t === DEFAULT_TYPE && !heading) {
        return body || '';
    }
    return `[!${t}] ${heading}\n${body || ''}`;
};

/**
 * @param {object} parsed result of parse()
 * @returns {string} the one-line summary used for minimized comments + outline
 */
const summarize = parsed => {
    if (parsed.title) return parsed.title;
    const firstLine = (parsed.body || '').split('\n').find(l => l.trim());
    return (firstLine || '').trim();
};

export {
    TYPES,
    DEFAULT_TYPE,
    typeInfo,
    isSection,
    parse,
    compose,
    summarize
};
