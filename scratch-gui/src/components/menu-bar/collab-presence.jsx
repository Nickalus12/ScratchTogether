import React from 'react';
import overlay from '../../lib/collab/overlay';
import client from '../../lib/collab/client';

/* Native menu-bar multiplayer panel.
 * Collapsed: one compact button — connection dot, people icon, player count.
 * Expanded: a proper panel — room header, invite link, player list with live status.
 * Renders nothing in solo mode. */

const statusIcon = status => {
    if (!status || status === 'here') return '🟢';
    if (status.indexOf('playing') !== -1) return '▶️';
    if (status.indexOf('painting') !== -1) return '🎨';
    if (status.indexOf('sounds') !== -1) return '🎵';
    return '✏️';
};

// Same tokens as the dashboard in collab-server/home.html — the panel is part
// of the app, not part of the editor chrome it happens to hang off.
const T = {
    surface: '#161c36',
    card: 'rgba(255, 255, 255, 0.055)',
    line: 'rgba(255, 255, 255, 0.11)',
    ink: '#f2f4fb',
    dim: '#a3abc8',
    faint: '#6d769a',
    good: '#34d399',
    warn: '#fbbf24',
    accentBg: 'linear-gradient(135deg, #7c5cff, #a855f7)',
    font: 'ui-rounded, "SF Pro Rounded", "Segoe UI Variable", Nunito, system-ui, sans-serif'
};

const label = {
    fontSize: '10.5px',
    fontWeight: 800,
    letterSpacing: '0.6px',
    textTransform: 'uppercase',
    color: T.faint
};

const btn = {
    padding: '8px 13px',
    borderRadius: '9px',
    fontSize: '12.5px',
    fontWeight: 700,
    cursor: 'pointer',
    color: T.ink,
    background: T.card,
    border: `1px solid ${T.line}`,
    fontFamily: 'inherit'
};

const personRow = {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '4px 0',
    fontSize: '13px',
    color: T.ink
};

const dot = (color, size) => ({
    display: 'inline-block',
    width: `${size || 10}px`,
    height: `${size || 10}px`,
    borderRadius: '50%',
    background: color,
    flexShrink: 0
});

