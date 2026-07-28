import PropTypes from 'prop-types';
import React from 'react';
import {connect} from 'react-redux';

import {isSection, parse, summarize, typeInfo} from '../../lib/annotations';
import {revealComment} from '../../lib/annotations/workspace-ref';

const T = {
    surface: '#161c36',
    card: 'rgba(255, 255, 255, 0.055)',
    line: 'rgba(255, 255, 255, 0.11)',
    ink: '#f2f4fb',
    dim: '#a3abc8',
    faint: '#6d769a',
    font: 'ui-rounded, "Segoe UI", Helvetica, Arial, sans-serif'
};

const label = {
    fontSize: '10px',
    fontWeight: 800,
    letterSpacing: '0.7px',
    textTransform: 'uppercase',
    color: T.faint
};

// A comment counts as belonging to a section when it sits inside its frame —
// the same rule the eye uses when looking at the canvas.
const within = (section, c) => (
    c.x >= section.x && c.y >= section.y &&
    c.x <= section.x + section.width &&
    c.y <= section.y + section.height
);

const buildOutline = (comments, query) => {
    const all = Object.entries(comments || {}).map(([id, c]) => ({
        id,
        x: c.x || 0,
        y: c.y || 0,
        width: c.width || 0,
        height: c.height || 0,
        attached: !!c.blockId,
        parsed: parse(c.text)
    }));

    const q = query.trim().toLowerCase();
    const matches = e => !q ||
        summarize(e.parsed).toLowerCase()
            .includes(q) ||
        (e.parsed.body || '').toLowerCase().includes(q) ||
        e.parsed.type.includes(q);

    const sections = all.filter(e => isSection(e.parsed.type))
        .sort((a, b) => a.y - b.y || a.x - b.x);
    const rest = all.filter(e => !isSection(e.parsed.type))
        .sort((a, b) => a.y - b.y || a.x - b.x);

    const claimed = new Set();
    const groups = sections.map(s => {
        const children = rest.filter(e => {
            if (claimed.has(e.id) || !within(s, e)) return false;
            claimed.add(e.id);
            return true;
        });
        return {section: s, children: children.filter(matches)};
    }).filter(g => g.children.length || matches(g.section));

    const loose = rest.filter(e => !claimed.has(e.id)).filter(matches);
    return {groups, loose, total: all.length};
};

const Chip = ({type}) => {
    const info = typeInfo(type);
    return (
        <span
            style={{
                flex: '0 0 auto',
                width: '17px',
                height: '17px',
                borderRadius: '5px',
                background: info.color,
                color: '#fff',
                fontSize: '10px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
            }}
            title={info.label}
        >
            {info.icon}
        </span>
    );
};

Chip.propTypes = {type: PropTypes.string};

const Row = ({entry, indent, onGo}) => {
    const text = summarize(entry.parsed) || typeInfo(entry.parsed.type).label;
    return (
        <div
            onClick={onGo}
            role="button"
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '6px 8px',
                marginLeft: indent ? '14px' : 0,
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: '12.5px'
            }}
            tabIndex={0}
            title={entry.parsed.body || text}
        >
            <Chip type={entry.parsed.type} />
            <span
                style={{flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'}}
            >
                {text}
            </span>
            {entry.attached ? (
                <span
                    style={{color: T.faint, fontSize: '10px'}}
                    title={'Attached to a block'}
                >
                    {'⛓'}
                </span>
            ) : null}
        </div>
    );
};

Row.propTypes = {
    entry: PropTypes.object,
    indent: PropTypes.bool,
    onGo: PropTypes.func
};

