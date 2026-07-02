const state = {
  user: null,
  listings: [],
  selectedListing: null,
  authMode: 'login',
  activeThread: null,
  orderRole: 'buyer',
  notifications: { messages: 0, orders: 0, admin: 0 },
  lastNotificationKey: '',
  notificationPollId: null,
  adminSection: 'reports',
  adminOverview: null,
  config: { turnstileSiteKey: '', programs: {}, emailVerificationRequired: false, teamVerificationRequired: false },
  turnstileWidgetId: null,
  turnstileRenderAttempts: 0
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const CATEGORY_OTHER_VALUE = 'Other';
const DEFAULT_PROGRAMS = {
  FLL: 'Local pickup',
  FTC: 'Local offer',
  FRC: 'Shipping available'
};

function money(cents, currency = 'USD') {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format((cents || 0) / 100);
}

function escapeHtml(text) {
  return String(text || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function isStrongPassword(password) {
  return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/.test(password);
}

function programLabel(program) {
  return DEFAULT_PROGRAMS[program] || DEFAULT_PROGRAMS.FTC;
}

function teamLabel(user) {
  return user?.teamNumber ? `seller ${user.teamNumber}` : 'local seller';
}

async function api(url, options = {}) {
  const opts = { credentials: 'same-origin', ...options };
  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

function toast(message) {
  let tray = $('#toastTray');
  if (!tray) {
    tray = document.createElement('div');
    tray.id = 'toastTray';
    tray.className = 'toast-tray';
    document.body.appendChild(tray);
  }
  const item = document.createElement('div');
  item.className = 'toast';
  item.textContent = message;
  tray.appendChild(item);
  window.setTimeout(() => item.classList.add('leaving'), 4500);
  window.setTimeout(() => item.remove(), 5000);
}

function openModal(id) {
  $('#modalBackdrop').classList.remove('hidden');
  $(id).classList.remove('hidden');
}

function closeModals() {
  $('#modalBackdrop').classList.add('hidden');
  $$('.modal').forEach((m) => m.classList.add('hidden'));
}

function setTab(name) {
  $$('.tab').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === name));
  $$('.tab-pane').forEach((p) => p.classList.remove('active'));
  $(`#${name === 'admin' ? 'adminTabPane' : name + 'Tab'}`).classList.add('active');
  if (name === 'messages') loadThreads();
  if (name === 'orders') loadOrders();
  if (name === 'admin') loadAdminSection(state.adminSection);
  loadNotifications();
}

function updateCustomCategoryVisibility() {
  const category = $('#sellCategory').value;
  const wrap = $('#customCategoryWrap');
  const input = $('#customCategoryInput');
  const isOther = category === CATEGORY_OTHER_VALUE;
  wrap.classList.toggle('hidden', !isOther);
  input.required = isOther;
  if (!isOther) input.value = '';
}

function updateImagePreview() {
  const fileInput = $('#listingImageInput');
  const preview = $('#imagePreview');
  const file = fileInput.files && fileInput.files[0];

  if (!file) {
    preview.classList.add('hidden');
    preview.removeAttribute('src');
    preview.alt = '';
    return;
  }

  if (!file.type.startsWith('image/')) {
    fileInput.value = '';
    preview.classList.add('hidden');
    preview.removeAttribute('src');
    toast('Please choose an image file.');
    return;
  }

  if (file.size > 5 * 1024 * 1024) {
    fileInput.value = '';
    preview.classList.add('hidden');
    preview.removeAttribute('src');
    toast('Image must be 5 MB or smaller.');
    return;
  }

  preview.src = URL.createObjectURL(file);
  preview.alt = 'Listing preview';
  preview.classList.remove('hidden');
}

async function loadMe() {
  const data = await api('/api/me');
  state.user = data.user;
  renderAuthState();
  await loadNotifications();
}

async function loadConfig() {
  const data = await api('/api/config');
  state.config = data;
}

function renderTurnstile() {
  const wrap = $('#turnstileWrap');
  if (!wrap || state.authMode !== 'signup' || !state.config.turnstileSiteKey) return;
  if (!window.turnstile) {
    if (state.turnstileRenderAttempts < 20) {
      state.turnstileRenderAttempts += 1;
      setTimeout(renderTurnstile, 250);
    }
    return;
  }
  state.turnstileRenderAttempts = 0;
  if (state.turnstileWidgetId !== null) {
    window.turnstile.reset(state.turnstileWidgetId);
    return;
  }
  state.turnstileWidgetId = window.turnstile.render('#turnstileWidget', {
    sitekey: state.config.turnstileSiteKey
  });
}

function renderAuthState() {
  const loggedIn = Boolean(state.user);
  $('#sellBtn').classList.toggle('hidden', !(loggedIn && state.user.role === 'admin'));
  $('#userChip').classList.toggle('hidden', !loggedIn);
  $('#authBtn').textContent = loggedIn ? 'Log out' : 'Log in';
  if (loggedIn) {
    $('#userChip').textContent = `${state.user.name}${state.user.role === 'admin' ? ' | admin' : ''}${state.user.emailVerified || !state.config.emailVerificationRequired ? '' : ' | verify email'}`;
  }
  $('#adminTab').classList.toggle('hidden', !(state.user && state.user.role === 'admin'));
}

async function loadListings() {
  const params = new URLSearchParams();
  const fields = {
    search: $('#searchInput').value,
    category: $('#categoryInput').value,
    program: $('#programInput')?.value || '',
    minPrice: $('#minPriceInput').value,
    maxPrice: $('#maxPriceInput').value,
    location: $('#locationInput').value,
    sort: $('#sortInput').value
  };
  Object.entries(fields).forEach(([k, v]) => {
    if (v) params.set(k, v);
  });
  const data = await api(`/api/listings?${params}`);
  state.listings = data.listings;
  renderListings();
}

function renderListings() {
  $('#listingCount').textContent = `${state.listings.length} offer${state.listings.length === 1 ? '' : 's'} found`;
  if (!state.listings.length) {
    $('#listingGrid').innerHTML = '<div class="empty">No offers yet. Check back soon.</div>';
    return;
  }
  $('#listingGrid').innerHTML = state.listings.map((item) => `
    <article class="card">
      <div class="card-img">${item.imageUrl ? `<img src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.title)}">` : 'No image'}</div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(item.title)}</div>
        <div class="price">${money(item.priceCents, item.currency)}</div>
        <div class="meta">${escapeHtml(item.category)} | ${escapeHtml(item.condition)}</div>
        <div class="meta">${escapeHtml(item.location)}</div>
        <div class="meta">Seller: ${escapeHtml(item.sellerName || 'Unknown')}</div>
        <div class="card-actions">
          <button class="btn primary" onclick="showListing(${item.id})">View</button>
          ${state.user && state.user.id === item.sellerId ? `<button class="btn danger" onclick="deleteListing(${item.id})">Delete</button>` : ''}
        </div>
      </div>
    </article>
  `).join('');
}

async function showListing(id) {
  const data = await api(`/api/listings/${id}`);
  state.selectedListing = data.listing;
  const item = state.selectedListing;
  const isOwner = state.user && state.user.id === item.sellerId;
  const canAct = state.user && (state.user.emailVerified || !state.config.emailVerificationRequired);

  $('#listingDetail').innerHTML = `
    <div class="detail-layout">
      <div class="detail-image">${item.imageUrl ? `<img src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.title)}">` : 'No image'}</div>
      <div class="detail-info">
        <h2>${escapeHtml(item.title)}</h2>
        <div class="price">${money(item.priceCents, item.currency)}</div>
        <div class="meta">${escapeHtml(item.category)} | ${escapeHtml(item.condition)} | ${escapeHtml(item.location)}</div>
        <div class="meta">Seller: ${escapeHtml(item.sellerName || 'Unknown')}</div>
        <p class="detail-description">${escapeHtml(item.description)}</p>

        ${state.user && !state.user.emailVerified && state.config.emailVerificationRequired ? `
          <div class="action-box">
            Verify your email before messaging, reserving, selling, or reporting.
            <button class="btn primary full" onclick="resendVerification()">Resend verification</button>
          </div>
        ` : ''}

        ${canAct && !isOwner ? `
          <div class="action-box">
            <h3>Message seller</h3>
            <form id="messageSellerForm">
              <textarea name="body" placeholder="Ask a question or make an offer..." required></textarea>
              <button class="btn primary full">Send message</button>
            </form>
          </div>
          <div class="action-box">
            <h3>Reserve offer</h3>
            <form id="buyForm">
              <div class="split">
                <label>Your name <input name="shippingName" required></label>
                <label>Pickup city/ZIP <input name="shippingPostal" required placeholder="City or ZIP"></label>
              </div>
              <input type="hidden" name="shippingAddress1" value="Local pickup">
              <input type="hidden" name="shippingCity" value="Local">
              <input type="hidden" name="shippingCountry" value="United States">
              <label>Pickup note <input name="shippingAddress2" placeholder="Preferred time or public meetup spot"></label>
              <button class="btn primary full">Reserve</button>
            </form>
          </div>
          <div class="action-box">
            <h3>Report offer</h3>
            <form id="reportForm">
              <input name="reason" required minlength="5" placeholder="Scam, fake item, unsafe, etc.">
              <button class="btn danger full">Report</button>
            </form>
          </div>
        ` : ''}

        ${!state.user ? '<div class="action-box">Log in to message, reserve, or report this offer.</div>' : ''}
        ${isOwner ? '<div class="action-box">This is your offer.</div>' : ''}
      </div>
    </div>
  `;

  openModal('#listingModal');

  const msgForm = $('#messageSellerForm');
  if (msgForm) msgForm.addEventListener('submit', sendSellerMessage);
  const buyForm = $('#buyForm');
  if (buyForm) buyForm.addEventListener('submit', buyListing);
  const reportForm = $('#reportForm');
  if (reportForm) reportForm.addEventListener('submit', reportListing);
}

async function sendSellerMessage(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const body = new FormData(form).get('body');
  await api('/api/messages', { method: 'POST', body: { listingId: state.selectedListing.id, body } });
  toast('Message sent.');
  form.reset();
}

async function buyListing(e) {
  e.preventDefault();
  const form = new FormData(e.currentTarget);
  const body = Object.fromEntries(form.entries());
  const data = await api(`/api/listings/${state.selectedListing.id}/buy`, { method: 'POST', body });
  if (data.checkoutUrl) {
    window.location.href = data.checkoutUrl;
    return;
  }
  toast('Offer reserved. It is now marked sold.');
  closeModals();
  await loadListings();
}

async function reportListing(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const reason = new FormData(form).get('reason');
  await api(`/api/listings/${state.selectedListing.id}/report`, { method: 'POST', body: { reason } });
  toast('Report sent to admins.');
  form.reset();
}

async function deleteListing(id) {
  if (!confirm('Delete this offer?')) return;
  await api(`/api/listings/${id}`, { method: 'DELETE' });
  await loadListings();
}

function updateAuthMode(mode) {
  state.authMode = mode;
  $('#authTitle').textContent = mode === 'login' ? 'Log in' : 'Sign up';
  $('#authSubmit').textContent = mode === 'login' ? 'Log in' : 'Create account';
  $('#authSubmit').disabled = false;
  $('#switchAuthBtn').disabled = false;
  $('#switchAuthBtn').textContent = mode === 'login' ? 'Need an account? Sign up' : 'Already have an account? Log in';
  $('#authName').parentElement.classList.toggle('hidden', mode === 'login');
  $('#authProgram').parentElement.classList.add('hidden');
  $('#authTeamNumber').parentElement.classList.add('hidden');
  $('#authConfirmPassword').closest('label').classList.toggle('hidden', mode === 'login');
  $('#turnstileWrap').classList.toggle('hidden', mode === 'login' || !state.config.turnstileSiteKey);
  $('#authTeamNumber').required = false;
  $('#authProgram').required = false;
  $('#authConfirmPassword').required = mode === 'signup';
  if (mode === 'signup') $('#authConfirmPassword').value = '';
  setTimeout(renderTurnstile, 100);
}

function setAuthLoading(isLoading) {
  const action = state.authMode === 'login' ? 'Log in' : 'Create account';
  $('#authSubmit').disabled = isLoading;
  $('#switchAuthBtn').disabled = isLoading;
  $('#authSubmit').textContent = isLoading
    ? (state.authMode === 'login' ? 'Logging in...' : 'Creating account...')
    : action;
}

async function handleAuth(e) {
  e.preventDefault();
  const form = e.currentTarget;
  if ($('#authSubmit').disabled) return;
  const body = {
    name: $('#authName').value,
    email: $('#authEmail').value,
    program: $('#authProgram').value,
    teamNumber: $('#authTeamNumber').value,
    password: $('#authPassword').value,
    confirmPassword: $('#authConfirmPassword').value,
    captchaToken: state.turnstileWidgetId !== null && window.turnstile ? window.turnstile.getResponse(state.turnstileWidgetId) : ''
  };

  if (state.authMode === 'signup') {
    if (body.password !== body.confirmPassword) {
      toast('Passwords do not match.');
      return;
    }
    if (!isStrongPassword(body.password)) {
      toast('Password must be at least 8 characters and include uppercase, lowercase, and a number.');
      return;
    }
    if (state.config.turnstileSiteKey && !body.captchaToken) {
      toast('Complete the not-a-robot check.');
      return;
    }
  }

  setAuthLoading(true);
  try {
    const endpoint = state.authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
    const data = await api(endpoint, { method: 'POST', body });
    state.user = data.user;
    renderAuthState();
    form.reset();
    updateAuthMode('login');
    closeModals();
    await loadListings();
    await loadNotifications();
    if (state.user && !state.user.emailVerified && state.config.emailVerificationRequired) toast('Check your email to verify your account before messaging, reserving, or selling.');
  } catch (err) {
    toast(err.message);
    if (state.turnstileWidgetId !== null && window.turnstile) window.turnstile.reset(state.turnstileWidgetId);
  } finally {
    setAuthLoading(false);
  }
}

async function handleLogoutOrLogin() {
  if (state.user) {
    await api('/api/auth/logout', { method: 'POST' });
    state.user = null;
    renderAuthState();
    await loadNotifications();
    setTab('market');
    await loadListings();
  } else {
    updateAuthMode('login');
    openModal('#authModal');
  }
}

async function handleSell(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const formData = new FormData(form);
  if ($('#sellCategory').value === CATEGORY_OTHER_VALUE) {
    formData.set('category', ($('#customCategoryInput').value || '').trim() || CATEGORY_OTHER_VALUE);
  }
  const data = await api('/api/listings', { method: 'POST', body: formData });
  form.reset();
  updateCustomCategoryVisibility();
  updateImagePreview();
  closeModals();
  await loadListings();
  showListing(data.listing.id);
}

async function loadThreads() {
  if (!state.user) {
    $('#messagesLoginHint').classList.remove('hidden');
    $('#threadList').innerHTML = '';
    $('#chatMessages').innerHTML = '';
    $('#replyForm').classList.add('hidden');
    return;
  }
  $('#messagesLoginHint').classList.add('hidden');
  const data = await api('/api/messages/threads');
  if (!data.threads.length) {
    $('#threadList').innerHTML = '<div class="empty">No messages yet.</div>';
    $('#chatMessages').innerHTML = '';
    $('#replyForm').classList.add('hidden');
    return;
  }
  $('#threadList').innerHTML = data.threads.map((t) => `
    <div class="thread ${state.activeThread && state.activeThread.otherUserId === t.otherUserId && state.activeThread.listingId === t.listingId ? 'active' : ''} ${t.unread ? 'unread' : ''}"
      onclick='openThread(${JSON.stringify(t).replaceAll("'", "&#039;")})'>
      <div class="thread-title">${escapeHtml(t.otherName)} ${t.unread ? `<span class="badge inline">${t.unread}</span>` : ''}</div>
      <div class="meta">${escapeHtml(t.listingTitle)}</div>
      <div class="thread-message">${escapeHtml(t.latestBody)}</div>
    </div>
  `).join('');
}

async function openThread(thread) {
  state.activeThread = thread;
  $('#chatHeader').textContent = `${thread.otherName} • ${thread.listingTitle}`;
  $('#replyForm').classList.remove('hidden');
  await loadThreadMessages();
  await loadThreads();
  await loadNotifications();
}

async function loadThreadMessages() {
  const t = state.activeThread;
  const params = new URLSearchParams({ otherUserId: t.otherUserId });
  if (t.listingId) params.set('listingId', t.listingId);
  const data = await api(`/api/messages/thread?${params}`);
  $('#chatMessages').innerHTML = data.messages.map((m) => `
    <div class="bubble ${m.sender_id === state.user.id ? 'mine' : ''}">
      ${escapeHtml(m.body)}
      <small>${escapeHtml(m.sender_name)} • ${new Date(m.created_at).toLocaleString()}</small>
    </div>
  `).join('');
  $('#chatMessages').scrollTop = $('#chatMessages').scrollHeight;
}

async function sendReply(e) {
  e.preventDefault();
  if (!state.activeThread) return;
  const body = $('#replyInput').value.trim();
  if (!body) return;
  await api('/api/messages', {
    method: 'POST',
    body: {
      listingId: state.activeThread.listingId,
      receiverId: state.activeThread.otherUserId,
      body
    }
  });
  $('#replyInput').value = '';
  await loadThreadMessages();
  await loadThreads();
  await loadNotifications();
}

async function loadOrders() {
  if (!state.user) {
    $('#ordersLoginHint').classList.remove('hidden');
    $('#ordersList').innerHTML = '';
    return;
  }
  $('#ordersLoginHint').classList.add('hidden');
  const data = await api(`/api/orders?role=${state.orderRole === 'seller' ? 'seller' : 'buyer'}`);
  if (!data.orders.length) {
    $('#ordersList').innerHTML = `<div class="empty">No ${state.orderRole === 'seller' ? 'sales' : 'purchases'} yet.</div>`;
    return;
  }
  $('#ordersList').innerHTML = data.orders.map((o) => `
    <div class="order-card">
      <div class="order-top">
        <div>
          <h3>${escapeHtml(o.listing_title)}</h3>
          <div class="price">${money(o.amount_cents, o.currency)}</div>
          <div class="meta">Buyer: ${escapeHtml(o.buyer_name)} • Seller: ${escapeHtml(o.seller_name)}</div>
          <div class="meta">Ship to: ${escapeHtml(o.shipping_name || '')}, ${escapeHtml(o.shipping_city || '')}, ${escapeHtml(o.shipping_country || '')}</div>
          ${o.tracking_number || o.label_url ? `<div class="meta">Shipping: ${escapeHtml(o.carrier || '')} ${escapeHtml(o.tracking_number || '')} ${o.label_url ? `• <a href="${escapeHtml(o.label_url)}" target="_blank" rel="noreferrer">Label</a>` : ''}</div>` : ''}
        </div>
        <span class="status ${escapeHtml(o.status)}">${escapeHtml(o.status)}</span>
      </div>
      ${state.orderRole === 'seller' && ['paid', 'paid_demo'].includes(o.status) ? `
        <form class="ship-form" onsubmit="updateShipping(event, ${o.id})">
          <input name="carrier" placeholder="Carrier: USPS, UPS...">
          <input name="trackingNumber" placeholder="Tracking number">
          <input name="labelUrl" placeholder="Label URL optional">
          <button class="btn primary">Update shipping</button>
        </form>
      ` : ''}
    </div>
  `).join('');
}

async function updateShipping(e, orderId) {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.currentTarget).entries());
  await api(`/api/orders/${orderId}/shipping`, { method: 'PATCH', body });
  toast('Shipping updated.');
  await loadOrders();
}

async function loadReports() {
  if (!state.user || state.user.role !== 'admin') return;
  const data = await api('/api/admin/reports');
  if (!data.reports.length) {
    $('#reportsList').innerHTML = '<div class="empty">No reports yet.</div>';
    return;
  }
  $('#reportsList').innerHTML = data.reports.map((r) => `
    <div class="report-card">
      <div class="order-top">
        <div>
          <h3>${escapeHtml(r.listing_title)}</h3>
          <div class="meta">Reason: ${escapeHtml(r.reason)}</div>
          <div class="meta">Reported by: ${escapeHtml(r.reporter_name)}</div>
          <div class="meta">Seller: ${escapeHtml(r.seller_name)} (${escapeHtml(r.seller_email)}) ${r.seller_banned ? '• banned' : ''}</div>
          <div class="meta">Listing status: ${escapeHtml(r.listing_status)}</div>
        </div>
        <span class="status ${escapeHtml(r.status)}">${escapeHtml(r.status)}</span>
      </div>
      <div class="card-actions">
        <button class="btn success" onclick="resolveReport(${r.id}, false, false)">Resolve</button>
        <button class="btn danger" onclick="resolveReport(${r.id}, true, false)">Delete listing</button>
        <button class="btn danger" onclick="resolveReport(${r.id}, true, true)">Ban seller</button>
      </div>
    </div>
  `).join('');
}

async function resolveReport(id, deleteListing, banSeller) {
  const adminNote = prompt('Admin note:', deleteListing || banSeller ? 'Action taken.' : 'Reviewed.');
  await api(`/api/admin/reports/${id}`, {
    method: 'PATCH',
    body: { status: 'resolved', adminNote, deleteListing, banSeller }
  });
  await loadReports();
  await loadListings();
}

function setupEvents() {
  $('#authBtn').addEventListener('click', handleLogoutOrLogin);
  $('#sellBtn').addEventListener('click', () => {
    if (!state.user || state.user.role !== 'admin') {
      toast('Only the admin account can list offers.');
      return;
    }
    if (state.user && !state.user.emailVerified && state.config.emailVerificationRequired) {
      resendVerification();
      return;
    }
    $('#sellProgram').value = 'FTC';
    openModal('#sellModal');
  });
  $('#authForm').addEventListener('submit', handleAuth);
  $('#switchAuthBtn').addEventListener('click', () => updateAuthMode(state.authMode === 'login' ? 'signup' : 'login'));
  $$('[data-toggle-password]').forEach((btn) => btn.addEventListener('click', () => {
    const input = $(`#${btn.dataset.togglePassword}`);
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.textContent = showing ? 'Show' : 'Hide';
  }));
  $('#sellForm').addEventListener('submit', handleSell);
  $('#sellCategory').addEventListener('change', updateCustomCategoryVisibility);
  $('#listingImageInput').addEventListener('change', updateImagePreview);
  $('#applyFiltersBtn').addEventListener('click', loadListings);
  $('#resetFiltersBtn').addEventListener('click', () => {
    $('#searchInput').value = '';
    $('#categoryInput').value = '';
    if ($('#programInput')) $('#programInput').value = '';
    $('#minPriceInput').value = '';
    $('#maxPriceInput').value = '';
    $('#locationInput').value = '';
    $('#sortInput').value = 'newest';
    loadListings();
  });
  $$('.tab').forEach((btn) => btn.addEventListener('click', () => setTab(btn.dataset.tab)));
  $('[data-close]')?.addEventListener('click', closeModals);
  $$('[data-close]').forEach((btn) => btn.addEventListener('click', closeModals));
  $('#modalBackdrop').addEventListener('click', closeModals);
  $('#replyForm').addEventListener('submit', sendReply);
  $('#buyerOrdersBtn').addEventListener('click', () => {
    state.orderRole = 'buyer';
    $('#buyerOrdersBtn').className = 'btn small primary';
    $('#sellerOrdersBtn').className = 'btn small ghost';
    loadOrders();
  });
  $('#sellerOrdersBtn').addEventListener('click', () => {
    state.orderRole = 'seller';
    $('#sellerOrdersBtn').className = 'btn small primary';
    $('#buyerOrdersBtn').className = 'btn small ghost';
    loadOrders();
  });
  $('#refreshReportsBtn').addEventListener('click', loadReports);
  $$('[data-admin-section]').forEach((btn) => btn.addEventListener('click', () => loadAdminSection(btn.dataset.adminSection)));
}

