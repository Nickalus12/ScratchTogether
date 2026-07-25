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
    return '✏️';
};

const rowStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '7px 12px',
    fontSize: '13px',
    color: '#575e75'
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
        const url = new URL(location.href);
        url.search = '';
        url.searchParams.set('room', self ? self.room : 'family');
        return url.toString();
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

        const button = (
            <div
                onClick={this.handleToggle}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '7px',
                    cursor: 'pointer',
                    background: open ? 'rgba(0, 0, 0, 0.3)' : 'rgba(0, 0, 0, 0.15)',
                    borderRadius: '15px',
                    padding: '4px 12px',
                    color: '#fff',
                    fontSize: '12px',
                    fontWeight: 'bold',
                    whiteSpace: 'nowrap',
                    userSelect: 'none'
                }}
                title={connected ? `Room "${self.room}" — click for details` : 'Reconnecting…'}
            >
                <span style={dot(connected ? '#4caf50' : '#ff5722', 8)} />
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
                    width: '260px',
                    background: '#fff',
                    borderRadius: '10px',
                    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)',
                    overflow: 'hidden',
                    zIndex: 1000,
                    cursor: 'default'
                }}
            >
                <div
                    style={{
                        background: 'linear-gradient(90deg, #4c97ff, #9966ff)',
                        color: '#fff',
                        padding: '10px 12px'
                    }}
                >
                    <div style={{fontSize: '10px', letterSpacing: '1px', opacity: 0.8, fontWeight: 'bold'}}>
                        {'MULTIPLAYER ROOM'}
                    </div>
                    <div style={{display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px'}}>
                        <span style={{fontSize: '17px', fontWeight: 'bold'}}>{self.room}</span>
                        <span
                            style={{
                                fontSize: '10px',
                                background: 'rgba(255, 255, 255, 0.25)',
                                borderRadius: '8px',
                                padding: '2px 7px',
                                fontWeight: 'bold'
                            }}
                        >
                            {connected ? 'CONNECTED' : 'RECONNECTING…'}
                        </span>
                    </div>
                    <div
                        onClick={this.handleCopy}
                        style={{
                            marginTop: '8px',
                            background: 'rgba(255, 255, 255, 0.2)',
                            borderRadius: '6px',
                            padding: '5px 8px',
                            fontSize: '11px',
                            cursor: 'pointer',
                            textAlign: 'center',
                            fontWeight: 'bold'
                        }}
                    >
                        {copied ? '✓ Link copied — send it to your partner!' : '🔗 Copy invite link'}
                    </div>
                </div>

                <div style={{padding: '4px 0'}}>
                    <div style={rowStyle}>
                        <span style={dot(self.color)} />
                        <span style={{fontWeight: 'bold'}}>{self.name}</span>
                        <span style={{opacity: 0.5, fontSize: '11px'}}>{'(you)'}</span>
                    </div>
                    {peers.map(p => (
                        <div
                            key={p.id}
                            style={rowStyle}
                        >
                            <span style={dot(p.color)} />
                            <span style={{fontWeight: 'bold'}}>{p.name}</span>
                            <span style={{marginLeft: 'auto', fontSize: '11px', opacity: 0.75, textAlign: 'right'}}>
                                {`${statusIcon(p.status)} ${p.status && p.status !== 'here' ? p.status : 'online'}`}
                                {p.sprite ? <div style={{opacity: 0.7}}>{`on ${p.sprite}`}</div> : null}
                            </span>
                        </div>
                    ))}
                    {peers.length === 0 ? (
                        <div style={{...rowStyle, opacity: 0.55, fontSize: '12px'}}>
                            {'Nobody else yet — copy the invite link above!'}
                        </div>
                    ) : null}
                </div>

                <div style={{borderTop: '1px solid #e5e8f0', padding: '8px 12px 10px'}}>
                    <div style={{fontSize: '10px', letterSpacing: '1px', color: '#8a8fa3', fontWeight: 'bold', marginBottom: '6px'}}>
                        {'PROJECTS'}
                    </div>
                    <div style={{display: 'flex', gap: '6px', marginBottom: '8px'}}>
                        <input
                            onChange={e => this.setState({saveName: e.target.value})}
                            onKeyDown={e => {
                                if (e.key === 'Enter') this.handleSave();
                            }}
                            placeholder="Name this project…"
                            style={{
                                flex: 1, minWidth: 0, padding: '5px 8px', fontSize: '12px',
                                border: '1px solid #d9dce5', borderRadius: '6px', outline: 'none'
                            }}
                            type="text"
                            value={this.state.saveName}
                        />
                        <button
                            onClick={this.handleSave}
                            style={{
                                border: 'none', background: '#4caf50', color: '#fff',
                                borderRadius: '6px', padding: '5px 10px', fontSize: '12px',
                                fontWeight: 'bold', cursor: 'pointer'
                            }}
                        >
                            {'💾 Save'}
                        </button>
                    </div>
                    <div style={{maxHeight: '150px', overflowY: 'auto'}}>
                        {(this.state.projects || []).map(p => (
                            <div
                                key={p.id}
                                style={{display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 0', fontSize: '12px', color: '#575e75'}}
                            >
                                <div style={{flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>
                                    <span style={{fontWeight: 'bold'}}>{p.name}</span>
                                    <div style={{fontSize: '10px', opacity: 0.6}}>
                                        {`${p.owner} · ${new Date(p.updatedAt).toLocaleDateString()}`}
                                    </div>
                                </div>
                                <button
                                    onClick={() => this.handleOpenProject(p.id)}
                                    style={{
                                        border: 'none', borderRadius: '6px', padding: '4px 9px',
                                        fontSize: '11px', fontWeight: 'bold', cursor: 'pointer',
                                        background: this.state.confirmOpenId === p.id ? '#ff9800' : '#4c97ff',
                                        color: '#fff', flexShrink: 0
                                    }}
                                >
                                    {this.state.confirmOpenId === p.id ? 'For everyone?' : 'Open'}
                                </button>
                            </div>
                        ))}
                        {(this.state.projects || []).length === 0 ? (
                            <div style={{fontSize: '11px', color: '#8a8fa3'}}>
                                {'No saved projects yet. The room auto-saves anyway — this is for named copies.'}
                            </div>
                        ) : null}
                    </div>
                </div>
            </div>
        ) : null;

        return (
            <div
                ref={this.setRootRef}
                style={{position: 'relative', display: 'flex', alignItems: 'center', padding: '0 8px'}}
            >
                {button}
                {panel}
            </div>
        );
    }
}

export default CollabPresence;
