/* ThreadTrace app logic: auth, profile, settings, rules, search, PDF evidence */
const TT = { settings: null, serverClientId: '' };
const DEFAULT_SETTINGS = { sound: true, notify: false, expectedAlarm: true, sms: false,
  dkimPin: true, zeroTrust: true, autoQuarantine: true, blockLookalike: true, threshold: '99', autoLock: '0' };
function lsGet(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
TT.settings = Object.assign({}, DEFAULT_SETTINGS, lsGet('tt_settings', {}));
const $ = id => document.getElementById(id);

function toast(msg) {
  let t = $('ttToast');
  if (!t) { t = document.createElement('div'); t.id = 'ttToast';
    t.className = 'fixed top-4 left-1/2 -translate-x-1/2 z-[70] px-4 py-2 rounded-xl bg-slate-900 border border-cyan-400/50 text-cyan-200 text-xs font-mono shadow-lg';
    t.style.transition = 'opacity .3s'; document.body.appendChild(t); }
  t.textContent = msg; t.style.opacity = 1; clearTimeout(t._h); t._h = setTimeout(() => t.style.opacity = 0, 3500);
}

// ---------------- profiles / session ----------------
const profiles = () => lsGet('tt_profiles', {});
const currentId = () => sessionStorage.getItem('tt_user');
const currentProfile = () => profiles()[currentId()] || null;
function saveCurrentProfile(p) { const all = profiles(); all[currentId()] = p; lsSet('tt_profiles', all); }
function initials(p) {
  const s = (p && (p.name || p.email)) || 'TT';
  const parts = s.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
  return ((parts[0] || 'T')[0] + ((parts[1] || parts[0] || 'T')[1] || (parts[1] || '')[0] || '')).toUpperCase().slice(0, 2);
}
function applyProfileUI() {
  const p = currentProfile() || {};
  if ($('hdrName')) $('hdrName').textContent = p.name || p.email || 'Guest';
  if ($('hdrRole')) $('hdrRole').textContent = p.email ? (p.provider || 'Connected') + ' · ' + p.email : (p.provider || 'Device login');
  if ($('hdrInitials')) $('hdrInitials').textContent = initials(p);
}
function loginSuccess(info) {
  const id = info.id || info.email || 'device';
  const all = profiles(); const p = all[id] || {};
  if (info.email) p.email = info.email;
  if (info.provider && !p.provider) p.provider = info.provider;
  if (info.provider && info.provider.startsWith('Google')) p.provider = 'Google';
  if (info.name && !p.name) p.name = info.name;
  if (info.picture) p.picture = info.picture;
  all[id] = p; lsSet('tt_profiles', all);
  sessionStorage.setItem('tt_auth', '1'); sessionStorage.setItem('tt_user', id); localStorage.setItem('tt_last', id);
  applyProfileUI(); switchView('dashboard'); startIdleTimer();
  if (!p.name || !p.phone) openOnboarding(); else toast('Welcome back, ' + p.name);
}
function logout(reason) {
  sessionStorage.removeItem('tt_auth'); sessionStorage.removeItem('tt_user');
  try { if (window.google && google.accounts) google.accounts.id.disableAutoSelect(); } catch (e) {}
  const o = $('onboardModal'); if (o) o.classList.add('hidden');
  switchView('login'); toast(reason || 'Logged out');
}

// ---------------- onboarding (name + mobile) ----------------
function openOnboarding() {
  const p = currentProfile() || {};
  $('obName').value = p.name || ''; $('obPhone').value = p.phone || ''; $('obErr').textContent = '';
  $('obEmail').textContent = p.email || '(no email linked)';
  $('onboardModal').classList.remove('hidden');
}
function saveOnboarding() {
  const name = $('obName').value.trim(), phone = $('obPhone').value.replace(/[\s-]/g, '');
  if (name.length < 2) return $('obErr').textContent = 'Enter your full name.';
  if (!/^\+?\d{10,15}$/.test(phone)) return $('obErr').textContent = 'Enter a valid mobile number (10-15 digits, e.g. +919876543210).';
  const p = currentProfile() || {}; p.name = name; p.phone = phone; p.savedAt = new Date().toISOString();
  saveCurrentProfile(p); applyProfileUI();
  $('onboardModal').classList.add('hidden'); toast('Profile saved. Welcome, ' + name);
}

// ---------------- email login (OTP when server mail is on, else demo) ----------------
let MAIL_ON = false, OTP_EMAIL = '';
async function simulateEmailLogin() {
  const email = $('loginEmailInput').value.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return alertModal('Email required', 'Enter a valid email address.');
  if (!MAIL_ON) return loginSuccess({ id: email, email, provider: 'Email (demo)' });
  try {
    const r = await fetch('/api/send-otp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error);
    OTP_EMAIL = email; $('otpBox').classList.remove('hidden'); $('otpInput').focus();
    alertModal('Code sent', `A 6-digit code was sent to ${email}. Check inbox/spam.`);
  } catch (e) { alertModal('Could not send code', String(e.message || e)); }
}
async function verifyOtp() {
  try {
    const r = await fetch('/api/verify-otp', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: OTP_EMAIL, code: $('otpInput').value }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error);
    $('otpBox').classList.add('hidden');
    loginSuccess({ id: d.email, email: d.email, provider: 'Email' });
  } catch (e) { alertModal('Verification failed', String(e.message || e)); }
}

// ---------------- Google Sign-In ----------------
const ttClientId = () => (window.TT_CONFIG && TT_CONFIG.googleClientId) || TT.serverClientId || '';
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.async = true; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }
async function initGoogle() {
  try { const r = await fetch('/api/config'); if (r.ok) { const c = await r.json(); MAIL_ON = !!c.mailOn; TT.serverClientId = c.googleClientId || ''; } } catch (e) {}
  const cid = ttClientId(); if (!cid) return;
  try {
    await loadScript('https://accounts.google.com/gsi/client');
    google.accounts.id.initialize({ client_id: cid, callback: onGoogleCredential });
    google.accounts.id.renderButton($('googleSignInHolder'), { theme: 'filled_black', size: 'large', text: 'continue_with', shape: 'pill', width: 300 });
    $('googleSignInHolder').classList.remove('hidden'); $('googleFallbackBtn').classList.add('hidden');
  } catch (e) { /* offline: keep fallback button */ }
}
function parseJwt(t) {
  let b = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); b += '='.repeat((4 - b.length % 4) % 4);
  return JSON.parse(decodeURIComponent(atob(b).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')));
}
function onGoogleCredential(resp) {
  try {
    const pl = parseJwt(resp.credential);
    if (pl.aud !== ttClientId() || pl.exp * 1000 < Date.now() || pl.email_verified === false) throw new Error('Invalid Google token');
    loginSuccess({ id: pl.email, email: pl.email, name: pl.name, picture: pl.picture, provider: 'Google' });
    if (TT.serverClientId) // optional: server verifies token and emails a login alert
      fetch('/api/google-login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: resp.credential, device: navigator.userAgent }) })
        .then(r => r.ok ? r.json() : null).then(d => { if (d && d.mailSent) toast('Security alert emailed to ' + d.email); }).catch(() => {});
  } catch (e) { alertModal('Google login failed', String(e.message || e)); }
}
function googleFallback() {
  alertModal('Google login needs a Client ID',
    '1) console.cloud.google.com -> Credentials -> Create OAuth client ID (Web)\n2) Add your site URL under Authorized JavaScript origins\n3) Paste the Client ID in config.js (googleClientId) and redeploy.\n\nFull steps are in SETUP.md. Until then use Email or Fingerprint login.');
}

// ---------------- real fingerprint (WebAuthn) ----------------
const rnd = n => crypto.getRandomValues(new Uint8Array(n));
const toB64 = b => btoa(String.fromCharCode(...new Uint8Array(b)));
const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
let isScanning = false;
function bioMsg(msg, cls) { const t = $('bioStatusText'); t.textContent = msg; t.className = 'text-xs font-semibold mt-2 ' + (cls || 'text-slate-200'); }
async function runBiometricScan() {
  if (isScanning) return;
  if (!window.isSecureContext || !window.PublicKeyCredential)
    return bioMsg('Fingerprint needs HTTPS or localhost.', 'text-rose-400');
  isScanning = true; playCyberChime(700, 'sine', 0.15);
  const scanner = $('biometricScanner'); scanner.classList.add('neon-border-cyan');
  try {
    if (!(await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()))
      throw new Error('No fingerprint / screen lock set up on this device.');
    const saved = localStorage.getItem('tt_cred');
    if (!saved) {
      bioMsg('First time: touch the sensor to register this device...', 'text-cyan-300 animate-pulse');
      const cred = await navigator.credentials.create({ publicKey: {
        challenge: rnd(32), rp: { name: 'ThreadTrace' },
        user: { id: rnd(16), name: 'threadtrace-user', displayName: 'ThreadTrace User' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' }, timeout: 60000 } });
      localStorage.setItem('tt_cred', toB64(cred.rawId));
    } else {
      bioMsg('Touch the fingerprint sensor to unlock...', 'text-cyan-300 animate-pulse');
      await navigator.credentials.get({ publicKey: { challenge: rnd(32), userVerification: 'required', timeout: 60000,
        allowCredentials: [{ type: 'public-key', id: fromB64(saved), transports: ['internal'] }] } });
    }
    playCyberChime(1500, 'triangle', 0.25); bioMsg('✓ Fingerprint verified', 'text-emerald-400');
    scanner.classList.remove('neon-border-cyan'); scanner.classList.add('neon-border-success');
    setTimeout(() => {
      scanner.classList.remove('neon-border-success');
      const last = localStorage.getItem('tt_last') || 'device';
      loginSuccess({ id: last, email: (profiles()[last] || {}).email || '', provider: 'Fingerprint' });
    }, 500);
  } catch (e) {
    scanner.classList.remove('neon-border-cyan');
    bioMsg(e && e.name === 'NotAllowedError' ? 'Cancelled or fingerprint not recognised. Try again.' : String(e.message || e), 'text-rose-400');
  } finally { isScanning = false; }
}
function resetBiometric() { localStorage.removeItem('tt_cred'); toast('Fingerprint registration removed from this device'); }

// ---------------- idle auto-lock ----------------
let idleT = null, idleBound = false;
function startIdleTimer() {
  clearTimeout(idleT);
  const mins = parseInt(TT.settings.autoLock, 10) || 0; if (!mins || !isAuthed()) return;
  idleT = setTimeout(() => logout('Locked after ' + mins + ' min of inactivity'), mins * 60000);
  if (!idleBound) { idleBound = true; ['click', 'keydown', 'touchstart', 'mousemove'].forEach(ev => document.addEventListener(ev, () => { if (isAuthed()) startIdleTimer(); }, { passive: true })); }
}

// ---------------- settings view ----------------
const TOGGLES = ['sound', 'notify', 'expectedAlarm', 'sms', 'dkimPin', 'zeroTrust', 'autoQuarantine', 'blockLookalike'];
function renderSettings() {
  const p = currentProfile() || {};
  $('stName').value = p.name || ''; $('stPhone').value = p.phone || ''; $('stEmail').textContent = p.email || '(none)';
  $('stProvider').textContent = p.email ? (p.provider || 'Connected') + ' account connected' : 'No email linked (device login)';
  TOGGLES.forEach(k => { const el = $('set_' + k); if (el) el.checked = !!TT.settings[k]; });
  $('set_threshold').value = TT.settings.threshold; $('set_autoLock').value = TT.settings.autoLock;
}
function saveProfileForm() {
  const name = $('stName').value.trim(), phone = $('stPhone').value.replace(/[\s-]/g, '');
  if (name.length < 2) return toast('Enter your name');
  if (!/^\+?\d{10,15}$/.test(phone)) return toast('Enter a valid mobile number');
  const p = currentProfile() || {}; p.name = name; p.phone = phone; saveCurrentProfile(p); applyProfileUI(); toast('Profile saved');
}
function setSetting(k, v) {
  TT.settings[k] = v; lsSet('tt_settings', TT.settings);
  if (k === 'notify' && v) {
    if (!('Notification' in window)) { toast('Browser notifications not supported'); }
    else Notification.requestPermission().then(r => { toast(r === 'granted' ? 'Browser notifications enabled' : 'Notification permission denied'); if (r === 'granted') new Notification('ThreadTrace', { body: 'Alerts are ON for this device.' }); });
  } else if (k === 'autoLock') { startIdleTimer(); toast('Auto-lock updated'); }
  else toast('Saved');
}
function downloadBlob(blob, name) { const u = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 2000); }
function exportMyData() {
  downloadBlob(new Blob([JSON.stringify({ profile: currentProfile(), settings: TT.settings, rules: lsGet('tt_rules', []) }, null, 2)], { type: 'application/json' }), 'ThreadTrace-my-data.json');
}
function clearAllData() {
  if (!confirm('Delete all saved profiles, settings, rules and fingerprint registration from this device?')) return;
  localStorage.clear(); TT.settings = Object.assign({}, DEFAULT_SETTINGS); logout('All local data deleted');
}

// ---------------- expected-mail rules ----------------
function statusOf(card) { const t = card.textContent.toUpperCase();
  return t.includes('SUSPICIOUS') ? 'alarm' : t.includes('VERIFIED') ? 'verified' : t.includes('MISSED') ? 'missed' : 'armed'; }
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function renderUserRules() {
  const grid = $('ruleGrid'); if (!grid) return;
  grid.querySelectorAll('[data-user-rule]').forEach(n => n.remove());
  lsGet('tt_rules', []).forEach(r => {
    const d = document.createElement('div'); d.setAttribute('data-user-rule', r.id); d.setAttribute('data-status', 'armed');
    d.className = 'glass-card rounded-2xl p-5 space-y-3 border-cyan-500/40';
    d.innerHTML = `<div class="flex items-center justify-between"><span class="text-xs font-mono text-slate-400">#USR-${esc(r.id.slice(-4))} • ${esc(r.cadence)}</span>
      <span class="px-2 py-0.5 rounded-full bg-cyan-500/20 border border-cyan-400/40 text-cyan-300 text-[10px] font-mono font-bold">ARMED • WATCHING</span></div>
      <h4 class="text-sm font-bold text-white">${esc(r.name)}</h4>
      <div class="text-xs font-mono text-slate-400">Expected sender: <span class="text-cyan-300">${esc(r.sender)}</span></div>
      <div class="text-xs font-mono text-slate-400">Window: ${esc(r.window)}</div>
      <button onclick="removeRule('${r.id}')" class="text-[11px] font-mono text-rose-300 hover:text-rose-200">Delete rule</button>`;
    grid.appendChild(d);
  });
  updateRuleCounts();
}
function saveNewRule() {
  const name = $('ruleNameInput').value.trim(), sender = $('ruleSenderInput').value.trim();
  if (!name || !/.+[@.].+/.test(sender)) return toast('Enter a rule name and a valid sender / domain');
  const sel = $('newRuleModal').querySelectorAll('select');
  const rules = lsGet('tt_rules', []);
  rules.push({ id: 'r' + Date.now(), name, sender, cadence: sel[0] ? sel[0].value : '', window: sel[1] ? sel[1].value : '' });
  lsSet('tt_rules', rules); closeNewRuleModal(); renderUserRules(); filterRules('all');
  toast('Rule "' + name + '" saved and armed');
}
function removeRule(id) { lsSet('tt_rules', lsGet('tt_rules', []).filter(r => r.id !== id)); renderUserRules(); toast('Rule deleted'); }
function updateRuleCounts() {
  const grid = $('ruleGrid'); if (!grid) return;
  const cards = [...grid.children]; cards.forEach(c => { if (!c.dataset.status) c.dataset.status = statusOf(c); });
  const n = s => cards.filter(c => c.dataset.status === s).length;
  $('tab-all').textContent = `All Rules (${cards.length})`; $('tab-alarm').textContent = `Active Alarms (${n('alarm')})`;
  $('tab-verified').textContent = `Verified (${n('verified')})`; $('tab-missed').textContent = `Missed (${n('missed')})`;
  if ($('ruleHeading')) $('ruleHeading').textContent = `Active Expected Mail Rules (${cards.length} Configured)`;
}
function filterRules(f) {
  const grid = $('ruleGrid'); if (!grid) return; updateRuleCounts();
  [...grid.children].forEach(c => c.classList.toggle('hidden', !(f === 'all' || c.dataset.status === f)));
  ['all', 'alarm', 'verified', 'missed'].forEach(k => { const b = $('tab-' + k);
    b.className = 'px-2.5 py-1 rounded-lg text-xs font-mono ' + (k === f ? 'bg-cyan-500/20 text-cyan-300 font-semibold border border-cyan-400/30' : 'bg-slate-900 text-slate-400 hover:text-white'); });
}

// ---------------- global search ----------------
function runSearch(q) {
  q = (q || '').trim().toLowerCase(); if (!q) return;
  if (!isAuthed()) return toast('Log in first');
  let best = null, bestN = 0; const found = [];
  ['dashboard', 'forensics', 'alarm', 'evidence', 'settings'].forEach(v => {
    const el = $('view-' + v); if (!el) return; const n = el.textContent.toLowerCase().split(q).length - 1;
    if (n) found.push(`${v}: ${n}`); if (n > bestN) { bestN = n; best = v; } });
  if (!best) return alertModal('No results', `Nothing found for "${q}".`);
  switchView(best); toast(`Found in: ${found.join(', ')}`); setTimeout(() => { try { window.find(q); } catch (e) {} }, 150);
}
document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); const s = $('globalSearch'); if (s) s.focus(); } });

// ---------------- SHA-256 (pure JS, works on http too) ----------------
function sha256Hex(str) {
  const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const bytes = Array.from(new TextEncoder().encode(str)); const l = bytes.length * 8;
  bytes.push(0x80); while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push(i > 3 ? 0 : (l >>> (i * 8)) & 255);
  let H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < bytes.length; o += 64) {
    const w = new Array(64);
    for (let i = 0; i < 16; i++) w[i] = (bytes[o+4*i] << 24) | (bytes[o+4*i+1] << 16) | (bytes[o+4*i+2] << 8) | bytes[o+4*i+3];
    for (let i = 16; i < 64; i++) { const s0 = rotr(w[i-15],7) ^ rotr(w[i-15],18) ^ (w[i-15] >>> 3), s1 = rotr(w[i-2],17) ^ rotr(w[i-2],19) ^ (w[i-2] >>> 10); w[i] = (w[i-16] + s0 + w[i-7] + s1) | 0; }
    let [a,b,c,d,e,f,g,h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25), ch = (e & f) ^ (~e & g), t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22), mj = (a & b) ^ (a & c) ^ (b & c), t2 = (S0 + mj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H = [(H[0]+a)|0,(H[1]+b)|0,(H[2]+c)|0,(H[3]+d)|0,(H[4]+e)|0,(H[5]+f)|0,(H[6]+g)|0,(H[7]+h)|0];
  }
  return H.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

// ---------------- minimal PDF writer (no libraries) ----------------
function pdfEsc(s) {
  const map = { '\u2019': "'", '\u2018': "'", '\u201c': '"', '\u201d': '"', '\u2013': '-', '\u2014': '-', '\u2192': '->', '\u2022': '*', '\u2713': 'OK' };
  return String(s).replace(/[^\x20-\x7E]/g, c => map[c] || '?').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}
function wrapText(text, maxc) {
  const out = [];
  String(text).split('\n').forEach(line => {
    if (!line) return out.push('');
    while (line.length > maxc) { let cut = line.lastIndexOf(' ', maxc); if (cut < maxc * 0.5) cut = maxc; out.push(line.slice(0, cut)); line = line.slice(cut).replace(/^ /, ''); }
    out.push(line);
  });
  return out;
}
function buildPdf(lines, hdr) {
  const W = 595, H = 842, M = 44, top = H - 86, bottom = 56; const pages = [[]]; let y = top;
  for (const L of lines) {
    const size = L.size || 9, lead = size * 1.5, ind = L.indent || 0, maxc = Math.floor((W - 2 * M - ind) / (size * 0.6));
    y -= (L.gap || 0);
    for (const w of wrapText(L.t || '', maxc)) {
      if (y - lead < bottom) { pages.push([]); y = top; }
      y -= lead; pages[pages.length - 1].push({ t: w, x: M + ind, y, size, bold: L.bold, color: L.color || [0.1, 0.1, 0.12] });
    }
    if (L.rule) { y -= 4; pages[pages.length - 1].push({ rule: true, y }); y -= 4; }
  }
  const n = pages.length, objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${5 + 2 * i} 0 R`).join(' ')}] /Count ${n} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>';
  objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>';
  pages.forEach((items, i) => {
    let c = `0.02 0.07 0.16 rg 0 ${H - 62} ${W} 62 re f 0 0.94 1 rg 0 ${H - 64} ${W} 2 re f\n`;
    c += `BT /F2 14 Tf 1 1 1 rg ${M} ${H - 30} Td (${pdfEsc(hdr.title)}) Tj ET\n`;
    c += `BT /F1 8 Tf 0.6 0.9 1 rg ${M} ${H - 48} Td (${pdfEsc(hdr.sub)}) Tj ET\n`;
    items.forEach(it => {
      if (it.rule) c += `0.7 0.75 0.8 RG 0.5 w ${M} ${it.y} m ${W - M} ${it.y} l S\n`;
      else c += `BT /${it.bold ? 'F2' : 'F1'} ${it.size} Tf ${it.color[0]} ${it.color[1]} ${it.color[2]} rg ${it.x} ${it.y} Td (${pdfEsc(it.t)}) Tj ET\n`;
    });
    c += `BT /F1 7 Tf 0.4 0.4 0.45 rg ${M} 28 Td (${pdfEsc(hdr.footer)}   |   Page ${i + 1} of ${n}) Tj ET\n`;
    objs[5 + 2 * i] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + 2 * i} 0 R >>`;
    objs[6 + 2 * i] = `<< /Length ${c.length} >>\nstream\n${c}endstream`;
  });
  objs[5 + 2 * n] = `<< /Title (${pdfEsc(hdr.title)}) /Producer (ThreadTrace) >>`;
  let out = '%PDF-1.4\n'; const off = [];
  for (let i = 1; i < objs.length; i++) { off[i] = out.length; out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xr = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n` + off.slice(1).map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info ${5 + 2 * n} 0 R >>\nstartxref\n${xr}\n%%EOF`;
  const u = new Uint8Array(out.length); for (let i = 0; i < out.length; i++) u[i] = out.charCodeAt(i) & 255;
  return new Blob([u], { type: 'application/pdf' });
}