window.showListing = showListing;
window.deleteListing = deleteListing;
window.openThread = openThread;
window.updateShipping = updateShipping;
window.resolveReport = resolveReport;
window.confirmOrder = confirmOrder;
window.resendVerification = resendVerification;

async function loadOrders() {
  if (!state.user) {
    $('#ordersLoginHint').classList.remove('hidden');
    $('#ordersList').innerHTML = '';
    return;
  }
  $('#ordersLoginHint').classList.add('hidden');
  const data = await api(`/api/orders?role=${state.orderRole === 'seller' ? 'seller' : 'buyer'}`);
  if (!data.orders.length) {
    $('#ordersList').innerHTML = `<div class="empty">No ${state.orderRole === 'seller' ? 'sales' : 'purchases'} yet.</div>`;
    return;
  }
  $('#ordersList').innerHTML = data.orders.map((o) => `
    <div class="order-card ${['paid', 'paid_demo', 'shipped'].includes(o.status) && !((state.orderRole === 'buyer' && o.buyer_confirmed) || (state.orderRole === 'seller' && o.seller_confirmed)) ? 'needs-attention' : ''}">
      <div class="order-top">
        <div>
          <h3>${escapeHtml(o.listing_title)}</h3>
          <div class="price">${money(o.amount_cents, o.currency)}</div>
          <div class="meta">Buyer: ${escapeHtml(o.buyer_name)} | Seller: ${escapeHtml(o.seller_name)}</div>
          <div class="meta">Confirmations: buyer ${o.buyer_confirmed ? 'done' : 'waiting'} | seller ${o.seller_confirmed ? 'done' : 'waiting'}</div>
          <div class="meta">Ship to: ${escapeHtml(o.shipping_name || '')}, ${escapeHtml(o.shipping_city || '')}, ${escapeHtml(o.shipping_country || '')}</div>
          ${o.tracking_number || o.label_url ? `<div class="meta">Shipping: ${escapeHtml(o.carrier || '')} ${escapeHtml(o.tracking_number || '')} ${o.label_url ? `| <a href="${escapeHtml(o.label_url)}" target="_blank" rel="noreferrer">Label</a>` : ''}</div>` : ''}
        </div>
        <span class="status ${escapeHtml(o.status)}">${escapeHtml(o.status)}</span>
      </div>
      ${['paid', 'paid_demo', 'shipped'].includes(o.status) && !((state.orderRole === 'buyer' && o.buyer_confirmed) || (state.orderRole === 'seller' && o.seller_confirmed)) ? `
        <div class="card-actions">
          <button class="btn success" onclick="confirmOrder(${o.id})">Confirm my side</button>
        </div>
      ` : ''}
      ${state.orderRole === 'seller' && ['paid', 'paid_demo'].includes(o.status) ? `
        <form class="ship-form" onsubmit="updateShipping(event, ${o.id})">
          <input name="carrier" placeholder="Carrier: USPS, UPS...">
          <input name="trackingNumber" placeholder="Tracking number">
          <input name="labelUrl" placeholder="Label URL optional">
          <button class="btn primary">Update shipping</button>
        </form>
      ` : ''}
    </div>
  `).join('');
}