class CollabPresence extends React.Component {
    constructor (props) {
        super(props);
        this.state = {...overlay.getState(), open: false, copied: false, saveName: '', confirmOpenId: null};
        this.handleChange = () => this.setState(overlay.getState());
        this.handleToggle = () => {
            this.setState(s => {
                if (!s.open) client.send({type: 'list-projects'});
                return {open: !s.open, copied: false, confirmOpenId: null};
            });
        };
        this.handleCopy = this.handleCopy.bind(this);
        this.handleSave = () => {
            const name = this.state.saveName.trim();
            if (!name) return;
            client.send({type: 'save-project', name});
            this.setState({saveName: ''});
        };
        this.handleOpenProject = id => {
            // two-click confirm — opening replaces the room's project for everyone
            if (this.state.confirmOpenId === id) {
                client.send({type: 'load-project', id});
                this.setState({confirmOpenId: null, open: false});
            } else {
                this.setState({confirmOpenId: id});
            }
        };
        this.handleClickOutside = e => {
            if (this.rootRef && !this.rootRef.contains(e.target) && this.state.open) {
                this.setState({open: false});
            }
        };
        this.setRootRef = el => {
            this.rootRef = el;
        };
    }
    componentDidMount () {
        this.unsubscribe = overlay.subscribe(this.handleChange);
        document.addEventListener('mousedown', this.handleClickOutside);
        this.handleChange();
    }
    componentWillUnmount () {
        if (this.unsubscribe) this.unsubscribe();
        document.removeEventListener('mousedown', this.handleClickOutside);
    }
    inviteLink () {
        const {self} = this.state;
        return `${location.origin}/r/${self ? self.room : 'family'}`;
    }
    handleCopy () {
        const link = this.inviteLink();
        try {
            navigator.clipboard.writeText(link);
            this.setState({copied: true});
            setTimeout(() => this.setState({copied: false}), 1800);
        } catch (e) {
            window.prompt('Copy this invite link:', link); // eslint-disable-line no-alert
        }
    }
    render () {
        const {self, connected, peers, open, copied} = this.state;
        if (!self) return null; // solo mode

        // The slug is a URL detail — disambiguated with -2 when a name is
        // taken — so it is the wrong thing to show a person.
        const roomName = self.title || self.room;

        // Always-available way back to the dashboard — the editor is otherwise
        // a one-way door once you are in a room.
        const homeButton = (
            <a
                href={'/'}
                title={'Back to Squiggle'}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    background: 'rgba(0, 0, 0, 0.18)',
                    borderRadius: '15px',
                    padding: '3px 11px',
                    marginRight: '6px',
                    color: '#fff',
                    fontSize: '12px',
                    fontWeight: 'bold',
                    textDecoration: 'none',
                    whiteSpace: 'nowrap',
                    userSelect: 'none'
                }}
            >
                <svg
                    width={'15'}
                    height={'15'}
                    viewBox={'0 0 26 26'}
                >
                    <path
                        d={'M4 17c2.5 0 2.5-8 5-8s2.5 8 5 8 2.5-8 5-8'}
                        stroke={'#fff'}
                        strokeWidth={'2.6'}
                        fill={'none'}
                        strokeLinecap={'round'}
                    />
                </svg>
                {'Home'}
            </a>
        );

        const button = (
            <div
                onClick={this.handleToggle}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '7px',
                    cursor: 'pointer',
                    background: open ? 'rgba(124, 92, 255, 0.28)' : 'rgba(0, 0, 0, 0.18)',
                    border: `1px solid ${open ? 'rgba(124, 92, 255, 0.6)' : 'transparent'}`,
                    borderRadius: '15px',
                    padding: '3px 11px',
                    color: '#fff',
                    fontSize: '12px',
                    fontWeight: 'bold',
                    whiteSpace: 'nowrap',
                    userSelect: 'none'
                }}
                title={connected ? `${roomName} — click for details` : 'Reconnecting…'}
            >
                <span style={dot(connected ? T.good : T.warn, 8)} />
                <span style={{fontSize: '14px', lineHeight: 1}}>{'👥'}</span>
                <span>{1 + peers.length}</span>
                <span style={{opacity: 0.6, fontWeight: 'normal'}}>{'▾'}</span>
            </div>
        );

        const panel = open ? (
            <div
                style={{
                    // fixed — the menu bar clips absolutely-positioned children
                    position: 'fixed',
                    top: '52px',
                    right: '8px',
                    width: '290px',
                    background: T.surface,
                    border: `1px solid ${T.line}`,
                    borderRadius: '16px',
                    boxShadow: '0 18px 50px -12px rgba(0, 0, 0, 0.7)',
                    overflow: 'hidden',
                    zIndex: 1000,
                    cursor: 'default',
                    color: T.ink,
                    fontFamily: T.font
                }}
            >
                <div style={{padding: '14px 15px 13px', borderBottom: `1px solid ${T.line}`}}>
                    <div style={label}>{'Room'}</div>
                    <div style={{display: 'flex', alignItems: 'center', gap: '8px', marginTop: '3px'}}>
                        <span
                            style={{
                                fontSize: '17px',
                                fontWeight: 800,
                                letterSpacing: '-0.01em',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap'
                            }}
                            title={roomName}
                        >
                            {roomName}
                        </span>
                        <span
                            style={{
                                marginLeft: 'auto',
                                flexShrink: 0,
                                display: 'flex',
                                alignItems: 'center',
                                gap: '5px',
                                fontSize: '10px',
                                fontWeight: 800,
                                letterSpacing: '0.4px',
                                textTransform: 'uppercase',
                                color: connected ? T.good : T.warn
                            }}
                        >
                            <span style={dot(connected ? T.good : T.warn, 7)} />
                            {connected ? 'Live' : 'Reconnecting'}
                        </span>
                    </div>
                    <button
                        onClick={this.handleCopy}
                        style={{
                            ...btn,
                            width: '100%',
                            marginTop: '11px',
                            background: copied ? 'rgba(52, 211, 153, 0.16)' : T.accentBg,
                            borderColor: copied ? 'rgba(52, 211, 153, 0.5)' : 'transparent',
                            color: '#fff'
                        }}
                    >
                        {copied ? '✓ Copied — send it to your partner' : 'Copy invite link'}
                    </button>
                </div>

                <div style={{padding: '11px 15px 12px', borderBottom: `1px solid ${T.line}`}}>
                    <div style={{...label, marginBottom: '7px'}}>
                        {`In here · ${1 + peers.length}`}
                    </div>
                    <div style={personRow}>
                        <span style={dot(self.color)} />
                        <span style={{fontWeight: 700}}>{self.name}</span>
                        <span style={{color: T.faint, fontSize: '11.5px'}}>{'you'}</span>
                    </div>
                    {peers.map(p => (
                        <div
                            key={p.id}
                            style={personRow}
                        >
                            <span style={dot(p.color)} />
                            <span style={{fontWeight: 700}}>{p.name}</span>
                            <span
                                style={{
                                    marginLeft: 'auto',
                                    fontSize: '11px',
                                    color: T.faint,
                                    textAlign: 'right',
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis'
                                }}
                            >
                                {p.sprite ? `${statusIcon(p.status)} ${p.sprite}` : statusIcon(p.status)}
                            </span>
                        </div>
                    ))}
                    {peers.length === 0 ? (
                        <div style={{fontSize: '12px', color: T.faint, padding: '3px 0 1px', lineHeight: 1.5}}>
                            {'Just you so far. Send the invite link and build together.'}
                        </div>
                    ) : null}
                </div>

                <div style={{padding: '11px 15px 14px'}}>
                    <div style={{...label, marginBottom: '7px'}}>{'Save to library'}</div>
                    <div style={{display: 'flex', gap: '7px'}}>
                        <input
                            onChange={e => this.setState({saveName: e.target.value})}
                            onKeyDown={e => {
                                if (e.key === 'Enter') this.handleSave();
                            }}
                            placeholder="Name this copy…"
                            style={{
                                flex: 1,
                                minWidth: 0,
                                padding: '8px 10px',
                                fontSize: '12.5px',
                                color: T.ink,
                                background: 'rgba(0, 0, 0, 0.3)',
                                border: `1.5px solid ${T.line}`,
                                borderRadius: '9px',
                                outline: 'none',
                                fontFamily: 'inherit'
                            }}
                            type="text"
                            value={this.state.saveName}
                        />
                        <button
                            disabled={!this.state.saveName.trim()}
                            onClick={this.handleSave}
                            style={{
                                ...btn,
                                flexShrink: 0,
                                opacity: this.state.saveName.trim() ? 1 : 0.45,
                                cursor: this.state.saveName.trim() ? 'pointer' : 'default'
                            }}
                        >
                            {'Save'}
                        </button>
                    </div>

                    {(this.state.projects || []).length ? (
                        <div style={{maxHeight: '164px', overflowY: 'auto', marginTop: '11px'}}>
                            {this.state.projects.map(p => (
                                <div
                                    key={p.id}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '8px',
                                        padding: '7px 0',
                                        borderTop: `1px solid ${T.line}`
                                    }}
                                >
                                    <div style={{flex: 1, minWidth: 0}}>
                                        <div
                                            style={{
                                                fontSize: '12.5px',
                                                fontWeight: 700,
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                                whiteSpace: 'nowrap'
                                            }}
                                        >
                                            {p.name}
                                        </div>
                                        <div style={{fontSize: '10.5px', color: T.faint}}>
                                            {new Date(p.updatedAt).toLocaleDateString()}
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => this.handleOpenProject(p.id)}
                                        style={{
                                            ...btn,
                                            flexShrink: 0,
                                            padding: '5px 10px',
                                            fontSize: '11.5px',
                                            background: this.state.confirmOpenId === p.id ?
                                                'rgba(251, 191, 36, 0.18)' : T.card,
                                            borderColor: this.state.confirmOpenId === p.id ?
                                                'rgba(251, 191, 36, 0.55)' : T.line,
                                            color: this.state.confirmOpenId === p.id ? T.warn : T.ink
                                        }}
                                        title={'Opening replaces what everyone in this room is looking at'}
                                    >
                                        {this.state.confirmOpenId === p.id ? 'Replace for all?' : 'Open'}
                                    </button>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div style={{fontSize: '11.5px', color: T.faint, marginTop: '9px', lineHeight: 1.5}}>
                            {'The room saves itself as you go — this is for keeping a named copy.'}
                        </div>
                    )}
                </div>
            </div>
        ) : null;

        return (
            <div
                ref={this.setRootRef}
                style={{position: 'relative', display: 'flex', alignItems: 'center', padding: '0 8px'}}
            >
                {homeButton}
                {button}
                {panel}
            </div>
        );
    }
}

export default CollabPresence;
