(() => {
  'use strict';

  const root = document.getElementById('app');
  const state = { user: null, items: [], view: 'home', authMode: 'login' };

  const CATS = {
    insurance: 'Insurance',
    utilities: 'Utilities',
    subscription: 'Subscription',
    tax: 'Tax & fees',
    rent: 'Rent',
    loan: 'Loan',
    warranty: 'Warranty',
    other: 'Other',
  };

  const ICONS = {
    insurance: '<path d="M12 3l7 3v5c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6l7-3z"/>',
    utilities: '<path d="M13 3L5 14h6l-1 7 8-11h-6l1-7z"/>',
    subscription: '<path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/>',
    tax: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>',
    rent: '<path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z"/>',
    loan: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 10h4a1.5 1.5 0 0 1 0 3h-3a1.5 1.5 0 0 0 0 3h4"/>',
    warranty: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
    other: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>',
    home: '<path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z"/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    user: '<path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="8" r="4"/>',
    logo: '<path d="M12 3l7 3v5c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/>',
  };

  // ---------- tiny helpers ----------
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value' || k === 'checked' || k === 'disabled') e[k] = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return e;
  }

  function icon(name, size = 20) {
    const s = document.createElement('span');
    s.className = 'ico';
    s.innerHTML = `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.other}</svg>`;
    return s;
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'household-admin' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && state.user && !url.startsWith('/api/login') && !url.startsWith('/api/account')) {
        state.user = null;
        render();
      }
      const err = new Error(data.error || 'Something went wrong. Please try again.');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const money = (n) => (n == null ? '' : 'RM ' + Number(n).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const parseLocal = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const startOfToday = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
  const daysLeft = (s) => Math.round((parseLocal(s) - startOfToday()) / 86400000);

  function fmtDate(s) {
    const d = parseLocal(s);
    const opts = { weekday: 'short', day: 'numeric', month: 'short' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString('en-GB', opts);
  }

  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  function chipFor(item) {
    if (item.done) return { text: 'Paid', cls: 'paid' };
    const d = daysLeft(item.dueDate);
    if (d < 0) return { text: `${-d}d overdue`, cls: 'urgent' };
    if (d === 0) return { text: 'Today', cls: 'urgent' };
    if (d <= 3) return { text: plural(d, 'day'), cls: 'urgent' };
    if (d <= 7) return { text: plural(d, 'day'), cls: 'soon' };
    return { text: plural(d, 'day'), cls: '' };
  }

  function toast(msg) {
    const t = h('div', { class: 'toast', role: 'status' }, msg);
    document.body.append(t);
    setTimeout(() => t.remove(), 3200);
  }

  const upcoming = () => state.items.filter((i) => !i.done).sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  // ---------- auth ----------
  function renderAuth() {
    if (state.authMode === 'forgot') return renderForgot();
    if (state.authMode === 'reset') return renderReset();
    const signup = state.authMode === 'signup';
    const err = h('div', { class: 'error', role: 'alert', hidden: true });
    const submit = h('button', { class: 'btn', type: 'submit' }, signup ? 'Create account' : 'Log in');

    const form = h(
      'form',
      {
        class: 'stack-form',
        novalidate: true,
        onSubmit: async (e) => {
          e.preventDefault();
          err.hidden = true;
          submit.disabled = true;
          const fd = new FormData(form);
          try {
            const payload = { email: fd.get('email'), password: fd.get('password') };
            if (signup) { payload.name = fd.get('name'); payload.agree = fd.get('agree') === 'on'; }
            const { user } = await api('POST', signup ? '/api/signup' : '/api/login', payload);
            state.user = user;
            state.view = 'home';
            await loadItems();
            render();
          } catch (ex) {
            err.textContent = ex.message;
            err.hidden = false;
            submit.disabled = false;
          }
        },
      },
      signup && field('name', 'Your name', { type: 'text', autocomplete: 'name', required: true }),
      field('email', 'Email', { type: 'email', autocomplete: 'email', required: true }),
      field('password', 'Password', { type: 'password', autocomplete: signup ? 'new-password' : 'current-password', required: true }, signup ? 'At least 8 characters.' : null),
      !signup && h('button', { class: 'linkbtn', type: 'button', onClick: () => { state.authMode = 'forgot'; render(); } }, 'Forgot password?'),
      signup && h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'agree' }), h('span', null, 'I have read and agree to the ', h('a', { href: '/privacy.html', target: '_blank', rel: 'noopener' }, 'Privacy Policy'), '.')),
      err,
      submit
    );

    const tab = (mode, label) => h('button', { type: 'button', 'aria-selected': String(state.authMode === mode), onClick: () => { state.authMode = mode; render(); } }, label);

    return h(
      'main',
      { class: 'content auth' },
      h('div', { class: 'brand' }, h('span', { class: 'mark' }, icon('logo', 20)), 'Household Admin'),
      h('div', { class: 'stack-form' }, h('h1', null, 'Never miss a bill or renewal again.'), h('p', { class: 'muted' }, 'Keep insurance, road tax, utilities and subscriptions in one place. Your data stays private and is never shared.')),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Log in or sign up' }, tab('login', 'Log in'), tab('signup', 'Sign up')),
      form,
      h('p', { class: 'muted' }, h('a', { href: '/privacy.html', target: '_blank', rel: 'noopener' }, 'Privacy Policy'))
    );
  }

  function authShell(title, intro, ...children) {
    return h(
      'main',
      { class: 'content auth' },
      h('div', { class: 'brand' }, h('span', { class: 'mark' }, icon('logo', 20)), 'Household Admin'),
      h('div', { class: 'stack-form' }, h('h1', null, title), intro && h('p', { class: 'muted' }, intro)),
      ...children
    );
  }

  function renderForgot() {
    const err = h('div', { class: 'error', role: 'alert', hidden: true });
    const done = h('div', { class: 'card', role: 'status', hidden: true }, h('strong', null, 'Check your email'), h('span', { class: 'muted' }, 'If an account exists for that address, we have sent a link to reset your password. It works once, for one hour. Check your spam folder too.'));
    const submit = h('button', { class: 'btn', type: 'submit' }, 'Send reset link');
    const form = h(
      'form',
      {
        class: 'stack-form',
        novalidate: true,
        onSubmit: async (e) => {
          e.preventDefault();
          err.hidden = true;
          submit.disabled = true;
          try {
            await api('POST', '/api/forgot', { email: new FormData(form).get('email') });
            done.hidden = false;
          } catch (ex) {
            err.textContent = ex.message;
            err.hidden = false;
          }
          submit.disabled = false;
        },
      },
      field('email', 'Email', { type: 'email', autocomplete: 'email', required: true }),
      err,
      submit
    );
    return authShell('Forgot your password?', 'Enter your email and we will send you a link to choose a new one.', form, done, h('button', { class: 'linkbtn', type: 'button', onClick: () => { state.authMode = 'login'; render(); } }, 'Back to log in'));
  }

  function renderReset() {
    const err = h('div', { class: 'error', role: 'alert', hidden: true });
    const submit = h('button', { class: 'btn', type: 'submit' }, 'Save new password');
    const form = h(
      'form',
      {
        class: 'stack-form',
        novalidate: true,
        onSubmit: async (e) => {
          e.preventDefault();
          err.hidden = true;
          const fd = new FormData(form);
          if (fd.get('password') !== fd.get('confirm')) {
            err.textContent = 'The two passwords do not match.';
            err.hidden = false;
            return;
          }
          submit.disabled = true;
          try {
            await api('POST', '/api/reset', { token: state.resetToken, password: fd.get('password') });
            state.resetToken = null;
            state.user = null;
            state.items = [];
            state.authMode = 'login';
            render();
            toast('Password changed. Please log in.');
          } catch (ex) {
            err.textContent = ex.message;
            err.hidden = false;
            submit.disabled = false;
          }
        },
      },
      field('password', 'New password', { type: 'password', autocomplete: 'new-password', required: true }, 'At least 8 characters.'),
      field('confirm', 'Repeat new password', { type: 'password', autocomplete: 'new-password', required: true }),
      err,
      submit
    );
    return authShell('Choose a new password', null, form);
  }

  function field(name, label, attrs, hint) {
    const id = 'f-' + name + Math.random().toString(36).slice(2, 6);
    return h('div', { class: 'field' }, h('label', { for: id }, label), h('input', { id, name, ...attrs }), hint && h('span', { class: 'hint' }, hint));
  }

  // ---------- item rows ----------
  function itemRow(item) {
    const chip = chipFor(item);
    const rep = item.repeat === 'monthly' ? ' · Monthly' : item.repeat === 'yearly' ? ' · Yearly' : '';
    return h(
      'button',
      { class: 'row', type: 'button', onClick: () => openItemDialog(item) },
      h('span', { class: 'tile' }, icon(item.category, 20)),
      h('span', { class: 'mid' }, h('span', { class: 'title' }, item.title), h('span', { class: 'sub' }, `${fmtDate(item.dueDate)} · ${CATS[item.category] || 'Other'}${rep}`)),
      h('span', { class: 'end' }, item.amount != null && h('span', { class: 'amt' }, money(item.amount)), h('span', { class: 'chip ' + chip.cls }, chip.text))
    );
  }

  function emptyState(text, preset) {
    return h('div', { class: 'empty' }, h('p', null, text), h('button', { class: 'btn', type: 'button', onClick: () => openItemDialog(null, preset) }, 'Add an item'));
  }

  // ---------- views ----------
  function viewHome() {
    const up = upcoming();
    const windowItems = up.filter((i) => daysLeft(i.dueDate) <= 30);
    const total = windowItems.reduce((s, i) => s + (i.amount || 0), 0);
    const overdue = windowItems.filter((i) => daysLeft(i.dueDate) < 0).length;
    let foot = 'Nothing due in the next 30 days.';
    if (windowItems.length) {
      const first = windowItems[0];
      const d = daysLeft(first.dueDate);
      const when = d < 0 ? 'overdue' : d === 0 ? 'today' : `in ${plural(d, 'day')}`;
      foot = `${plural(windowItems.length, 'item')}${overdue ? ` · ${overdue} overdue` : ''} · next: ${first.title} ${when}`;
    }
    const hour = new Date().getHours();
    const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const first = (state.user.name || '').split(' ')[0];

    return h(
      'main',
      { class: 'content' },
      h('div', { class: 'topbar' }, h('div', { class: 'stack' }, h('span', { class: 'muted' }, new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })), h('h1', null, `${greet}, ${first}`))),
      h('div', { class: 'summary' }, h('span', { class: 'label' }, 'Due in the next 30 days'), h('span', { class: 'big' }, money(total) || 'RM 0.00'), h('span', { class: 'foot' }, foot)),
      state.items.length === 0
        ? emptyState('Nothing here yet. Add your first bill or renewal and we will keep track of it.')
        : h('section', { class: 'stack-form' }, h('div', { class: 'section-head' }, h('h2', null, 'Due soon'), h('button', { class: 'linkbtn', type: 'button', onClick: () => { state.view = 'all'; render(); } }, 'See all')), up.length ? h('div', { class: 'list' }, up.slice(0, 5).map(itemRow)) : h('p', { class: 'muted' }, 'Everything is paid. Nice.'))
    );
  }

  function viewAll() {
    const sorted = [...upcoming(), ...state.items.filter((i) => i.done)];
    return h('main', { class: 'content' }, h('div', { class: 'topbar' }, h('h1', null, 'All items')), sorted.length ? h('div', { class: 'list' }, sorted.map(itemRow)) : emptyState('You have not added anything yet.'));
  }

  function viewSubs() {
    const subs = upcoming().filter((i) => i.category === 'subscription');
    const monthly = subs.reduce((s, i) => s + (i.amount || 0) * (i.repeat === 'monthly' ? 1 : i.repeat === 'yearly' ? 1 / 12 : 0), 0);
    return h(
      'main',
      { class: 'content' },
      h('div', { class: 'topbar' }, h('h1', null, 'Subscriptions')),
      h('div', { class: 'summary' }, h('span', { class: 'label' }, 'Roughly per month'), h('span', { class: 'big' }, money(monthly) || 'RM 0.00'), h('span', { class: 'foot' }, 'Yearly plans are shown as one-twelfth. Only items set to repeat are counted.')),
      subs.length ? h('div', { class: 'list' }, subs.map(itemRow)) : emptyState('No subscriptions yet. Add Netflix, Spotify, your phone plan and the rest to see what they cost.', { category: 'subscription' })
    );
  }

  function viewAccount() {
    return h(
      'main',
      { class: 'content' },
      h('div', { class: 'topbar' }, h('h1', null, 'Account')),
      h('div', { class: 'card' }, h('strong', null, state.user.name), h('span', { class: 'muted' }, state.user.email)),
      h('div', { class: 'card' }, h('strong', null, 'Your data'), h('p', { class: 'muted' }, 'We never sell or share your personal information. You can download everything we hold about you, or delete your account and all your data at any time.'), h('a', { class: 'btn ghost', href: '/api/export', download: '', style: undefined }, 'Download my data'), h('a', { href: '/privacy.html', target: '_blank', rel: 'noopener' }, 'Read the Privacy Policy')),
      h('div', { class: 'actions' }, h('button', { class: 'btn dark', type: 'button', onClick: logout }, 'Log out'), h('button', { class: 'btn ghost', type: 'button', onClick: openDeleteDialog }, 'Delete account'))
    );
  }

  function tabbar() {
    const tab = (view, label, ic) => h('button', { class: 'tab', type: 'button', 'aria-current': state.view === view ? 'page' : null, onClick: () => { state.view = view; render(); } }, icon(ic, 22), label);
    return h(
      'nav',
      { class: 'tabbar', 'aria-label': 'Main' },
      tab('home', 'Home', 'home'),
      tab('all', 'All', 'list'),
      h('button', { class: 'tab add', type: 'button', 'aria-label': 'Add an item', onClick: () => openItemDialog(null) }, h('span', { class: 'circle' }, icon('plus', 26)), 'Add'),
      tab('subs', 'Subs', 'subscription'),
      tab('account', 'Account', 'user')
    );
  }

  // ---------- dialogs ----------
  function openDialog(content) {
    const dlg = h('dialog', null, h('div', { class: 'inner' }, content));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
    return dlg;
  }

  function openItemDialog(item, preset) {
    const isEdit = !!item;
    const v = item || { title: '', category: (preset && preset.category) || 'insurance', amount: null, dueDate: isoLocal(new Date(Date.now() + 7 * 86400000)), repeat: 'none', note: '' };
    const err = h('div', { class: 'error', role: 'alert', hidden: true });
    const uid = Math.random().toString(36).slice(2, 6);
    let dlg;

    const sel = (name, label, opts, value) =>
      h('div', { class: 'field' }, h('label', { for: `${name}${uid}` }, label), h('select', { id: `${name}${uid}`, name }, Object.entries(opts).map(([k, t]) => h('option', { value: k, selected: k === value }, t))));

    const form = h(
      'form',
      {
        class: 'stack-form',
        novalidate: true,
        onSubmit: async (e) => {
          e.preventDefault();
          err.hidden = true;
          const fd = new FormData(form);
          const raw = String(fd.get('amount') || '').trim();
          const body = { title: fd.get('title'), category: fd.get('category'), amount: raw === '' ? null : Number(raw), dueDate: fd.get('dueDate'), repeat: fd.get('repeat'), note: fd.get('note') };
          try {
            if (isEdit) {
              const { item: saved } = await api('PUT', `/api/items/${item.id}`, body);
              state.items = state.items.map((i) => (i.id === saved.id ? saved : i));
            } else {
              const { item: saved } = await api('POST', '/api/items', body);
              state.items.push(saved);
            }
            dlg.close();
            render();
            toast(isEdit ? 'Saved' : 'Added');
          } catch (ex) {
            err.textContent = ex.message;
            err.hidden = false;
          }
        },
      },
      h('h2', null, isEdit ? 'Edit item' : 'Add an item'),
      h('div', { class: 'field' }, h('label', { for: `title${uid}` }, 'Name'), h('input', { id: `title${uid}`, name: 'title', type: 'text', maxlength: '80', value: v.title, placeholder: 'e.g. Car insurance' })),
      h('div', { class: 'two' }, sel('category', 'Type', CATS, v.category), sel('repeat', 'Repeats', { none: 'Does not repeat', monthly: 'Every month', yearly: 'Every year' }, v.repeat)),
      h('div', { class: 'two' },
        h('div', { class: 'field' }, h('label', { for: `amount${uid}` }, 'Amount (RM)'), h('input', { id: `amount${uid}`, name: 'amount', type: 'number', inputmode: 'decimal', step: '0.01', min: '0', value: v.amount == null ? '' : String(v.amount) })),
        h('div', { class: 'field' }, h('label', { for: `due${uid}` }, 'Due date'), h('input', { id: `due${uid}`, name: 'dueDate', type: 'date', value: v.dueDate }))
      ),
      h('div', { class: 'field' }, h('label', { for: `note${uid}` }, 'Note (optional)'), h('input', { id: `note${uid}`, name: 'note', type: 'text', maxlength: '200', value: v.note || '' })),
      err,
      h('div', { class: 'actions' },
        h('button', { class: 'btn ghost', type: 'button', onClick: () => dlg.close() }, 'Cancel'),
        h('button', { class: 'btn', type: 'submit' }, 'Save')
      ),
      isEdit && h('div', { class: 'actions' },
        !item.done && h('button', { class: 'btn dark', type: 'button', onClick: async () => {
          try {
            const { item: saved } = await api('POST', `/api/items/${item.id}/paid`);
            state.items = state.items.map((i) => (i.id === saved.id ? saved : i));
            dlg.close();
            render();
            toast(saved.done ? 'Marked as paid' : `Paid. Next due ${fmtDate(saved.dueDate)}`);
          } catch (ex) { err.textContent = ex.message; err.hidden = false; }
        } }, 'Mark paid'),
        h('button', { class: 'btn ghost', type: 'button', onClick: async () => {
          if (!confirm('Delete this item?')) return;
          try {
            await api('DELETE', `/api/items/${item.id}`);
            state.items = state.items.filter((i) => i.id !== item.id);
            dlg.close();
            render();
            toast('Deleted');
          } catch (ex) { err.textContent = ex.message; err.hidden = false; }
        } }, 'Delete')
      )
    );
    dlg = openDialog(form);
  }

  function openDeleteDialog() {
    const err = h('div', { class: 'error', role: 'alert', hidden: true });
    let dlg;
    const form = h(
      'form',
      {
        class: 'stack-form',
        novalidate: true,
        onSubmit: async (e) => {
          e.preventDefault();
          err.hidden = true;
          try {
            await api('DELETE', '/api/account', { password: new FormData(form).get('password') });
            state.user = null;
            state.items = [];
            dlg.close();
            state.authMode = 'signup';
            render();
            toast('Your account and data have been deleted.');
          } catch (ex) { err.textContent = ex.message; err.hidden = false; }
        },
      },
      h('h2', null, 'Delete your account?'),
      h('p', { class: 'muted' }, 'This permanently deletes your account and every item you saved. It cannot be undone. Enter your password to confirm.'),
      field('password', 'Password', { type: 'password', autocomplete: 'current-password', required: true }),
      err,
      h('div', { class: 'actions' }, h('button', { class: 'btn ghost', type: 'button', onClick: () => dlg.close() }, 'Cancel'), h('button', { class: 'btn danger', type: 'submit' }, 'Delete everything'))
    );
    dlg = openDialog(form);
  }

  // ---------- app ----------
  async function logout() {
    try { await api('POST', '/api/logout'); } catch { /* ignore */ }
    state.user = null;
    state.items = [];
    state.authMode = 'login';
    render();
  }

  async function loadItems() {
    state.items = (await api('GET', '/api/items')).items;
  }

  function render() {
    if (!state.user || state.authMode === 'reset') {
      root.replaceChildren(renderAuth());
      return;
    }
    const view = { home: viewHome, all: viewAll, subs: viewSubs, account: viewAccount }[state.view] || viewHome;
    root.replaceChildren(view(), tabbar());
  }

  (async function boot() {
    // a password-reset link looks like https://your-site/#reset=<64 hex characters>
    const m = location.hash.match(/^#reset=([a-f0-9]{64})$/);
    if (m) {
      state.resetToken = m[1];
      state.authMode = 'reset';
      history.replaceState(null, '', location.pathname); // keep the token out of the address bar and history
    }
    try {
      state.user = (await api('GET', '/api/me')).user;
      await loadItems();
    } catch { state.user = null; }
    render();
  })();
})();