async function confirmOrder(orderId) {
  await api(`/api/orders/${orderId}/confirm`, { method: 'PATCH' });
  toast('Confirmation saved.');
  await loadOrders();
  await loadNotifications();
}

function showAdminPane(name) {
  state.adminSection = name;
  $$('[data-admin-section]').forEach((btn) => {
    btn.className = `btn small ${btn.dataset.adminSection === name ? 'primary' : 'ghost'}`;
  });
  $('#reportsList').classList.toggle('hidden', name !== 'reports');
  $('#adminOverview').classList.toggle('hidden', name !== 'overview');
  $('#adminUsers').classList.toggle('hidden', name !== 'users');
  $('#adminOrders').classList.toggle('hidden', name !== 'orders');
}

async function loadAdminSection(name = 'reports') {
  if (!state.user || state.user.role !== 'admin') return;
  showAdminPane(name);
  if (name === 'reports') return loadReports();
  const data = await api('/api/admin/overview');
  state.adminOverview = data;
  if (name === 'overview') {
    $('#adminOverview').innerHTML = `
      <div class="stats-grid">
        <div class="stat"><strong>${data.stats.users}</strong><span>active users</span></div>
        <div class="stat"><strong>${data.stats.listings}</strong><span>active offers</span></div>
        <div class="stat"><strong>${data.stats.orders}</strong><span>orders</span></div>
        <div class="stat"><strong>${data.stats.openReports}</strong><span>open reports</span></div>
      </div>
    `;
  }
  if (name === 'users') {
    $('#adminUsers').innerHTML = data.users.map((u) => `
      <div class="order-card">
        <div class="order-top">
          <div>
            <h3>${escapeHtml(u.name)}</h3>
            <div class="meta">${escapeHtml(u.email)} | ${u.email_verified ? 'email verified' : 'email unverified'} | ${escapeHtml(u.role)}${u.banned ? ' | banned' : ''}</div>
          </div>
          <span class="status">${new Date(u.created_at).toLocaleDateString()}</span>
        </div>
      </div>
    `).join('');
  }
  if (name === 'orders') {
    $('#adminOrders').innerHTML = data.orders.map((o) => `
      <div class="order-card ${o.buyer_confirmed && o.seller_confirmed ? '' : 'needs-attention'}">
        <div class="order-top">
          <div>
            <h3>${escapeHtml(o.listing_title)}</h3>
            <div class="meta">Buyer: ${escapeHtml(o.buyer_name)} | Seller: ${escapeHtml(o.seller_name)}</div>
            <div class="meta">Confirmations: buyer ${o.buyer_confirmed ? 'done' : 'waiting'} | seller ${o.seller_confirmed ? 'done' : 'waiting'}</div>
          </div>
          <span class="status ${escapeHtml(o.status)}">${escapeHtml(o.status)}</span>
        </div>
      </div>
    `).join('');
  }
}

