import React from 'react';

import collab from '../../lib/collab';

/*
 * Room history.
 *
 * The server has been keeping 25 versions of every room, a minute apart, since
 * the beginning — and until now nothing could read them. "Undo this whole
 * afternoon" is exactly what someone needs after painting over a sprite, and
 * an editor undo stack cannot do it: it dies with the tab, it is per-person,
 * and it knows nothing about what a partner did.
 *
 * Restoring pushes the old project to everyone in the room, which is a big,
 * shared thing to do — so it asks first, and it says how long ago the version
 * is rather than showing a timestamp nobody can parse at a glance.
 */

const T = {
    surface: '#161c36',
    card: 'rgba(255, 255, 255, 0.055)',
    line: 'rgba(255, 255, 255, 0.11)',
    lineHi: 'rgba(255, 255, 255, 0.22)',
    ink: '#f2f4fb',
    dim: '#a3abc8',
    faint: '#6d769a',
    accent: '#7c5cff',
    font: 'ui-rounded, "Segoe UI", Helvetica, Arial, sans-serif'
};

const ago = ts => {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 90) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} minutes ago`;
    if (s < 86400) {
        const h = Math.floor(s / 3600);
        return h === 1 ? 'an hour ago' : `${h} hours ago`;
    }
    const d = Math.floor(s / 86400);
    return d === 1 ? 'yesterday' : `${d} days ago`;
};

class HistoryPanel extends React.Component {
    constructor (props) {
        super(props);
        this.state = {
            open: false,
            versions: [],
            loading: false,
            error: null,
            busy: null,
            // Which row is asking "are you sure?". A browser confirm() would
            // do, but it steals the whole window for a decision that belongs
            // next to the thing being decided about.
            confirming: null
        };
        this.handleToggle = this.handleToggle.bind(this);
        this.handleListClick = this.handleListClick.bind(this);
        this.handleDocumentClick = this.handleDocumentClick.bind(this);
        this.rootRef = React.createRef();
    }

    componentDidMount () {
        document.addEventListener('mousedown', this.handleDocumentClick);
    }

    componentWillUnmount () {
        document.removeEventListener('mousedown', this.handleDocumentClick);
    }

    handleDocumentClick (e) {
        if (!this.state.open) return;
        if (this.rootRef.current && this.rootRef.current.contains(e.target)) return;
        this.setState({open: false, confirming: null});
    }

    room () {
        return collab.roomName || '';
    }

    load () {
        const room = this.room();
        if (!room) {
            this.setState({error: 'Open a room first.', versions: [], loading: false});
            return;
        }
        this.setState({loading: true, error: null});
        fetch(`/api/rooms/${encodeURIComponent(room)}/history`, {credentials: 'same-origin'})
            .then(r => (r.ok ? r.json() : Promise.reject(new Error('http'))))
            .then(d => this.setState({versions: d.versions || [], loading: false}))
            .catch(() => this.setState({loading: false, error: 'Could not read the history.'}));
    }

    handleToggle () {
        const open = !this.state.open;
        this.setState({open, confirming: null});
        if (open) this.load();
    }

    /*
     * One listener for the whole list rather than a closure per row — the list
     * repaints on every state change, and per-row handlers would be rebuilt
     * each time.
     */
    handleListClick (e) {
        const btn = e.target.closest('button[data-file]');
        if (!btn) return;
        const file = btn.dataset.file;
        if (this.state.confirming !== file) {
            this.setState({confirming: file});
            return;
        }
        const version = this.state.versions.find(v => v.file === file);
        if (version) this.restore(version);
    }

    // Only reached after the row has been clicked twice — the second click IS
    // the confirmation, so there is nothing left to ask here.
    restore (v) {
        this.setState({busy: v.file, confirming: null});
        fetch(`/api/rooms/${encodeURIComponent(this.room())}/history/restore`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {'content-type': 'application/json', 'x-squiggle': '1'},
            body: JSON.stringify({file: v.file})
        })
            .then(r => (r.ok ? r.json() : Promise.reject(new Error('http'))))
            .then(() => this.setState({busy: null, open: false}))
            .catch(() => this.setState({busy: null, error: 'Could not put it back.'}));
    }

    render () {
        const {open, versions, loading, error, busy, confirming} = this.state;
        return (
            <div
                ref={this.rootRef}
                style={{position: 'relative', fontFamily: T.font}}
            >
                <button
                    onClick={this.handleToggle}
                    title="Earlier versions of this room"
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '5px 11px',
                        borderRadius: '9px',
                        cursor: 'pointer',
                        background: open ? 'rgba(124,92,255,.22)' : T.card,
                        border: `1px solid ${open ? T.accent : T.line}`,
                        color: T.ink,
                        font: 'inherit',
                        fontSize: '13px',
                        fontWeight: 700
                    }}
                >
                    <svg
                        viewBox="0 0 24 24"
                        style={{width: '15px', height: '15px', fill: 'currentColor'}}
                    >
                        <path d="M13 3a9 9 0 1 0 8.9 10.5l-2-.3A7 7 0 1 1 13 5v3l4.5-4L13 0z" />
                        <path d="M12 8h1.5v4.3l3.4 2-0.8 1.3L12 13z" />
                    </svg>
                    {'History'}
                </button>

                {open && (
                    <div
                        style={{
                            position: 'absolute',
                            top: 'calc(100% + 8px)',
                            right: 0,
                            zIndex: 640,
                            width: '272px',
                            maxHeight: '330px',
                            overflowY: 'auto',
                            background: T.surface,
                            border: `1px solid ${T.lineHi}`,
                            borderRadius: '13px',
                            padding: '10px',
                            boxShadow: '0 18px 50px -12px rgba(0,0,0,.7)'
                        }}
                    >
                        <div
                            style={{
                                fontSize: '10px',
                                fontWeight: 800,
                                letterSpacing: '0.7px',
                                textTransform: 'uppercase',
                                color: T.faint,
                                padding: '2px 4px 8px'
                            }}
                        >{'Earlier today'}</div>

                        {loading && <div style={{color: T.dim, fontSize: '13px', padding: '6px'}}>
                            {'Looking…'}</div>}

                        {error && <div style={{color: '#fb7185', fontSize: '13px', padding: '6px'}}>
                            {error}</div>}

                        {!loading && !error && !versions.length && (
                            <div style={{color: T.faint, fontSize: '12.5px', padding: '6px', lineHeight: 1.5}}>
                                {'No earlier versions yet. One is kept every minute while people are ' +
                                 'building, so there will be some shortly.'}
                            </div>
                        )}

                        <div onClick={this.handleListClick}>
                            {versions.map(v => (
                                <div
                                    key={v.file}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '8px',
                                        padding: '7px 5px',
                                        borderTop: `1px solid ${T.line}`
                                    }}
                                >
                                    <div style={{flex: 1, minWidth: 0}}>
                                        <div style={{fontSize: '13px', fontWeight: 700, color: T.ink}}>
                                            {ago(v.at)}
                                        </div>
                                        <div style={{fontSize: '11px', color: T.faint}}>
                                            {confirming === v.file ?
                                                'Everyone here will see it change' :
                                                `${Math.max(1, Math.round(v.size / 1024))} KB`}
                                        </div>
                                    </div>
                                    <button
                                        data-file={v.file}
                                        disabled={!!busy}
                                        style={{
                                            padding: '5px 10px',
                                            borderRadius: '8px',
                                            cursor: 'pointer',
                                            background: confirming === v.file ?
                                                'rgba(124,92,255,.3)' : T.card,
                                            border: `1px solid ${confirming === v.file ?
                                                T.accent : T.line}`,
                                            color: T.ink,
                                            font: 'inherit',
                                            fontSize: '12px',
                                            fontWeight: 700,
                                            whiteSpace: 'nowrap',
                                            opacity: busy && busy !== v.file ? 0.5 : 1
                                        }}
                                    >{busy === v.file ? 'Putting back…' :
                                            (confirming === v.file ? 'Yes, put it back' : 'Put back')}</button>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        );
    }
}

export default HistoryPanel;
