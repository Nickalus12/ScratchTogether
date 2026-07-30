import {parse, compose, summarize, typeInfo, TYPES, DEFAULT_TYPE} from '../../../src/lib/annotations';

const relativeLuminance = hex => {
    const channels = [1, 3, 5]
        .map(i => parseInt(hex.substr(i, 2), 16) / 255)
        .map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
};

const contrast = (a, b) => {
    const [l1, l2] = [relativeLuminance(a), relativeLuminance(b)];
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

// CIELAB (D65) — perceptual, unlike RGB distance, which calls two very
// different-looking colours close and two identical-looking ones far apart.
const toLab = hex => {
    const [r, g, b] = [1, 3, 5]
        .map(i => parseInt(hex.substr(i, 2), 16) / 255)
        .map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    const f = t => (t > 0.008856 ? Math.cbrt(t) : (7.787 * t) + (16 / 116));
    const x = f(((0.4124 * r) + (0.3576 * g) + (0.1805 * b)) / 0.95047);
    const y = f((0.2126 * r) + (0.7152 * g) + (0.0722 * b));
    const z = f(((0.0193 * r) + (0.1192 * g) + (0.9505 * b)) / 1.08883);
    return [(116 * y) - 16, 500 * (x - y), 200 * (y - z)];
};

const deltaE = (a, b) => {
    const [la, aa, ba] = toLab(a);
    const [lb, ab, bb] = toLab(b);
    return Math.sqrt(((la - lb) ** 2) + ((aa - ab) ** 2) + ((ba - bb) ** 2));
};

describe('annotation parsing', () => {
    test('reads a marker into type, title and body', () => {
        const p = parse('[!warn] Don\'t reorder these\nthe timer breaks if you do');
        expect(p).toEqual({
            type: 'warn',
            title: 'Don\'t reorder these',
            body: 'the timer breaks if you do',
            marked: true
        });
    });

    test('a plain comment is an unmarked note, text untouched', () => {
        const p = parse('just a normal comment\nwith two lines');
        expect(p.marked).toBe(false);
        expect(p.type).toBe(DEFAULT_TYPE);
        expect(p.body).toBe('just a normal comment\nwith two lines');
    });

    // A body that happens to open with bracket text must not be swallowed.
    test('an unknown type is left as plain text', () => {
        const p = parse('[!totallymadeup] hello\nbody');
        expect(p.marked).toBe(false);
        expect(p.body).toBe('[!totallymadeup] hello\nbody');
    });

    test('marker with no body', () => {
        expect(parse('[!todo] add a jump sound')).toEqual({
            type: 'todo',
            title: 'add a jump sound',
            body: '',
            marked: true
        });
    });

    test('marker with no title', () => {
        const p = parse('[!bug]\nsprite falls through the floor');
        expect(p.type).toBe('bug');
        expect(p.title).toBe('');
        expect(p.body).toBe('sprite falls through the floor');
    });

    test('non-string input does not throw', () => {
        expect(parse(undefined).body).toBe('');
        expect(parse(null).marked).toBe(false);
    });
});

describe('annotation composing', () => {
    test('round-trips every marked shape', () => {
        const cases = [
            ['warn', 'Careful', 'body text'],
            ['section', '1 · Setup', ''],
            ['done', '', 'finished this bit'],
            ['step', 'First', 'multi\nline\nbody']
        ];
        for (const [type, title, body] of cases) {
            expect(parse(compose(type, title, body))).toEqual({type, title, body, marked: true});
        }
    });

    // Otherwise merely opening a project would rewrite every plain comment.
    test('an untitled plain note stays bare', () => {
        expect(compose('note', '', 'hello')).toBe('hello');
        expect(compose('note', '', '')).toBe('');
    });

    test('a titled note does get a marker', () => {
        expect(compose('note', 'Heading', 'hello')).toBe('[!note] Heading\nhello');
    });

    test('unknown types fall back to the default rather than writing garbage', () => {
        expect(compose('nope', '', 'hello')).toBe('hello');
    });

    // The marker occupies exactly line 1, so a newline in the title would
    // silently move the rest of the title into the body on the next read.
    test('newlines in a title are flattened', () => {
        const text = compose('todo', 'two\nlines', 'body');
        expect(parse(text).title).toBe('two lines');
        expect(parse(text).body).toBe('body');
    });

    test('parse of compose is stable across repeated edits', () => {
        let text = compose('idea', 'Maybe', 'try this');
        for (let i = 0; i < 3; i++) {
            const p = parse(text);
            text = compose(p.type, p.title, p.body);
        }
        expect(text).toBe('[!idea] Maybe\ntry this');
    });
});

describe('summarize', () => {
    test('prefers the title', () => {
        expect(summarize(parse('[!todo] Add sound\nsomewhere here'))).toBe('Add sound');
    });

    test('falls back to the first non-empty body line', () => {
        expect(summarize(parse('\n\n  hello there\nmore'))).toBe('hello there');
    });

    test('empty comment summarizes to empty string', () => {
        expect(summarize(parse(''))).toBe('');
    });
});

describe('typeInfo', () => {
    test('unknown ids resolve to the default type', () => {
        expect(typeInfo('nope').id).toBe(DEFAULT_TYPE);
    });

    // The header renders the title in white on `color`, and the body renders
    // dark text on `tint`. Both have to stay legible for a nine-year-old.
    test('header text clears WCAG AA on every type colour', () => {
        const failing = TYPES
            .filter(t => contrast(t.color, '#ffffff') < 4.5)
            .map(t => `${t.id} (${t.color} = ${contrast(t.color, '#ffffff').toFixed(2)}:1)`);
        expect(failing).toEqual([]);
    });

    test('body text clears WCAG AA on every tint', () => {
        const failing = TYPES
            .filter(t => t.tint !== 'none' && contrast('#1f2340', t.tint) < 4.5)
            .map(t => `${t.id} (${t.tint})`);
        expect(failing).toEqual([]);
    });

    /*
     * Distinct hex strings prove nothing — the first palette had to-do at
     * #a76809 and idea at #a16207, which are different numbers and the same
     * colour. Measuring the perceptual gap is the only version of this test
     * that can fail when it should.
     *
     * CIELAB dE76: ~2.3 is the threshold at which a difference becomes
     * visible at all, so a floor of 15 is "obviously a different colour" with
     * room for the rendering to shift it a little.
     */
    test('no two type colours look alike', () => {
        const tooClose = [];
        for (let i = 0; i < TYPES.length; i++) {
            for (let j = i + 1; j < TYPES.length; j++) {
                const gap = deltaE(TYPES[i].color, TYPES[j].color);
                if (gap < 15) {
                    tooClose.push(`${TYPES[i].id} vs ${TYPES[j].id} (dE ${gap.toFixed(1)})`);
                }
            }
        }
        expect(tooClose).toEqual([]);
    });

    test('every shipped type has the fields the renderer reads', () => {
        for (const id of ['note', 'step', 'todo', 'done', 'warn', 'bug', 'idea', 'section']) {
            const t = typeInfo(id);
            expect(t.id).toBe(id);
            expect(typeof t.label).toBe('string');
            expect(typeof t.icon).toBe('string');
            expect(t.color).toMatch(/^#[0-9a-f]{6}$/i);
        }
    });
});