async function loadReports() {
  if (!state.user || state.user.role !== 'admin') return;
  showAdminPane('reports');
  const data = await api('/api/admin/reports');
  if (!data.reports.length) {
    $('#reportsList').innerHTML = '<div class="empty">No reports yet.</div>';
    await loadNotifications();
    return;
  }
  $('#reportsList').innerHTML = data.reports.map((r) => `
    <div class="report-card ${r.status === 'open' ? 'needs-attention' : ''}">
      <div class="order-top">
        <div>
          <h3>${escapeHtml(r.listing_title)}</h3>
          <div class="meta">Reason: ${escapeHtml(r.reason)}</div>
          <div class="meta">Reported by: ${escapeHtml(r.reporter_name)}</div>
          <div class="meta">Seller: ${escapeHtml(r.seller_name)} (${escapeHtml(r.seller_email)}) ${r.seller_banned ? '| banned' : ''}</div>
          <div class="meta">Listing status: ${escapeHtml(r.listing_status)}</div>
        </div>
        <span class="status ${escapeHtml(r.status)}">${escapeHtml(r.status)}</span>
      </div>
      <div class="card-actions">
        <button class="btn primary" onclick="showListing(${r.listing_id})">Open offer</button>
        <button class="btn success" onclick="resolveReport(${r.id}, false, false)">Resolve</button>
        <button class="btn danger" onclick="resolveReport(${r.id}, true, false)">Delete listing</button>
        <button class="btn danger" onclick="resolveReport(${r.id}, true, true)">Ban seller</button>
      </div>
    </div>
  `).join('');
  await loadNotifications();
}

