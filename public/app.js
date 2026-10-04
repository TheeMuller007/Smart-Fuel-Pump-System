/* Smart Fuel Portal — vanilla JS SPA (hash routing) */
(() => {
  const app = document.getElementById('app');
  const nav = document.getElementById('nav');
  const chip = document.getElementById('user-chip');

  const state = {
    get token() { return localStorage.getItem('accessToken') || ''; },
    get refresh() { return localStorage.getItem('refreshToken') || ''; },
    get user() { try { return JSON.parse(localStorage.getItem('user') || 'null'); } catch { return null; } },
  };

  function saveSession(accessToken, refreshToken, user) {
    localStorage.setItem('accessToken', accessToken);
    localStorage.setItem('refreshToken', refreshToken);
    localStorage.setItem('user', JSON.stringify(user));
  }
  function clearSession() {
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('user');
  }

  async function rawApi(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    return fetch(path, { ...options, headers });
  }

  async function api(path, options = {}, retried = false) {
    const res = await rawApi(path, options);
    if (res.status === 403 && !retried && state.refresh) {
      const body = await res.clone().json().catch(() => ({}));
      if (body.message === 'Access token expired') {
        const r = await fetch('/api/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: state.refresh }),
        });
        if (r.ok) {
          const data = await r.json();
          saveSession(data.accessToken, data.refreshToken, data.user || state.user);
          return api(path, options, true);
        }
        clearSession();
        location.hash = '#/login';
      }
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || 'Request failed (' + res.status + ')');
    return data;
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (v) => Number(v ?? 0).toFixed(2);
  const ref = (r) => '<span class="mono">' + esc(r || '-') + '</span>';
  const badge = (s) => '<span class="badge ' + esc(s) + '">' + esc(s) + '</span>';

  // ---------------- chrome ----------------

  function renderChrome() {
    const user = state.user;
    const links = [];
    if (user && user.role === 'customer') {
      links.push(['#/dashboard', 'Dashboard'], ['#/request-fuel', 'Request Fuel'], ['#/wallet', 'Wallet'], ['#/transactions', 'History']);
    } else if (user && (user.role === 'staff' || user.role === 'admin')) {
      links.push(['#/staff', 'Fuel Desk']);
      links.push(['#/staff-deposits', 'Cash Deposits']);
      if (user.role === 'admin') links.push(['#/admin/fuel-types', 'Fuel Types']);
    }
    nav.innerHTML = links.map(([h, t]) => '<a href="' + h + '" data-h="' + h + '">' + t + '</a>').join('');
    if (user) {
      chip.innerHTML = '<span>' + esc(user.full_name || user.username) + ' · ' + esc(user.role) + '</span>' +
        '<button class="small" id="btn-logout">Log out</button>';
      document.getElementById('btn-logout').onclick = async () => {
        try { await rawApi('/api/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken: state.refresh }) }); } catch { /* ignore */ }
        clearSession();
        location.hash = '#/login';
      };
    } else {
      chip.innerHTML = '';
    }
    document.querySelectorAll('nav a').forEach((a) => {
      a.classList.toggle('active', a.getAttribute('data-h') === location.hash || (location.hash.startsWith('#/admin') && a.getAttribute('data-h') === '#/admin/fuel-types'));
    });
  }

  function requireRole(roles) {
    const user = state.user;
    if (!user || !roles.includes(user.role)) { location.hash = '#/login'; return false; }
    return true;
  }

  // ---------------- auth views ----------------

  function loginView() {
    let portal = 'customer';
    app.innerHTML =
      '<div class="auth-wrap"><h2>Sign in</h2>' +
      '<div class="tabs"><button id="tab-c" class="active">Customer Portal</button><button id="tab-s">Staff Portal</button></div>' +
      '<div class="card"><div id="login-error"></div>' +
      '<label>Email (or staff username)</label><input id="l-user" placeholder="you@example.com" />' +
      '<label>Password</label><input id="l-pass" type="password" placeholder="••••••••" />' +
      '<div style="margin-top:14px"><button class="primary" id="l-go" style="width:100%">Sign in</button></div>' +
      '<p class="muted" style="margin-bottom:0">No account? <a href="#/register">Register as customer</a></p>' +
      '</div></div>';

    const tabC = document.getElementById('tab-c');
    const tabS = document.getElementById('tab-s');
    tabC.onclick = () => { portal = 'customer'; tabC.classList.add('active'); tabS.classList.remove('active'); };
    tabS.onclick = () => { portal = 'staff'; tabS.classList.add('active'); tabC.classList.remove('active'); };

    document.getElementById('l-go').onclick = async () => {
      const email = document.getElementById('l-user').value.trim();
      const password = document.getElementById('l-pass').value;
      const errBox = document.getElementById('login-error');
      errBox.innerHTML = '';
      try {
        const data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
        const isStaff = data.user.role !== 'customer';
        if ((portal === 'staff') !== isStaff) {
          errBox.innerHTML = '<div class="error-box">Those credentials belong to the ' + (isStaff ? 'staff' : 'customer') + ' portal.</div>';
          return;
        }
        saveSession(data.accessToken, data.refreshToken, data.user);
        location.hash = isStaff ? '#/staff' : '#/dashboard';
      } catch (e) {
        errBox.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>';
      }
    };
  }

  function registerView() {
    app.innerHTML =
      '<div class="auth-wrap"><h2>Create customer account</h2><div class="card"><div id="reg-msg"></div>' +
      '<label>Full name</label><input id="r-name" />' +
      '<label>Email</label><input id="r-email" type="email" />' +
      '<label>Phone (optional)</label><input id="r-phone" placeholder="+1555…" />' +
      '<label>Password (min 8 chars)</label><input id="r-pass" type="password" />' +
      '<div style="margin-top:14px"><button class="primary" id="r-go" style="width:100%">Register</button></div>' +
      '<p class="muted" style="margin-bottom:0">Already registered? <a href="#/login">Sign in</a></p>' +
      '</div></div>';

    document.getElementById('r-go').onclick = async () => {
      const msg = document.getElementById('reg-msg');
      msg.innerHTML = '';
      try {
        const data = await api('/api/customers/register', {
          method: 'POST',
          body: JSON.stringify({
            full_name: document.getElementById('r-name').value.trim(),
            email: document.getElementById('r-email').value.trim(),
            phone: document.getElementById('r-phone').value.trim(),
            password: document.getElementById('r-pass').value,
          }),
        });
        saveSession(data.accessToken, data.refreshToken, data.user);
        location.hash = '#/dashboard';
      } catch (e) {
        msg.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>';
      }
    };
  }

  // ---------------- customer views ----------------

  async function dashboardView() {
    if (!requireRole(['customer'])) return;
    app.innerHTML = '<h2>Dashboard</h2><div id="dash"><p class="muted">Loading…</p></div>';
    const root = document.getElementById('dash');
    let wallet, requests;
    try {
      [wallet, requests] = await Promise.all([api('/api/wallet'), api('/api/fuel-requests')]);
    } catch (e) { root.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>'; return; }

    root.innerHTML =
      '<div class="card"><h3>Wallet</h3><div class="balances">' +
      '<div class="balance available"><div class="label">Available</div><div class="value">' + money(wallet.available_balance) + ' ' + esc(wallet.currency) + '</div></div>' +
      '<div class="balance reserved"><div class="label">Reserved</div><div class="value">' + money(wallet.reserved_balance) + ' ' + esc(wallet.currency) + '</div></div>' +
      '</div><div class="row" style="margin-top:14px"><div><label>Deposit amount</label><input id="d-amt" type="number" min="1" step="0.01" placeholder="50.00" /></div>' +
      '<button class="success" id="d-go">Deposit cash</button></div><div id="d-msg"></div></div>' +

      '<p class="muted">Need fuel? <a href="#/request-fuel">Open the Request Fuel page →</a></p>' +

      '<div class="card"><h3>My requests</h3>' +
      (requests.length === 0 ? '<p class="muted">No requests yet.</p>' :
        '<table><thead><tr><th>Reference</th><th>Station</th><th>Fuel</th><th>Litres</th><th>Amount</th><th>Status</th><th></th></tr></thead><tbody>' +
        requests.map((r) =>
          '<tr><td>' + ref(r.request_reference) + '</td><td>' + esc(r.station.name) + '</td><td>' + esc(r.fuel_type.name) + '</td>' +
          '<td>' + Number(r.requested_litres).toFixed(3) + '</td><td>' + money(r.requested_amount) + '</td><td>' + badge(r.status) + '</td>' +
          '<td>' + (r.status === 'RESERVED' ? '<button class="small danger" data-cancel="' + r.id + '">Cancel</button>' : '') + '</td></tr>'
        ).join('') + '</tbody></table>') + '</div>';

    document.getElementById('d-go').onclick = async () => {
      const amt = document.getElementById('d-amt').value;
      const msg = document.getElementById('d-msg');
      msg.innerHTML = '';
      try {
        await api('/api/wallet/deposit', { method: 'POST', body: JSON.stringify({ amount: amt }) });
        dashboardView();
      } catch (e) { msg.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>'; }
    };

    root.querySelectorAll('[data-cancel]').forEach((btn) => {
      btn.onclick = async () => {
        try { await api('/api/fuel-requests/' + btn.getAttribute('data-cancel') + '/cancel', { method: 'POST' }); dashboardView(); }
        catch (e) { alert(e.message); }
      };
    });
  }

  function walletView() {
    if (!requireRole(['customer'])) return;
    app.innerHTML = '<h2>Wallet</h2><div id="w"><p class="muted">Loading…</p></div>';
    api('/api/wallet').then((wallet) => {
      document.getElementById('w').innerHTML =
        '<div class="card"><div class="balances">' +
        '<div class="balance available"><div class="label">Available</div><div class="value">' + money(wallet.available_balance) + ' ' + esc(wallet.currency) + '</div></div>' +
        '<div class="balance reserved"><div class="label">Reserved</div><div class="value">' + money(wallet.reserved_balance) + ' ' + esc(wallet.currency) + '</div></div>' +
        '</div><div class="row" style="margin-top:14px"><div><label>Deposit amount</label><input id="w-amt" type="number" min="1" step="0.01" /></div>' +
        '<button class="success" id="w-go">Deposit cash</button></div><div id="w-msg"></div></div>';
      document.getElementById('w-go').onclick = async () => {
        try {
          await api('/api/wallet/deposit', { method: 'POST', body: JSON.stringify({ amount: document.getElementById('w-amt').value }) });
          walletView();
        } catch (e) { document.getElementById('w-msg').innerHTML = '<div class="error-box">' + esc(e.message) + '</div>'; }
      };
    }).catch((e) => { document.getElementById('w').innerHTML = '<div class="error-box">' + esc(e.message) + '</div>'; });
  }

  let txPage = 1;
  async function transactionsView(page) {
    if (!requireRole(['customer'])) return;
    txPage = page || txPage;
    app.innerHTML = '<h2>Transaction history</h2><div id="t"><p class="muted">Loading…</p></div>';
    const root = document.getElementById('t');
    try {
      const data = await api('/api/wallet/transactions?page=' + txPage + '&limit=15');
      root.innerHTML =
        '<div class="card"><table><thead><tr><th>Date</th><th>Type</th><th>Reference</th><th>Amount</th><th>Balance</th><th>Description</th></tr></thead><tbody>' +
        data.items.map((t) => {
          const delta = ['CASH_DEPOSIT', 'REFUND'].includes(t.type) || t.type === 'RELEASE';
          return '<tr><td>' + new Date(t.created_at).toLocaleString() + '</td><td>' + badge(t.type) + '</td><td>' + ref(t.reference) + '</td>' +
            '<td class="' + (delta ? 'pos' : 'neg') + '">' + (delta ? '+' : '−') + money(t.amount) + '</td>' +
            '<td>' + money(t.balance_after) + '</td><td class="muted">' + esc(t.description || '') + '</td></tr>';
        }).join('') + '</tbody></table>' +
        '<div class="pager"><button id="p-prev" ' + (data.page <= 1 ? 'disabled' : '') + '>‹ Prev</button>' +
        '<span class="muted">Page ' + data.page + ' / ' + data.total_pages + ' · ' + data.total + ' entries</span>' +
        '<button id="p-next" ' + (data.page >= data.total_pages ? 'disabled' : '') + '>Next ›</button></div></div>';
      document.getElementById('p-prev').onclick = () => transactionsView(data.page - 1);
      document.getElementById('p-next').onclick = () => transactionsView(data.page + 1);
    } catch (e) { root.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>'; }
  }

  // ---------------- request fuel view (stage 6) ----------------

  async function requestFuelView() {
    if (!requireRole(['customer'])) return;
    app.innerHTML = '<h2>Request fuel</h2><div id="rf"><p class="muted">Loading…</p></div>';
    const root = document.getElementById('rf');
    let wallet, stations, fuelTypes;
    try {
      [wallet, stations, fuelTypes] = await Promise.all([
        api('/api/wallet'),
        api('/api/stations'),
        api('/api/fuel-types'),
      ]);
    } catch (e) { root.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>'; return; }

    root.innerHTML =
      '<div class="card"><h3>Estimate &amp; reserve</h3><div id="rf-msg"></div>' +
      '<div class="row"><div><label>Station</label><select id="rf-station">' + stations.map((s) => '<option value="' + s.id + '">' + esc(s.name) + ' — ' + esc(s.location) + '</option>').join('') + '</select></div>' +
      '<div><label>Fuel type</label><select id="rf-fuel">' + fuelTypes.map((f) => '<option value="' + f.id + '">' + esc(f.name) + ' — ' + money(f.price_per_litre) + '/L</option>').join('') + '</select></div></div>' +
      '<div class="row"><div><label>Pump (optional)</label><select id="rf-pump"><option value="">Any / staff assigns later</option></select></div>' +
      '<div><label>Litres</label><input id="rf-litres" type="number" min="0.001" step="0.001" placeholder="10" /></div></div>' +
      '<div id="rf-estimate" style="margin-top:14px"></div>' +
      '<div style="margin-top:14px"><button class="primary" id="rf-go" disabled>Reserve &amp; submit request</button></div>' +
      '<p class="muted">Submitting moves the estimated cost from available to <b>reserved</b> balance. Staff have 15 minutes to accept; otherwise funds are released automatically.</p></div>';

    const updateEstimate = () => {
      const fuel = fuelTypes.find((f) => f.id === document.getElementById('rf-fuel').value);
      const litres = parseFloat(document.getElementById('rf-litres').value || '0');
      const price = fuel ? Number(fuel.price_per_litre) : 0;
      const cost = litres > 0 ? litres * price : 0;
      const available = Number(wallet.available_balance);
      const affordable = cost > 0 && cost <= available;
      document.getElementById('rf-estimate').innerHTML =
        '<div class="balances">' +
        '<div class="balance"><div class="label">Estimated cost</div><div class="value">' + money(cost) + ' ' + esc(wallet.currency) + '</div></div>' +
        '<div class="balance available"><div class="label">Available now</div><div class="value">' + money(available) + ' ' + esc(wallet.currency) + '</div></div>' +
        '</div>' +
        (litres > 0 && cost > available ? '<div class="error-box" style="margin-top:10px">Insufficient balance for this request.</div>' : '');
      document.getElementById('rf-go').disabled = !affordable;
    };
    document.getElementById('rf-fuel').onchange = updateEstimate;
    document.getElementById('rf-litres').oninput = updateEstimate;

    const pumpSel = document.getElementById('rf-pump');
    const loadPumps = async () => {
      pumpSel.innerHTML = '<option value="">Any / staff assigns later</option>';
      try {
        const pumps = await api('/api/stations/' + document.getElementById('rf-station').value + '/pumps');
        pumps.filter((p) => p.status === 'AVAILABLE').forEach((p) => {
          pumpSel.innerHTML += '<option value="' + p.id + '">Pump ' + p.pump_number + ' — ' + esc(p.fuel_type.name) + '</option>';
        });
      } catch { /* ignore */ }
    };
    document.getElementById('rf-station').onchange = loadPumps;
    loadPumps();

    document.getElementById('rf-go').onclick = async () => {
      const msg = document.getElementById('rf-msg');
      msg.innerHTML = '';
      try {
        const r = await api('/api/fuel-requests', {
          method: 'POST',
          body: JSON.stringify({
            station_id: document.getElementById('rf-station').value,
            fuel_type_id: document.getElementById('rf-fuel').value,
            pump_id: pumpSel.value || undefined,
            requested_litres: document.getElementById('rf-litres').value,
          }),
        });
        root.innerHTML =
          '<div class="card"><h3>Request created</h3>' +
          '<p>Reference ' + ref(r.request_reference) + ' ' + badge(r.status) + '</p>' +
          '<div class="balances">' +
          '<div class="balance"><div class="label">Litres</div><div class="value">' + Number(r.requested_litres).toFixed(3) + '</div></div>' +
          '<div class="balance reserved"><div class="label">Reserved from wallet</div><div class="value">' + money(r.requested_amount) + ' ' + esc(wallet.currency) + '</div></div>' +
          '</div>' +
          '<p class="muted">Funds are held until station staff accept or reject the request.</p>' +
          '<div class="row"><a href="#/dashboard"><button>Back to dashboard</button></a>' +
          '<a href="#/request-fuel"><button class="primary">New request</button></a></div></div>';
      } catch (e) {
        msg.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>';
      }
    };
  }

  // ---------------- staff views ----------------

  async function staffView() {
    if (!requireRole(['staff', 'admin'])) return;
    app.innerHTML = '<h2>Fuel desk</h2><div id="s"><p class="muted">Loading…</p></div>';
    const root = document.getElementById('s');
    let pending, txns, pumps;
    try {
      [pending, txns, pumps] = await Promise.all([
        api('/api/staff/pending-requests'),
        api('/api/staff/fuel-transactions'),
        api('/api/stations/' + state.user.station_id + '/pumps').catch(() => []),
      ]);
    } catch (e) { root.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>'; return; }

    root.innerHTML =
      '<div class="card"><h3>Pending requests</h3>' +
      (pending.length === 0 ? '<p class="muted">Nothing waiting.</p>' :
        '<table><thead><tr><th>Reference</th><th>Customer</th><th>Fuel</th><th>Litres</th><th>Amount</th><th>Status</th><th>Actions</th></tr></thead><tbody>' +
        pending.map((r) =>
          '<tr><td>' + ref(r.request_reference) + '</td><td>' + esc(r.user.full_name) + '</td><td>' + esc(r.fuel_type.name) + '</td>' +
          '<td>' + Number(r.requested_litres).toFixed(3) + '</td><td>' + money(r.requested_amount) + '</td><td>' + badge(r.status) + '</td>' +
          '<td>' +
          (r.pump_id ? '<span class="muted">Pump ' + (r.pump ? r.pump.pump_number : '?') + ' assigned</span><br/>' : '') +
          (r.status === 'RESERVED' ? '<button class="small success" data-accept="' + r.id + '">Accept</button> ' : '') +
          '<button class="small danger" data-reject="' + r.id + '">Reject</button>' +
          '<div style="margin-top:6px">' +
          (r.pump_id ? '' :
            '<select class="pump-pick" data-req="' + r.id + '"><option value="">— assign pump —</option>' +
            pumps.filter((p) => p.status === 'AVAILABLE' && p.fuel_type.id === r.fuel_type_id)
              .map((p) => '<option value="' + p.id + '">Pump ' + p.pump_number + '</option>').join('') + '</select> ' +
            '<button class="small" data-assign="' + r.id + '">Assign</button> ') +
          '<button class="small primary" data-auth="' + r.id + '" ' + (r.pump_id ? '' : 'disabled title="Assign a pump first"') + '>Authorize</button>' +
          '</div>' +
          '</td></tr>'
        ).join('') + '</tbody></table>') + '</div>' +

      '<div class="card"><h3>Station transactions</h3>' +
      (txns.length === 0 ? '<p class="muted">No transactions yet.</p>' :
        '<table><thead><tr><th>Reference</th><th>Customer</th><th>Fuel</th><th>Authorized</th><th>Actual</th><th>Final</th><th>Status</th><th></th></tr></thead><tbody>' +
        txns.map((t) =>
          '<tr><td>' + ref(t.transaction_reference) + '</td><td>' + esc(t.user.full_name) + '</td><td>' + esc(t.fuel_type.name) + '</td>' +
          '<td>' + Number(t.authorized_litres).toFixed(3) + ' L / ' + money(t.authorized_amount) + '</td>' +
          '<td>' + (t.actual_litres ? Number(t.actual_litres).toFixed(3) + ' L' : '—') + '</td>' +
          '<td>' + (t.final_amount != null ? money(t.final_amount) : '—') + '</td><td>' + badge(t.status) + '</td>' +
          '<td>' + (t.status === 'AUTHORIZED' ? '<span class="row"><input class="small actual" style="width:90px" type="number" step="0.001" min="0.001" max="' + Number(t.authorized_litres) + '" placeholder="litres" data-txn="' + t.id + '" /><button class="small primary" data-done="' + t.id + '">Complete</button></span>' : '') + '</td></tr>'
        ).join('') + '</tbody></table>') + '</div>';

    root.querySelectorAll('[data-assign]').forEach((btn) => {
      btn.onclick = async () => {
        const pick = root.querySelector('.pump-pick[data-req="' + btn.getAttribute('data-assign') + '"]');
        if (!pick || !pick.value) { alert('Pick a pump to assign first.'); return; }
        try {
          await api('/api/staff/requests/' + btn.getAttribute('data-assign') + '/assign-pump', {
            method: 'POST', body: JSON.stringify({ pump_id: pick.value }),
          });
          staffView();
        } catch (e) { alert(e.message); }
      };
    });
    root.querySelectorAll('[data-auth]').forEach((btn) => {
      btn.onclick = async () => {
        try {
          await api('/api/staff/fuel-requests/' + btn.getAttribute('data-auth') + '/authorize', {
            method: 'POST', body: JSON.stringify({}),
          });
          staffView();
        } catch (e) { alert(e.message); }
      };
    });
    root.querySelectorAll('[data-accept]').forEach((btn) => {
      btn.onclick = async () => {
        try { await api('/api/staff/requests/' + btn.getAttribute('data-accept') + '/accept', { method: 'POST' }); staffView(); }
        catch (e) { alert(e.message); }
      };
    });
    root.querySelectorAll('[data-reject]').forEach((btn) => {
      btn.onclick = async () => {
        try { await api('/api/staff/requests/' + btn.getAttribute('data-reject') + '/reject', { method: 'POST' }); staffView(); }
        catch (e) { alert(e.message); }
      };
    });
    root.querySelectorAll('[data-done]').forEach((btn) => {
      btn.onclick = async () => {
        const input = root.querySelector('.actual[data-txn="' + btn.getAttribute('data-done') + '"]');
        try {
          await api('/api/staff/fuel-transactions/' + btn.getAttribute('data-done') + '/complete', {
            method: 'POST', body: JSON.stringify({ actual_litres: input.value }),
          });
          staffView();
        } catch (e) { alert(e.message); }
      };
    });
  }

  function depositsView() {
    if (!requireRole(['staff', 'admin'])) return;
    app.innerHTML =
      '<h2>Cash deposits</h2>' +
      '<div class="card"><h3>Find a customer</h3>' +
      '<div class="row"><div><label>Search by phone, name or email</label><input id="c-q" placeholder="+1555… or name" /></div>' +
      '<button class="primary" id="c-go">Search</button></div><div id="c-results"></div></div>' +
      '<div class="card"><h3>How it works</h3><p class="muted">Search a customer, open the deposit modal, confirm the cash amount. ' +
      'The wallet is credited instantly and the deposit is recorded in the audit log under your staff ID.</p></div>';

    const results = document.getElementById('c-results');
    const search = async () => {
      const q = document.getElementById('c-q').value.trim();
      results.innerHTML = '<p class="muted">Searching…</p>';
      try {
        const list = await api('/api/staff/customers?phone=' + encodeURIComponent(q));
        if (list.length === 0) { results.innerHTML = '<div class="error-box">No customers matched.</div>'; return; }
        results.innerHTML = list.map((c) =>
          '<div class="search-result"><div class="who"><div class="name">' + esc(c.full_name) + '</div>' +
          '<div class="sub">' + esc(c.phone || 'no phone') + ' · ' + esc(c.email) + '</div></div>' +
          '<div class="bal">' + (c.wallet ? money(c.wallet.available_balance) + ' ' + esc(c.wallet.currency) : 'no wallet') + '</div>' +
          '<button class="small success" data-dep="' + c.id + '" data-name="' + esc(c.full_name) + '">Deposit</button></div>'
        ).join('');
        results.querySelectorAll('[data-dep]').forEach((btn) => btn.onclick = () => depositModal(btn.getAttribute('data-dep'), btn.getAttribute('data-name')));
      } catch (e) { results.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>'; }
    };
    document.getElementById('c-go').onclick = search;
    document.getElementById('c-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
  }

  function depositModal(userId, name) {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML =
      '<div class="modal"><h3>Cash deposit — ' + esc(name) + '</h3><div id="m-body">' +
      '<label>Amount</label><input id="m-amt" type="number" min="0.01" step="0.01" placeholder="100.00" />' +
      '<label>Note (optional)</label><input id="m-note" placeholder="Counter deposit" />' +
      '<div id="m-msg"></div>' +
      '<div class="modal-actions"><button id="m-cancel">Cancel</button><button class="success" id="m-ok">Confirm deposit</button></div></div></div>';
    document.body.appendChild(backdrop);
    document.getElementById('m-cancel').onclick = () => backdrop.remove();
    document.getElementById('m-ok').onclick = async () => {
      const msg = document.getElementById('m-msg');
      msg.innerHTML = '';
      try {
        const r = await api('/api/staff/deposits', {
          method: 'POST',
          body: JSON.stringify({
            user_id: userId,
            amount: document.getElementById('m-amt').value,
            description: document.getElementById('m-note').value || undefined,
          }),
        });
        document.getElementById('m-body').innerHTML =
          '<div class="confirm"><div class="tick">✓</div>' +
          '<div class="amount">+' + money(r.entry.amount) + ' ' + esc(r.wallet.currency) + '</div>' +
          '<p class="muted">' + esc(r.customer.full_name) + ' · new balance ' + money(r.wallet.available_balance) + '</p>' +
          '<p class="muted">Reference ' + ref(r.entry.reference) + ' · logged to audit trail</p>' +
          '<button class="primary" id="m-done">Done</button></div>';
        document.getElementById('m-done').onclick = () => { backdrop.remove(); depositsView(); };
      } catch (e) {
        msg.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>';
      }
    };
  }

  // ---------------- admin views ----------------

  async function fuelTypesView() {
    if (!requireRole(['admin'])) return;
    app.innerHTML = '<h2>Fuel types</h2><div id="f"><p class="muted">Loading…</p></div>';
    const root = document.getElementById('f');
    const load = async () => {
      try {
        const list = await api('/api/admin/fuel-types');
        root.innerHTML =
          '<div class="card"><h3>Add fuel type</h3><div id="f-msg"></div>' +
          '<div class="row"><div><label>Name</label><input id="f-name" placeholder="Premium" /></div>' +
          '<div><label>Price / litre</label><input id="f-price" type="number" min="0.001" step="0.001" /></div>' +
          '<button class="primary" id="f-add">Add</button></div></div>' +
          '<div class="card"><table><thead><tr><th>Name</th><th>Price / litre</th><th>Currency</th><th>Status</th><th></th></tr></thead><tbody>' +
          list.map((f) =>
            '<tr><td><input data-name="' + f.id + '" value="' + esc(f.name) + '" /></td>' +
            '<td><input style="width:130px" type="number" step="0.001" min="0.001" data-price="' + f.id + '" value="' + Number(f.price_per_litre) + '" /></td>' +
            '<td>' + esc(f.currency) + '</td><td>' + badge(f.status) + '</td>' +
            '<td><button class="small primary" data-save="' + f.id + '">Save</button> ' +
            '<button class="small danger" data-del="' + f.id + '">Delete</button></td></tr>'
          ).join('') + '</tbody></table><p class="muted">Price edits save per row via “Save”. Deleting an in-use fuel type deactivates it instead.</p></div>';

        document.getElementById('f-add').onclick = async () => {
          const msg = document.getElementById('f-msg');
          try {
            await api('/api/admin/fuel-types', {
              method: 'POST',
              body: JSON.stringify({ name: document.getElementById('f-name').value, price_per_litre: document.getElementById('f-price').value }),
            });
            fuelTypesView();
          } catch (e) { msg.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>'; }
        };
        root.querySelectorAll('[data-save]').forEach((btn) => {
          btn.onclick = async () => {
            const id = btn.getAttribute('data-save');
            try {
              await api('/api/admin/fuel-types/' + id, {
                method: 'PATCH',
                body: JSON.stringify({
                  name: root.querySelector('[data-name="' + id + '"]').value,
                  price_per_litre: root.querySelector('[data-price="' + id + '"]').value,
                }),
              });
              fuelTypesView();
            } catch (e) { alert(e.message); }
          };
        });
        root.querySelectorAll('[data-del]').forEach((btn) => {
          btn.onclick = async () => {
            if (!confirm('Delete/deactivate this fuel type?')) return;
            try { await api('/api/admin/fuel-types/' + btn.getAttribute('data-del'), { method: 'DELETE' }); fuelTypesView(); }
            catch (e) { alert(e.message); }
          };
        });
      } catch (e) { root.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>'; }
    };
    load();
  }

  // ---------------- router ----------------

  const routes = {
    '#/login': loginView,
    '#/register': registerView,
    '#/dashboard': dashboardView,
    '#/request-fuel': requestFuelView,
    '#/wallet': walletView,
    '#/transactions': () => transactionsView(1),
    '#/staff': staffView,
    '#/staff-deposits': depositsView,
    '#/admin/fuel-types': fuelTypesView,
  };

  function route() {
    const user = state.user;
    if (!user && location.hash !== '#/register') location.hash = '#/login';
    if (user && location.hash === '#/login') {
      location.hash = user.role === 'customer' ? '#/dashboard' : '#/staff';
      return;
    }
    renderChrome();
    const view = routes[location.hash] || loginView;
    view();
  }

  window.addEventListener('hashchange', route);
  route();
})();