class OutlinePanel extends React.Component {
    constructor (props) {
        super(props);
        this.state = {open: false, query: '', tick: 0};
        this.handleToggle = this.handleToggle.bind(this);
        this.handleRefresh = this.handleRefresh.bind(this);
        this.handleQuery = this.handleQuery.bind(this);
    }
    componentDidMount () {
        // Comments change through Blockly, not through redux, so the panel
        // re-reads them on a timer rather than trying to subscribe to every
        // path that can edit one. It ticks even while closed, otherwise the
        // badge count stays stale until the panel is opened once.
        this.timer = setInterval(this.handleRefresh, 900);
    }
    componentWillUnmount () {
        clearInterval(this.timer);
    }
    handleQuery (e) {
        this.setState({query: e.target.value});
    }
    handleRefresh () {
        this.setState(s => ({tick: s.tick + 1}));
    }
    handleToggle () {
        this.setState(s => ({open: !s.open}));
    }
    render () {
        const target = this.props.vm && this.props.vm.editingTarget;
        const {groups, loose, total} = buildOutline(target && target.comments, this.state.query);
        const {open} = this.state;

        return (
            <div style={{position: 'relative'}}>
                <div
                    onClick={this.handleToggle}
                    role="button"
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '4px 10px',
                        borderRadius: '999px',
                        cursor: 'pointer',
                        background: open ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.12)',
                        color: '#fff',
                        fontFamily: T.font,
                        fontSize: '12px',
                        fontWeight: 700,
                        whiteSpace: 'nowrap'
                    }}
                    tabIndex={0}
                    title={'Outline — every note and section in this sprite'}
                >
                    <span>{'☰'}</span>
                    <span>{'Outline'}</span>
                    {total ? (
                        <span style={{opacity: 0.75, fontWeight: 800}}>{total}</span>
                    ) : null}
                </div>

                {open ? (
                    <div
                        style={{
                            position: 'fixed',
                            top: '52px',
                            right: '8px',
                            width: '286px',
                            maxHeight: '70vh',
                            overflowY: 'auto',
                            overflowX: 'hidden',
                            background: T.surface,
                            border: `1px solid ${T.line}`,
                            borderRadius: '16px',
                            boxShadow: '0 18px 50px -12px rgba(0,0,0,.7)',
                            zIndex: 1000,
                            color: T.ink,
                            fontFamily: T.font,
                            cursor: 'default'
                        }}
                    >
                        <div style={{padding: '13px 14px 11px', borderBottom: `1px solid ${T.line}`}}>
                            <div style={label}>{'Outline'}</div>
                            <input
                                onChange={this.handleQuery}
                                placeholder="Search notes…"
                                style={{
                                    width: '100%',
                                    marginTop: '8px',
                                    padding: '7px 10px',
                                    fontSize: '12.5px',
                                    color: T.ink,
                                    background: 'rgba(0,0,0,.3)',
                                    border: `1.5px solid ${T.line}`,
                                    borderRadius: '9px',
                                    outline: 'none',
                                    fontFamily: 'inherit'
                                }}
                                type="text"
                                value={this.state.query}
                            />
                        </div>

                        <div style={{padding: '8px 10px 12px'}}>
                            {groups.map(g => (
                                <div
                                    key={g.section.id}
                                    style={{marginBottom: '6px'}}
                                >
                                    <div
                                        // eslint-disable-next-line react/jsx-no-bind
                                        onClick={() => revealComment(g.section.id)}
                                        role="button"
                                        style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '8px',
                                            padding: '6px 8px',
                                            borderRadius: '8px',
                                            cursor: 'pointer',
                                            fontSize: '12px',
                                            fontWeight: 800,
                                            letterSpacing: '0.2px'
                                        }}
                                        tabIndex={0}
                                    >
                                        <Chip type={'section'} />
                                        <span
                                            style={{flex: 1,
                                                minWidth: 0,
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                                whiteSpace: 'nowrap'}}
                                        >
                                            {summarize(g.section.parsed) || 'Section'}
                                        </span>
                                        <span style={{color: T.faint, fontSize: '11px'}}>
                                            {g.children.length || ''}
                                        </span>
                                    </div>
                                    {g.children.map(e => (
                                        <Row
                                            entry={e}
                                            indent
                                            key={e.id}
                                            // eslint-disable-next-line react/jsx-no-bind
                                            onGo={() => revealComment(e.id)}
                                        />
                                    ))}
                                </div>
                            ))}

                            {loose.map(e => (
                                <Row
                                    entry={e}
                                    key={e.id}
                                    // eslint-disable-next-line react/jsx-no-bind
                                    onGo={() => revealComment(e.id)}
                                />
                            ))}

                            {!groups.length && !loose.length ? (
                                <div
                                    style={{fontSize: '12px',
                                        color: T.faint,
                                        padding: '6px 8px',
                                        lineHeight: 1.55}}
                                >
                                    {total ?
                                        'Nothing matches that.' :
                                        'No notes yet. Right-click the canvas → Add Comment, then give it a type.'}
                                </div>
                            ) : null}
                        </div>
                    </div>
                ) : null}
            </div>
        );
    }
}

OutlinePanel.propTypes = {
    vm: PropTypes.object
};

const mapStateToProps = state => ({
    vm: state.scratchGui.vm
});

export default connect(mapStateToProps)(OutlinePanel);