function renderAuthState() {
  const loggedIn = Boolean(state.user);
  $('#sellBtn').classList.toggle('hidden', !(loggedIn && state.user.role === 'admin'));
  $('#userChip').classList.toggle('hidden', !loggedIn);
  $('#authBtn').textContent = loggedIn ? 'Log out' : 'Log in';
  if (loggedIn) {
    $('#userChip').textContent = `${state.user.name}${state.user.role === 'admin' ? ' | admin' : ''}${state.user.emailVerified || !state.config.emailVerificationRequired ? '' : ' | verify email'}`;
  }
  $('#adminTab').classList.toggle('hidden', !(state.user && state.user.role === 'admin'));
}

function renderBadge(id, count) {
  const badge = $(id);
  if (!badge) return;
  badge.classList.add('hidden');
}

function notificationKey(notifications) {
  return ['messages', 'orders', 'admin'].map((key) => notifications[key] || 0).join('|');
}

function notificationText(notifications) {
  const parts = [];
  if (notifications.messages) {
    parts.push(`${notifications.messages} unread message${notifications.messages === 1 ? '' : 's'}`);
  }
  if (notifications.orders) {
    parts.push(`${notifications.orders} order${notifications.orders === 1 ? '' : 's'} needing your attention`);
  }
  if (notifications.admin) {
    parts.push(`${notifications.admin} report${notifications.admin === 1 ? '' : 's'} to review`);
  }
  return parts.length ? `Notification: ${parts.join(' | ')}.` : '';
}

