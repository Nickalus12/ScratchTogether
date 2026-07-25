/* Name-only login overlay. Resolves with {name, room, url}. Pure DOM, no React.
 * Shows live rooms (with who's online right now) fetched from the collab
 * server so joining the family session is one tap instead of typed-from-memory. */

const defaultServerUrl = () => {
    const params = new URLSearchParams(location.search);
    if (params.get('server')) return params.get('server');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    // Dev server (8601) -> collab server on 4455. Production -> same host:port.
    if (location.port === '8601') return `ws://${location.hostname}:4455`;
    return `${proto}://${location.host}`;
};

// The HTTP side of the same server (room list API).
const apiBase = () => {
    if (location.port === '8601') return `http://${location.hostname}:4455`;
    return '';
};

const ROOM_EMOJI = ['🚀', '🐱', '🌈', '🎮', '🦄', '🤖', '🐸', '⭐', '🎲', '🧠'];
const emojiFor = room =>
    ROOM_EMOJI[[...String(room)].reduce((a, c) => a + c.charCodeAt(0), 0) % ROOM_EMOJI.length];

const showLogin = () => new Promise(resolve => {
    const params = new URLSearchParams(location.search);
    const savedName = (params.get('name') || localStorage.getItem('st_name') || '').trim();
    const savedRoom = (params.get('room') || localStorage.getItem('st_room') || 'family').trim();

    // Coming from the homescreen: name + room already chosen there, skip the modal.
    if (params.get('auto') === '1' && savedName && savedRoom) {
        localStorage.setItem('st_name', savedName);
        localStorage.setItem('st_room', savedRoom);
        resolve({name: savedName, room: savedRoom, url: defaultServerUrl()});
        return;
    }

    const overlay = document.createElement('div');
    overlay.id = 'st-login';

    const style = document.createElement('style');
    style.textContent = `
      #st-login{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;
        background:linear-gradient(135deg,#4c97ff 0%,#9966ff 100%);
        font-family:"Helvetica Neue",Helvetica,Arial,sans-serif}
      #st-login .st-card{background:#fff;border-radius:20px;padding:30px 34px 26px;max-width:420px;width:92%;
        box-shadow:0 20px 60px rgba(0,0,0,.35);text-align:center;
        animation:st-pop .35s cubic-bezier(.2,1.4,.4,1)}
      @keyframes st-pop{from{opacity:0;transform:scale(.92) translateY(14px)}to{opacity:1;transform:none}}
      #st-login h1{margin:6px 0 2px;font-size:25px;color:#575e75}
      #st-login .st-sub{margin:0 0 18px;color:#8a8fa3;font-size:14px}
      #st-login input{width:100%;box-sizing:border-box;padding:12px 14px;font-size:17px;
        border:2px solid #d9dce5;border-radius:12px;outline:none;transition:border-color .15s}
      #st-login input:focus{border-color:#4c97ff}
      #st-login .st-label{display:block;text-align:left;font-size:12px;font-weight:bold;color:#8a8fa3;
        text-transform:uppercase;letter-spacing:.4px;margin:14px 0 6px}
      #st-login .st-rooms{display:flex;flex-direction:column;gap:6px;max-height:180px;overflow-y:auto;
        margin-bottom:4px}
      #st-login .st-room{display:flex;align-items:center;gap:10px;padding:9px 12px;border:2px solid #d9dce5;
        border-radius:12px;cursor:pointer;text-align:left;background:#fff;transition:border-color .12s,background .12s}
      #st-login .st-room:hover{border-color:#9db9ff}
      #st-login .st-room.st-picked{border-color:#4c97ff;background:#eef4ff}
      #st-login .st-room .st-emoji{font-size:22px}
      #st-login .st-room .st-rname{font-size:15px;font-weight:bold;color:#3b3f4d;text-transform:capitalize}
      #st-login .st-room .st-who{font-size:12px;color:#8a8fa3;margin-top:1px}
      #st-login .st-room .st-dot{width:8px;height:8px;border-radius:50%;background:#4caf50;display:inline-block;
        margin-right:4px;vertical-align:1px}
      #st-login .st-join{width:100%;padding:13px;font-size:17px;font-weight:bold;color:#fff;margin-top:16px;
        background:#4c97ff;border:none;border-radius:12px;cursor:pointer;transition:transform .1s,background .15s}
      #st-login .st-join:hover{background:#3d84e6;transform:translateY(-1px)}
      #st-login .st-join:disabled{background:#b9c3d4;cursor:default;transform:none}
      #st-login .st-solo{color:#8a8fa3;font-size:13px;text-decoration:underline;cursor:pointer}
      #st-login .st-err{color:#e91e63;font-size:13px;margin-top:8px;min-height:16px}
    `;
    overlay.appendChild(style);

    const card = document.createElement('div');
    card.className = 'st-card';
    overlay.appendChild(card);

    // -- header --------------------------------------------------------------
    const logo = document.createElement('div');
    logo.style.fontSize = '40px';
    logo.textContent = '🧩';
    const h1 = document.createElement('h1');
    h1.textContent = 'Scratch Together';
    const sub = document.createElement('p');
    sub.className = 'st-sub';
    sub.textContent = 'Code with your family — live.';
    card.append(logo, h1, sub);

    // -- name ----------------------------------------------------------------
    const nameLabel = document.createElement('span');
    nameLabel.className = 'st-label';
    nameLabel.textContent = savedName ? `Welcome back, ${savedName}!` : "What's your name?";
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.maxLength = 30;
    nameInput.placeholder = 'Your name';
    nameInput.autocomplete = 'off';
    nameInput.value = savedName;
    card.append(nameLabel, nameInput);

    // -- rooms ---------------------------------------------------------------
    const roomLabel = document.createElement('span');
    roomLabel.className = 'st-label';
    roomLabel.textContent = 'Pick a room';
    const roomList = document.createElement('div');
    roomList.className = 'st-rooms';
    const roomInput = document.createElement('input');
    roomInput.type = 'text';
    roomInput.maxLength = 40;
    roomInput.placeholder = 'or type a new room name…';
    roomInput.autocomplete = 'off';
    roomInput.style.fontSize = '14px';
    roomInput.style.padding = '10px 14px';
    card.append(roomLabel, roomList, roomInput);

    let pickedRoom = savedRoom;
    const paintPicked = () => {
        for (const el of roomList.children) {
            el.classList.toggle('st-picked', el.dataset.room === pickedRoom && !roomInput.value.trim());
        }
    };
    roomInput.addEventListener('input', paintPicked);

    const addRoomChip = (room, online) => {
        const chip = document.createElement('div');
        chip.className = 'st-room';
        chip.dataset.room = room;
        const emoji = document.createElement('span');
        emoji.className = 'st-emoji';
        emoji.textContent = emojiFor(room);
        const text = document.createElement('div');
        const rname = document.createElement('div');
        rname.className = 'st-rname';
        rname.textContent = room.replace(/[-_]/g, ' ');
        const who = document.createElement('div');
        who.className = 'st-who';
        if (online && online.length) {
            const dot = document.createElement('span');
            dot.className = 'st-dot';
            who.appendChild(dot);
            who.appendChild(document.createTextNode(online.join(', ')));
        } else {
            who.textContent = 'nobody here yet';
        }
        text.append(rname, who);
        chip.append(emoji, text);
        chip.addEventListener('click', () => {
            pickedRoom = room;
            roomInput.value = '';
            paintPicked();
            if (nameInput.value.trim()) submit();
            else nameInput.focus();
        });
        roomList.appendChild(chip);
    };

    const renderRooms = rooms => {
        roomList.innerHTML = '';
        // Busiest first, then most recently used; saved room floats up.
        rooms.sort((a, b) =>
            (b.room === savedRoom) - (a.room === savedRoom) ||
            (b.online.length - a.online.length) ||
            (b.updatedAt - a.updatedAt));
        for (const r of rooms.slice(0, 8)) addRoomChip(r.room, r.online);
        if (!rooms.some(r => r.room === pickedRoom)) addRoomChip(pickedRoom, []);
        paintPicked();
    };

    renderRooms([]); // show the saved room immediately; live list replaces it
    fetch(`${apiBase()}/api/rooms`)
        .then(r => r.json())
        .then(rooms => renderRooms(Array.isArray(rooms) ? rooms : []))
        .catch(() => { /* server unreachable — typed room still works */ });

    // -- actions -------------------------------------------------------------
    const joinBtn = document.createElement('button');
    joinBtn.className = 'st-join';
    joinBtn.textContent = 'Join & code together';
    const soloWrap = document.createElement('div');
    soloWrap.style.marginTop = '12px';
    const solo = document.createElement('a');
    solo.className = 'st-solo';
    solo.textContent = 'play solo (no multiplayer)';
    soloWrap.appendChild(solo);
    const err = document.createElement('div');
    err.className = 'st-err';
    card.append(joinBtn, soloWrap, err);

    document.body.appendChild(overlay);
    nameInput.focus();
    if (savedName) nameInput.select();

    const submit = () => {
        const name = nameInput.value.trim();
        const room = roomInput.value.trim() || pickedRoom || 'family';
        if (!name) {
            err.textContent = 'Just type your name — that’s all you need!';
            nameInput.focus();
            return;
        }
        localStorage.setItem('st_name', name);
        localStorage.setItem('st_room', room);
        overlay.remove();
        resolve({name, room, url: defaultServerUrl()});
    };

    joinBtn.addEventListener('click', submit);
    overlay.addEventListener('keydown', e => {
        if (e.key === 'Enter') submit();
    });
    solo.addEventListener('click', e => {
        e.preventDefault();
        overlay.remove();
        resolve(null);
    });
});

export default showLogin;