// ---------------- evidence dossier ----------------
function evidenceCore() {
  return { incident_id: 'TT-2026-X88219', classification: 'BEC_PUNYCODE_ATTACK', incident_time_utc: '2026-10-08T22:45:19.102Z',
    findings: [
      { parameter: "Header 'From'", declared: 'Elena Rostova <elena@apex-capitaI.com>', verified: "Lookalike domain: capital letter 'I' used instead of lowercase 'l'", verdict: 'HOMOGLYPH FRAUD' },
      { parameter: 'Inbound gateway IP', declared: '194.209.12.18 (CH)', verified: '185.220.101.42 (RU, Tor exit, AS44050)', verdict: 'TOR EXIT ANOMALY' },
      { parameter: 'DKIM verification', declared: 'v=1; a=rsa-sha256; d=apex-capital.com', verified: 'Signature failed against published RSA public key', verdict: 'FAILED DKIM' },
      { parameter: 'Authentication', declared: 'n/a', verified: 'SPF SoftFail, DMARC fail (p=reject)', verdict: 'AUTH FAILURE' },
      { parameter: 'Payment instruction', declared: 'Project Apex settlement routine', verified: 'Wire destination differs: 100% IBAN mismatch', verdict: 'HIGH FINANCIAL RISK' }],
    raw_headers: ['Received: from tor-exit-node42.net (185.220.101.42) by mx.threadtrace-perimeter.net with ESMTP id 88219-TT-SEC; Thu, 08 Oct 2026 14:22:43 +0000',
      'Authentication-Results: threadtrace.net; dkim=fail (bad signature) header.d=apex-capitaI.com; dmarc=fail (p=reject) header.from=apex-capitaI.com; spf=SoftFail (185.220.101.42 is not designated)',
      'Message-ID: <20261008142243.88219.apex-capitaI@relay-spoofer.io>', 'From: "Elena Rostova" <elena.rostova@apex-capitaI.com>', 'To: "David Chen" <david.chen@apex-capital.com>',
      'Subject: RE: Urgent Wire Instruction - Project Apex Acquisition [NEW ESCROW DETAILS]', 'X-ThreadTrace-Risk-Score: 99.8 / 100 (HIGH CRITICAL)', 'X-ThreadTrace-Mitigation: QUARANTINED_SINKHOLE_ID_88219'],
    mitigation: 'QUARANTINED' };
}
function dossierHash() { return sha256Hex(JSON.stringify(evidenceCore())); }
function buildDossier() {
  const p = currentProfile() || {}, core = evidenceCore();
  return Object.assign({}, core, { sha256: dossierHash(), hash_scope: 'SHA-256 over canonical JSON of: incident_id, classification, incident_time_utc, findings, raw_headers, mitigation',
    generated_utc: new Date().toISOString(), generated_by: { name: p.name || '', email: p.email || '', mobile: p.phone || '' },
    signature: 'Not applied in this build (integrity hash only)' });
}
function downloadReportPdf() {
  if (!isAuthed()) return toast('Log in first');
  const d = buildDossier(), p = d.generated_by, DK = [0.02, 0.07, 0.16], RED = [0.75, 0.1, 0.1], GR = [0.35, 0.38, 0.42];
  const L = [];
  const H = t => L.push({ t, size: 11, bold: true, color: DK, gap: 14, rule: true });
  const R = (t, o) => L.push(Object.assign({ t, size: 8.5 }, o || {}));
  L.push({ t: 'INCIDENT DOSSIER #' + d.incident_id, size: 13, bold: true, color: DK, gap: 2 });
  R('Classification: RESTRICTED - for SOC, legal counsel and law enforcement', { color: RED, bold: true });
  R('Incident confirmed: BEC attempt | Mitigation: ' + d.mitigation);
  R('Incident time (UTC): ' + d.incident_time_utc); R('Report generated (UTC): ' + d.generated_utc);
  R('Prepared by: ' + (p.name || 'N/A') + ' | ' + (p.email || 'no email') + ' | Mobile: ' + (p.mobile || 'N/A'));
  H('1. EVIDENCE INTEGRITY');
  R('Algorithm: SHA-256'); R('Evidence hash:', { bold: true }); R(d.sha256, { indent: 8, color: DK, bold: true });
  R('Scope: ' + d.hash_scope, { color: GR, size: 7.5 });
  R('To verify: recompute SHA-256 over the same fields of the accompanying JSON package. Any change gives a different hash.', { color: GR, size: 7.5 });
  R('Digital signature: ' + d.signature, { color: GR, size: 7.5 });
  H('2. SUMMARY');
  R('A spoofed email impersonating a known executive ("Elena Rostova") was sent to the CFO requesting a changed wire destination. The sender domain imitates the real domain using a look-alike character, the message came through a Tor exit node, and DKIM, SPF and DMARC all failed. The message was quarantined before any payment was made.');
  H('3. FINDINGS');
  d.findings.forEach((f, i) => { R(`${i + 1}. ${f.parameter}  [${f.verdict}]`, { bold: true, gap: 4, color: RED }); R('Declared: ' + f.declared, { indent: 12 }); R('Verified: ' + f.verified, { indent: 12 }); });
  H('4. RAW HEADERS (SANITIZED)'); d.raw_headers.forEach(h => R(h, { size: 7, indent: 4, gap: 2 }));
  H('5. CHAIN OF CUSTODY');
  R('2026-10-08 14:22:43 UTC  Message received at perimeter MTA (ThreadTrace).'); R('2026-10-08 14:22:44 UTC  Automated analysis completed; risk 99.8/100.');
  R('2026-10-08 14:22:45 UTC  Message quarantined (sinkhole ID 88219).'); R(d.generated_utc.replace('T', ' ').slice(0, 19) + ' UTC  Dossier exported by ' + (p.name || p.email || 'user') + '.');
  H('6. HOW TO REPORT (INDIA)');
  R('Financial fraud: call 1930 (National Cyber Crime Helpline) immediately and file a complaint at cybercrime.gov.in. Attach: this PDF, the JSON package, and the original .eml file. Inform your bank to freeze the destination account.');
  H('7. ANNEXURE: ELECTRONIC RECORD CERTIFICATE (TEMPLATE)');
  R('Certificate in the manner of Section 63, Bharatiya Sakshya Adhiniyam 2023. To be completed and signed by the person in charge of the device/system. Confirm the format with your legal counsel.', { color: GR, size: 7.5 });
  R('I, ____________________, confirm that the electronic record described above was produced by a computer used regularly to store and process information, was operating properly, and the contents are a true reproduction of the original.', { gap: 6 });
  R('Name: ______________   Designation: ______________   Date: ___________   Signature: ______________', { gap: 14 });
  const blob = buildPdf(L, { title: 'THREADTRACE | DIGITAL EVIDENCE DOSSIER', sub: 'Incident #' + d.incident_id + ' | ISO/IEC 27037 aligned handling', footer: 'SHA-256 ' + d.sha256.slice(0, 16) + '...' });
  downloadBlob(blob, 'ThreadTrace-Dossier-' + d.incident_id + '.pdf'); playCyberChime(1600, 'sine', 0.25);
  if ($('sha256Text')) $('sha256Text').textContent = d.sha256;
  alertModal('PDF downloaded', 'ThreadTrace-Dossier-' + d.incident_id + '.pdf\n\nSHA-256 evidence hash:\n' + d.sha256 + '\n\nAttach the JSON package too (Export JSON Package).');
}
function exportJsonDossier() {
  if (!isAuthed()) return toast('Log in first'); playCyberChime(1300, 'sine', 0.15);
  const d = buildDossier(); downloadBlob(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }), 'ThreadTrace-Evidence-' + d.incident_id + '.json');
  if ($('sha256Text')) $('sha256Text').textContent = d.sha256; toast('JSON evidence package downloaded');
}
function copyHash() {
  const hash = $('sha256Text').innerText.trim();
  (navigator.clipboard ? navigator.clipboard.writeText(hash) : Promise.reject()).then(() => { playCyberChime(1500, 'sine', 0.1); toast('Hash copied'); }).catch(() => alertModal('Forensic SHA-256 Hash', hash));
}

// ---------------- boot ----------------
window.addEventListener('load', () => {
  if ($('sha256Text')) $('sha256Text').textContent = dossierHash();
  renderUserRules(); filterRules('all'); applyProfileUI();
});