function showNotificationPopup(notifications) {
  const message = notificationText(notifications);
  if (message) toast(message);
}

async function loadNotifications() {
  if (!state.user) {
    renderBadge('#messagesBadge', 0);
    renderBadge('#ordersBadge', 0);
    renderBadge('#adminBadge', 0);
    state.notifications = { messages: 0, orders: 0, admin: 0 };
    state.lastNotificationKey = '';
    return;
  }
  const data = await api('/api/notifications');
  state.notifications = data.notifications;
  renderBadge('#messagesBadge', state.notifications.messages);
  renderBadge('#ordersBadge', state.notifications.orders);
  renderBadge('#adminBadge', state.notifications.admin);
  const key = notificationKey(state.notifications);
  if (key !== state.lastNotificationKey) {
    state.lastNotificationKey = key;
    showNotificationPopup(state.notifications);
  }
}

function startNotificationPolling() {
  if (state.notificationPollId) window.clearInterval(state.notificationPollId);
  state.notificationPollId = window.setInterval(() => {
    loadNotifications().catch((err) => console.error(err));
  }, 30000);
}

async function resendVerification() {
  await api('/api/auth/resend-verification', { method: 'POST' });
  toast('Verification link sent.');
}

(async function init() {
  try {
    await loadConfig();
    setupEvents();
    updateAuthMode('login');
    updateCustomCategoryVisibility();
    await loadMe();
    await loadListings();
    startNotificationPolling();
    const url = new URL(window.location.href);
    if (url.searchParams.get('verified') === 'email') {
      toast('Email verified. You can now use marketplace actions.');
      await loadMe();
      window.history.replaceState({}, '', window.location.pathname);
    }
    if (url.searchParams.get('payment') === 'success') toast('Payment succeeded. Your order will update after the Stripe webhook finishes.');
    if (url.searchParams.get('payment') === 'cancelled') toast('Payment cancelled.');
  } catch (err) {
    console.error(err);
    toast(err.message);
  }
})();
