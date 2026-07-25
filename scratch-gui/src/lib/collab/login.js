/* Name-only login overlay. Resolves with {name, room, url}. Pure DOM, no React. */

const defaultServerUrl = () => {
    const params = new URLSearchParams(location.search);
    if (params.get('server')) return params.get('server');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    // Dev server (8601) -> collab server on 4455. Production -> same host:port.
    if (location.port === '8601') return `ws://${location.hostname}:4455`;
    return `${proto}://${location.host}`;
};

const showLogin = () => new Promise(resolve => {
    const params = new URLSearchParams(location.search);
    const savedName = params.get('name') || localStorage.getItem('st_name') || '';
    const savedRoom = params.get('room') || localStorage.getItem('st_room') || 'family';

    // Coming from the homescreen: name + room already chosen there, skip the modal.
    if (params.get('auto') === '1' && savedName.trim() && savedRoom.trim()) {
        localStorage.setItem('st_name', savedName.trim());
        localStorage.setItem('st_room', savedRoom.trim());
        resolve({name: savedName.trim(), room: savedRoom.trim(), url: defaultServerUrl()});
        return;
    }

    const overlay = document.createElement('div');
    overlay.id = 'st-login';
    overlay.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:99999',
        'background:linear-gradient(135deg,#4c97ff 0%,#9966ff 100%)',
        'display:flex', 'align-items:center', 'justify-content:center',
        'font-family:"Helvetica Neue",Helvetica,Arial,sans-serif'
    ].join(';');

    overlay.innerHTML = `
      <div style="background:#fff;border-radius:16px;padding:36px 40px;max-width:380px;width:90%;
                  box-shadow:0 20px 60px rgba(0,0,0,.35);text-align:center">
        <div style="font-size:40px">🧩</div>
        <h1 style="margin:8px 0 2px;font-size:26px;color:#575e75">Scratch Together</h1>
        <p style="margin:0 0 22px;color:#8a8fa3;font-size:14px">Code with your family — live.</p>
        <input id="st-name" type="text" maxlength="30" placeholder="Your name" value="${savedName.replace(/"/g, '&quot;')}"
               style="width:100%;box-sizing:border-box;padding:12px 14px;font-size:17px;border:2px solid #4c97ff;
                      border-radius:10px;margin-bottom:12px;outline:none" autocomplete="off"/>
        <input id="st-room" type="text" maxlength="40" placeholder="Room (share this with your partner)" value="${savedRoom.replace(/"/g, '&quot;')}"
               style="width:100%;box-sizing:border-box;padding:10px 14px;font-size:14px;border:2px solid #d9dce5;
                      border-radius:10px;margin-bottom:18px;outline:none" autocomplete="off"/>
        <button id="st-join" style="width:100%;padding:13px;font-size:17px;font-weight:bold;color:#fff;
                background:#4c97ff;border:none;border-radius:10px;cursor:pointer">Join &amp; code together</button>
        <div style="margin-top:14px">
          <a id="st-solo" href="#" style="color:#8a8fa3;font-size:13px;text-decoration:underline">play solo (no multiplayer)</a>
        </div>
        <div id="st-err" style="color:#e91e63;font-size:13px;margin-top:10px;min-height:16px"></div>
      </div>`;

    document.body.appendChild(overlay);
    const nameInput = overlay.querySelector('#st-name');
    const roomInput = overlay.querySelector('#st-room');
    const errEl = overlay.querySelector('#st-err');
    nameInput.focus();
    if (savedName) nameInput.select();

    const submit = () => {
        const name = nameInput.value.trim();
        const room = roomInput.value.trim() || 'family';
        if (!name) {
            errEl.textContent = 'Just type your name — that’s all you need!';
            nameInput.focus();
            return;
        }
        localStorage.setItem('st_name', name);
        localStorage.setItem('st_room', room);
        overlay.remove();
        resolve({name, room, url: defaultServerUrl()});
    };

    overlay.querySelector('#st-join').addEventListener('click', submit);
    overlay.addEventListener('keydown', e => {
        if (e.key === 'Enter') submit();
    });
    overlay.querySelector('#st-solo').addEventListener('click', e => {
        e.preventDefault();
        overlay.remove();
        resolve(null);
    });
});

export default showLogin;
