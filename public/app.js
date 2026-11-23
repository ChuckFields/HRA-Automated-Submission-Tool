/* HRA Dashboard front-end. Plain JS, no build step. */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const money = (c) => (c == null ? '' : (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const usDate = (iso) => (iso ? `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}` : '');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const BENEFITS = ['deductible', 'copay'];
  const BENEFIT_NAME = { deductible: 'Deductible', copay: 'Copay' };

  const state = { app: null, view: null, jobs: [], sort: { key: 'service_start', desc: true }, filters: {}, es: null, tab: null, showPlanManual: false, jobModalId: null };

  async function api(path, opts = {}) {
    const init = { ...opts };
    if (opts.body !== undefined) {
      init.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch(path, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data;
  }
  let toastTimer;
  function toast(msg, bad = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast${bad ? ' bad' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), bad ? 8000 : 3500);
  }

  // ---------- loading ----------
  async function loadAll() {
    const [app, view, jobs] = await Promise.all([api('/api/state'), api('/api/claims'), api('/api/jobs')]);
    state.app = app;
    state.view = view;
    state.jobs = jobs;
    renderAll();
  }
  async function reloadClaims() {
    state.view = await api('/api/claims');
    renderTabs();
    renderCards();
    renderTable();
    renderActivity();
  }
  async function reloadState() {
    state.app = await api('/api/state');
    renderHeader();
    renderSetup();
    renderTabs();
  }

  // ---------- rendering ----------
  function renderAll() {
    renderHeader();
    renderTabs();
    renderSetup();
    renderCards();
    renderFilters();
    renderTable();
    renderActivity();
    renderJobs();
  }

  function claimsUnlocked() {
    const s = state.app.settings;
    return Boolean(s.last_ibx_fetch_at && s.last_summit_sync_at);
  }
  function renderTabs() {
    const unlocked = claimsUnlocked();
    const claimsTab = $('.tab[data-tab="claims"]');
    claimsTab.disabled = !unlocked;
    claimsTab.title = unlocked ? '' : 'Fetch claims and sync Summit first';
    if (!state.tab) {
      const c = state.app.credentials;
      state.tab = unlocked ? 'claims' : c.ibx || c.summit ? 'setup' : 'guide';
    }
    if (state.tab === 'claims' && !unlocked) state.tab = 'setup';
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === state.tab));
    for (const name of ['guide', 'setup', 'claims', 'logs']) $(`#tab-${name}`).classList.toggle('hidden', state.tab !== name);
  }

  function renderHeader() {
    const { app, view } = state;
    const plan = app.plans.find((p) => p.key === app.settings.plan_option);
    $('#plan-badge').textContent = app.setup_complete && plan ? `${plan.label} · ${app.settings.coverage_tier === 'family' ? 'family' : 'employee only'} · ${app.settings.plan_year}` : '';
    const d = view.deadline;
    const dl = $('#deadline');
    dl.textContent = `${d.days_left} days to submit (deadline ${usDate(d.date)})`;
    dl.className = `pill ${d.days_left < 30 ? 'bad' : d.days_left < 90 ? 'warn' : ''}`;
    $('#btn-fetch-2').disabled = app.busy;
    $('#btn-sync-2').disabled = app.busy;
    $('#ibx-ready').classList.toggle('hidden', !app.credentials.ibx);
    $('#summit-ready').classList.toggle('hidden', !app.credentials.summit);
    const s = app.settings;
    lastRun($('#fetch-last'), s.last_ibx_fetch_at, s.last_ibx_fetch_claims == null ? '' : `${s.last_ibx_fetch_claims} claim${s.last_ibx_fetch_claims === 1 ? '' : 's'}, ${s.last_ibx_fetch_pdfs ?? 0} document${s.last_ibx_fetch_pdfs === 1 ? '' : 's'}`);
    lastRun($('#sync-last'), s.last_summit_sync_at, s.last_summit_sync_transactions == null ? '' : `${s.last_summit_sync_transactions} submission${s.last_summit_sync_transactions === 1 ? '' : 's'}`);
  }

  function lastRun(el, at, what) {
    if (!at) { el.textContent = 'never run'; el.className = 'last-run never'; return; }
    const d = new Date(at);
    el.textContent = `Last run ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${what ? ' · ' + what : ''}`;
    el.className = 'last-run';
  }
  function stat(label, value, sub, pct) {
    return `<div class="stat"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}${pct != null ? `<div class="bar"><i style="width:${Math.min(100, Math.max(0, pct))}%"></i></div>` : ''}</div>`;
  }
  /** One card for the deductible: the full IBX deductible with the HRA band (threshold..threshold+cap) marked on it. */
  function deductibleCard(t) {
    const total = t.threshold_cents + t.cap_cents;
    const pct = (c) => Math.min(100, Math.max(0, (c / total) * 100));
    const applied = t.deductible_applied_cents;
    const inBand = applied > t.threshold_cents;
    const sub = inBand
      ? `In the HRA band: ${money(t.hra_deductible_paid_cents)} reimbursable, ${money(t.hra_deductible_remaining_cents)} left`
      : `${money(t.threshold_cents - applied)} more before the HRA band starts`;
    return `<div class="stat wide">
      <div class="label">Family deductible this year</div>
      <div class="value">${money(applied)} <span class="muted small">of ${money(total)}</span></div>
      <div class="sub">You pay up to ${money(t.threshold_cents)}; the HRA pays back ${money(t.threshold_cents)}–${money(total)}. ${esc(sub)}</div>
      <div class="band">
        <i class="band-hra" style="left:${pct(t.threshold_cents)}%;width:${pct(total) - pct(t.threshold_cents)}%"></i>
        <i class="band-fill" style="width:${pct(applied)}%"></i>
        <b class="band-tick" style="left:${pct(t.threshold_cents)}%"></b>
      </div>
      <div class="band-labels"><span>$0</span><span style="left:${pct(t.threshold_cents)}%">${money(t.threshold_cents)}</span><span class="end">${money(total)}</span></div>
    </div>`;
  }
  /** Everything about reimbursements in one place: per benefit, what came back, what is still to claim, what is unused. */
  function moneyCard(view, t, c) {
    const row = (name, note, received, toClaim, cap) => {
      const unused = Math.max(0, cap - received - toClaim);
      const pct = (v) => (cap ? Math.min(100, (v / cap) * 100) : 0);
      return `<div class="money-row">
        <div class="money-head"><b>${esc(name)}</b> <span class="muted small">${esc(note)}</span></div>
        <div class="stacked">
          <i class="seg got" style="width:${pct(received)}%" title="received"></i><i class="seg todo" style="width:${pct(toClaim)}%" title="still to claim"></i>
        </div>
        <div class="money-legend"><span><i class="dot got"></i>${money(received)} received</span><span><i class="dot todo"></i>${money(toClaim)} still to claim</span><span><i class="dot left"></i>${money(unused)} of ${money(cap)} unused</span></div>
      </div>`;
    };
    const copayToClaim = Math.max(0, t.copay_reimb_cents - view.received_copay_cents);
    const dedToClaim = Math.max(0, t.hra_deductible_paid_cents - view.received_deductible_cents);
    return `<div class="stat wide money">
      <div class="label">Money back from the HRA</div>
      <div class="value">${money(view.received_cents)} received <span class="muted small">· ${money(view.pending_expected_cents)} still to claim on ${c.toSubmit} claim${c.toSubmit === 1 ? '' : 's'} · ${c.submitted} filed, ${c.paid} approved or paid</span></div>
      ${row('Copays', '50% back, up to $500 a year', view.received_copay_cents, copayToClaim, t.copay_cap_cents)}
      ${row('Deductible', `100% of what you pay between ${money(t.threshold_cents)} and ${money(t.threshold_cents + t.cap_cents)}`, view.received_deductible_cents, dedToClaim, t.cap_cents)}
    </div>`;
  }
  /** One simple card: a donut of received vs still to claim, plus a sentence about the deductible. */
  function hraCard(view, t) {
    const applied = t.deductible_applied_cents;
    const total2 = t.threshold_cents + t.cap_cents;
    const pct = (v, of) => (of ? Math.min(100, Math.max(0, (v / of) * 100)) : 0);
    const dedReceived = view.received_deductible_cents;
    const dedToClaim = Math.max(0, t.hra_deductible_paid_cents - dedReceived);
    const copayToClaim = Math.max(0, t.copay_reimb_cents - view.received_copay_cents);
    const legend = (got, todo, cap) =>
      `<div class="money-legend"><span><i class="dot got"></i>${money(got)} received</span><span><i class="dot todo"></i>${money(todo)} still to claim</span><span><i class="dot left"></i>${money(Math.max(0, cap - got - todo))} of ${money(cap)} unused</span></div>`;
    const band = `${money(t.threshold_cents)} and ${money(total2)}`;
    return `<div class="stat hra">
      <div class="hra-bars">
        <div class="money-row">
          <div class="money-head"><b>Deductible</b> <span class="muted small">${money(applied)} of ${money(total2)} paid so far · the HRA pays back 100% of what you pay between ${band}</span></div>
          <div class="band">
            <i class="band-hra" style="left:${pct(t.threshold_cents, total2)}%;width:${100 - pct(t.threshold_cents, total2)}%"></i>
            <i class="band-fill yours" style="width:${pct(Math.min(applied, t.threshold_cents), total2)}%"></i>
            <i class="band-fill got" style="left:${pct(t.threshold_cents, total2)}%;width:${pct(dedReceived, total2)}%"></i>
            <i class="band-fill todo" style="left:${pct(t.threshold_cents + dedReceived, total2)}%;width:${pct(dedToClaim, total2)}%"></i>
            <b class="band-tick" style="left:${pct(t.threshold_cents, total2)}%"></b>
          </div>
          <div class="band-labels"><span>$0</span><span style="left:${pct(t.threshold_cents, total2)}%">${money(t.threshold_cents)}</span><span class="end">${money(total2)}</span></div>
          ${legend(dedReceived, dedToClaim, t.cap_cents)}
        </div>
        <div class="money-row">
          <div class="money-head"><b>Copays</b> <span class="muted small">50% back, up to ${money(t.copay_cap_cents)} a year</span></div>
          <div class="stacked"><i class="seg got" style="width:${pct(view.received_copay_cents, t.copay_cap_cents)}%"></i><i class="seg todo" style="width:${pct(copayToClaim, t.copay_cap_cents)}%"></i></div>
          ${legend(view.received_copay_cents, copayToClaim, t.copay_cap_cents)}
        </div>
      </div>
    </div>`;
  }
  function renderCards() {
    const { view, app } = state;
    const t = view.totals;
    const rows = view.rows;
    const el = $('#cards');
    if (!app.setup_complete) {
      el.innerHTML = stat('Claims loaded', rows.length, 'Run Sync Summit so the plan is known and eligibility can be worked out');
      return;
    }
    let submitted = 0, paid = 0, toSubmit = 0;
    for (const r of rows) {
      for (const b of BENEFITS) {
        const s = r.submissions[b];
        if (s && s.status !== 'unconfirmed') { submitted += 1; if (['paid', 'approved'].includes(s.status)) paid += 1; }
        if (!s && r.eligibility[`submit_${b}`]) toSubmit += 1;
      }
    }
    el.innerHTML = hraCard(view, t);
  }

  function renderFilters() {
    const sel = $('#f-member');
    const cur = sel.value;
    sel.innerHTML = '<option value="">All</option>' + state.view.members.map((m) => `<option value="${m.id}">${esc(m.display_name)}</option>`).join('');
    sel.value = cur;
  }

  function eligPill(r) {
    const e = r.eligibility;
    const map = { qualifies: ['ok', 'Qualifies'], accumulates: ['accent', 'Submit (accumulates)'], needs_review: ['warn', 'Needs review'], not_eligible: ['', 'Not eligible'], setup_required: ['warn', 'Plan not known yet'] };
    const [cls, label] = map[e.status] || ['', e.status];
    const ov = r.user_override_qualifies != null ? ' (override)' : '';
    return `<span class="pill ${cls}">${label}${ov}</span><div class="reasons">${esc(e.reasons.join(' · '))}${r.user_note ? ' · ' + esc(r.user_note) : ''}</div>`;
  }

  const STATUS_CLASS = { unconfirmed: 'warn', submitted: 'accent', pending: 'accent', approved: 'ok', paid: 'ok', denied: 'bad', unknown: '' };
  const SUB_RANK = { paid: 6, approved: 5, pending: 4, submitted: 3, unknown: 2, denied: 1, unconfirmed: 0 };

  /** One word for the whole claim: a submission state once anything has been filed, else the eligibility. */
  function rowStatus(r) {
    const subs = BENEFITS.map((b) => r.submissions[b]).filter(Boolean);
    const open = BENEFITS.filter((b) => !r.submissions[b] && r.eligibility[`submit_${b}`]);
    if (subs.length) {
      const top = subs.slice().sort((a, b) => (SUB_RANK[b.status] ?? 0) - (SUB_RANK[a.status] ?? 0))[0];
      return { kind: 'submission', status: top.status, partial: open.length > 0 };
    }
    return { kind: 'eligibility', status: r.eligibility.status, partial: false };
  }

  function statusCell(r) {
    const st = rowStatus(r);
    const e = r.eligibility;
    const lines = [];
    if (st.kind === 'submission') {
      const label = { unconfirmed: 'Unconfirmed', submitted: 'Submitted', pending: 'Pending', approved: 'Approved', paid: 'Paid', denied: 'Denied', unknown: 'Submitted' }[st.status] || st.status;
      lines.push(`<span class="pill ${STATUS_CLASS[st.status] || ''}">${label}</span>`);
      for (const b of BENEFITS) {
        const sub = r.submissions[b];
        if (!sub) continue;
        const bits = [];
        if (['approved', 'paid'].includes(sub.status)) {
          const expected = b === 'deductible' ? e.deductible_reimb_cents : e.copay_reimb_cents;
          const payout = b === 'copay' ? Math.round((sub.approved_cents ?? sub.amount_cents) / 2) : expected;
          bits.push(`approved ${money(sub.approved_cents ?? sub.amount_cents)}, paid ${money(payout)}${sub.payment_method ? ' by ' + esc(sub.payment_method) : ''}`);
        } else {
          bits.push(`${esc(sub.status)} ${money(sub.amount_cents)}`);
        }
        if (sub.submitted_at) bits.push(usDate(sub.submitted_at.slice(0, 10)));
        if (sub.summit_claim_id) bits.push(`Summit #${esc(sub.summit_claim_id)}`);
        lines.push(`<div class="reasons"><b>${BENEFIT_NAME[b]}:</b> ${bits.join(' · ')}</div>`);
      }
      if (st.partial) lines.push(`<div class="reasons">Still to submit: ${BENEFITS.filter((b) => !r.submissions[b] && e[`submit_${b}`]).map((b) => BENEFIT_NAME[b].toLowerCase()).join(', ')}</div>`);
      if (r.changed_after_submission) lines.push('<div class="reasons" style="color:var(--warn)">IBX changed this claim after it was submitted</div>');
      return lines.join('');
    }
    return eligPill(r);
  }

  /** One line per benefit: amount on the EOB, expected payout, and either the submission status or a Prefill button. */
  function benefitCell(r) {
    const parts = [];
    for (const b of BENEFITS) {
      const amount = b === 'deductible' ? r.deductible_cents : r.copay_cents;
      if (amount <= 0) continue;
      const s = r.submissions[b];
      const expected = b === 'deductible' ? r.eligibility.deductible_reimb_cents : r.eligibility.copay_reimb_cents;
      let right;
      if (s && s.status === 'unconfirmed') {
        right = `<button class="small primary" data-act="confirm" data-id="${s.id}" data-outcome="submitted">I submitted it</button> <button class="small" data-act="confirm" data-id="${s.id}" data-outcome="cancelled">I cancelled</button>`;
      } else if (s) {
        right = `<button class="small ghost advanced" data-act="prefill" data-claim="${esc(r.claim_number)}" data-benefit="${b}" data-force="1" title="Prefill ${b} again">↻ ${b}</button>`;
      } else {
        const can = r.eligibility[`submit_${b}`] && r.has_pdf && state.app.credentials.summit;
        const why = !r.has_pdf ? 'No claim document yet' : !state.app.credentials.summit ? 'Enter your Summit login first' : r.eligibility.status === 'setup_required' ? 'Plan not known yet' : 'Not eligible';
        right = `<button class="small primary" data-act="prefill" data-claim="${esc(r.claim_number)}" data-benefit="${b}" ${can ? '' : `disabled title="${why}"`}>Prefill ${b}</button> <button class="small ghost advanced" data-act="mark" data-claim="${esc(r.claim_number)}" data-benefit="${b}" title="Already submitted by hand">mark</button>`;
      }
      parts.push(`<div class="benefit-line">${right}</div>`);
    }
    return parts.join('') || '<span class="muted small">—</span>';
  }

  function filteredRows() {
    const f = state.filters;
    const text = (f.text || '').toLowerCase();
    return state.view.rows.filter((r) => {
      if (f.member && String(r.member_id) !== f.member) return false;
      if (f.network && r.network_status !== f.network) return false;
      if (f.status) {
        const st = rowStatus(r);
        const open = BENEFITS.some((b) => !r.submissions[b] && r.eligibility[`submit_${b}`]);
        const subs = BENEFITS.map((b) => r.submissions[b]).filter(Boolean);
        if (f.status === 'todo' && !open) return false;
        if (['qualifies', 'accumulates', 'needs_review', 'not_eligible'].includes(f.status) && !(st.kind === 'eligibility' && st.status === f.status)) return false;
        if (f.status === 'unconfirmed' && !subs.some((x) => x.status === 'unconfirmed')) return false;
        if (f.status === 'submitted' && !subs.some((x) => ['submitted', 'pending', 'unknown'].includes(x.status))) return false;
        if (f.status === 'paid' && !subs.some((x) => ['paid', 'approved'].includes(x.status))) return false;
      }
      if (text && !`${r.provider_name} ${r.claim_number} ${r.member_name}`.toLowerCase().includes(text)) return false;
      return true;
    });
  }
  function sortKeyValue(r, key) {
    if (key === 'status') { const st = rowStatus(r); return `${st.kind === 'submission' ? '1' : '0'}-${st.status}`; }
    if (key === 'expected_cents') return r.eligibility.expected_cents;
    if (key === 'sub_status') return BENEFITS.map((b) => (r.submissions[b] ? r.submissions[b].status : '')).join(',');
    return r[key] ?? '';
  }
  function renderTable() {
    const rows = filteredRows();
    const { key, desc } = state.sort;
    rows.sort((a, b) => {
      const x = sortKeyValue(a, key), y = sortKeyValue(b, key);
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return desc ? -c : c;
    });
    $$('#claims th[data-sort]').forEach((th) => { th.classList.toggle('active', th.dataset.sort === key); th.classList.toggle('desc', th.dataset.sort === key && desc); });
    $('#claims tbody').innerHTML = rows.map((r) => `
      <tr class="${r.changed_after_submission ? 'changed' : ''}">
        <td>${esc(r.member_name)}<div class="reasons">${esc(r.relationship)}</div></td>
        <td>${usDate(r.service_start)}${r.service_end !== r.service_start ? '<br>– ' + usDate(r.service_end) : ''}<div class="reasons">#${esc(r.claim_number)}</div></td>
        <td>${esc(r.provider_name || '')}<div class="reasons">${esc(r.claim_type)} · IBX: ${esc(r.claim_status)}</div></td>
        <td class="num">${money(r.billed_cents)}</td>
        <td class="num">${money(r.allowed_cents)}</td>
        <td class="num"><b>${money(r.deductible_cents)}</b></td>
        <td class="num">${money(r.copay_cents)}</td>
        <td class="num">${money(r.coinsurance_cents)}</td>
        <td class="num">${money(r.patient_resp_cents)}</td>
        <td><span class="pill ${r.network_status === 'in' ? 'ok' : r.network_status === 'out' ? 'bad' : 'warn'}">${r.network_status === 'in' ? 'In' : r.network_status === 'out' ? 'Out' : '?'}</span></td>
        <td>${statusCell(r)}</td>
        <td class="num"><b>${money(r.eligibility.expected_cents)}</b></td>
        <td class="benefits">${benefitCell(r)}</td>
        <td><div class="row-actions">${r.has_pdf ? `<a class="btn small eob" href="/api/eobs/${encodeURIComponent(r.claim_number)}/pdf" target="_blank">${r.claim_type === 'rx' ? 'View proof' : 'View EOB'}</a>` : ''}<button class="small ghost advanced" data-act="override" data-claim="${esc(r.claim_number)}">Override</button></div></td>
      </tr>`).join('');
    $('#row-count').textContent = `${rows.length} of ${state.view.rows.length} claims`;
    const todo = state.view.rows.filter((r) => BENEFITS.some((b) => !r.submissions[b] && r.eligibility[`submit_${b}`])).length;
    const tb = $('#btn-todo');
    tb.textContent = `Show the ${todo} claim${todo === 1 ? '' : 's'} to submit`;
    tb.classList.toggle('hidden', todo === 0 || state.filters.status === 'todo');
  }

  async function renderActivity() {
    const sec = $('#activity-section');
    if (!state.view.unmatched_activity) { sec.classList.add('hidden'); return; }
    const rows = (await api('/api/summit-activity')).filter((a) => !a.matched_claim_number);
    sec.classList.remove('hidden');
    const opts = state.view.rows.map((r) => `<option value="${esc(r.claim_number)}">${esc(r.member_name)} · ${usDate(r.service_start)} · ${esc(r.provider_name || '')} · ded ${money(r.deductible_cents)} / copay ${money(r.copay_cents)}</option>`).join('');
    $('#activity tbody').innerHTML = rows.map((a) => {
      let raw = {}; try { raw = JSON.parse(a.raw_json); } catch {}
      return `<tr>
      <td>${esc(a.summit_claim_id || '')}<div class="reasons">${esc(raw['Service Category'] || '')}</div></td><td>${esc(a.claimant_label || '')}</td><td>${usDate(a.service_date)}</td>
      <td class="num">${money(a.amount_cents)}</td><td>${esc(a.status || '')}</td>
      <td><select data-link="${a.id}"><option value="">— choose claim —</option>${opts}</select></td></tr>`;
    }).join('');
  }

  function renderJobs() {
    $('#jobs tbody').innerHTML = state.jobs.length
      ? state.jobs.slice(0, 12).map((j) => `<tr><td>${j.id}</td><td>${esc(j.kind)}</td><td><span class="pill ${j.status === 'succeeded' ? 'ok' : j.status === 'failed' ? 'bad' : j.status === 'waiting_for_user' ? 'warn' : 'accent'}">${esc(j.status)}</span></td>
        <td>${j.started_at ? new Date(j.started_at).toLocaleString() : ''}</td>
        <td>${esc(j.error_message || j.message || '')}${j.screenshot_path ? ` <a href="/api/jobs/${j.id}/screenshot" target="_blank">screenshot</a>` : ''}</td></tr>`).join('')
      : '<tr><td colspan="5" class="muted">Nothing has run yet.</td></tr>';
    const live = state.jobs.find((j) => ['queued', 'running', 'waiting_for_user'].includes(j.status)) || state.jobs[0];
    renderJobPanel(live);
    renderJobModal();
    const pill = $('#job-pill');
    const active = live && ['queued', 'running', 'waiting_for_user'].includes(live.status);
    pill.classList.toggle('hidden', !active);
    if (active) {
      pill.textContent = live.status === 'waiting_for_user' ? 'Your turn in the browser window' : 'Job running…';
      pill.className = `pill ${live.status === 'waiting_for_user' ? 'warn' : 'accent'}`;
    }
  }
  const JOB_NAMES = { fetch_eobs: 'Fetching claims from IBX', sync_summit: 'Syncing Summit submissions', prefill: 'Prefilling a claim in Summit', noop: 'Test job' };
  const statusClass = (st) => (st === 'succeeded' ? 'ok' : st === 'failed' ? 'bad' : st === 'waiting_for_user' ? 'warn' : 'accent');

  /** The popup follows one job (state.jobModalId) from start to finish. */
  function renderJobModal() {
    const m = $('#jobmodal');
    const j = state.jobs.find((x) => x.id === state.jobModalId);
    if (!j) { m.classList.add('hidden'); return; }
    m.classList.remove('hidden');
    const done = ['succeeded', 'failed'].includes(j.status);
    $('#jm-title').textContent = JOB_NAMES[j.kind] || j.kind;
    const st = $('#jm-status');
    st.textContent = j.status.replace('_', ' ');
    st.className = `pill ${statusClass(j.status)}`;
    const msg = $('#jm-message');
    msg.textContent = j.status === 'waiting_for_user' ? `Your turn: ${j.message}` : j.status === 'succeeded' ? (j.message || 'Done') : j.status === 'running' ? 'Working… you can watch the browser window.' : '';
    msg.classList.toggle('hidden', !msg.textContent);
    const p = j.progress_json ? JSON.parse(j.progress_json) : null;
    $('#jm-progress').textContent = p ? Object.entries(p).map(([k, v]) => `${k}: ${v}`).join(' · ') : '';
    const err = $('#jm-error');
    err.innerHTML = j.error_message ? `${esc(j.error_message)}${j.screenshot_path ? ` — <a href="/api/jobs/${j.id}/screenshot" target="_blank">view screenshot</a>` : ''}` : '';
    err.classList.toggle('hidden', !j.error_message);
    const log = $('#jm-log');
    log.textContent = j.log || '';
    log.scrollTop = log.scrollHeight;
    $('#jm-cancel').classList.toggle('hidden', done);
    $('#jm-close').classList.toggle('hidden', !done);
    $('#jm-cancel').onclick = async () => { try { await api(`/api/jobs/${j.id}/cancel`, { method: 'POST' }); } catch (e) { toast(e.message, true); } };
  }
  function showJobModal(id) {
    state.jobModalId = id;
    renderJobModal();
  }

  function renderJobPanel(j) {
    const panel = $('#job-panel');
    if (!j) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    $('#job-title').textContent = `Job #${j.id}: ${JOB_NAMES[j.kind] || j.kind}`;
    const st = $('#job-status');
    st.textContent = j.status.replace('_', ' ');
    st.className = `pill ${j.status === 'succeeded' ? 'ok' : j.status === 'failed' ? 'bad' : j.status === 'waiting_for_user' ? 'warn' : 'accent'}`;
    const msg = $('#job-message');
    msg.textContent = j.status === 'waiting_for_user' ? `Your turn: ${j.message}` : (j.status === 'succeeded' && j.message) ? j.message : '';
    msg.classList.toggle('hidden', !msg.textContent);
    const p = j.progress_json ? JSON.parse(j.progress_json) : null;
    $('#job-progress').textContent = p ? Object.entries(p).map(([k, v]) => `${k}: ${v}`).join(' · ') : '';
    const err = $('#job-error');
    err.innerHTML = j.error_message ? `${esc(j.error_message)}${j.screenshot_path ? ` — <a href="/api/jobs/${j.id}/screenshot" target="_blank">view screenshot</a>` : ''}` : '';
    err.classList.toggle('hidden', !j.error_message);
    const log = $('#job-log');
    log.textContent = j.log || '';
    log.scrollTop = log.scrollHeight;
    const cancel = $('#job-cancel');
    cancel.classList.toggle('hidden', !['queued', 'running', 'waiting_for_user'].includes(j.status));
    cancel.onclick = async () => { try { await api(`/api/jobs/${j.id}/cancel`, { method: 'POST' }); toast('Cancelling…'); } catch (e) { toast(e.message, true); } };
  }

  // ---------- setup tab (every control saves itself on change) ----------
  function renderSetup() {
    const { app } = state;
    const s = app.settings;
    if (document.activeElement !== $('#c-ibx-user')) $('#c-ibx-user').value = app.credentials.ibxUser || '';
    if (document.activeElement !== $('#c-sum-user')) $('#c-sum-user').value = app.credentials.summitUser || '';
    credStatus('ibx', app.credentials.ibx);
    credStatus('summit', app.credentials.summit);
    $('#data-dir').textContent = app.data_dir;
    $('#link-ibx').href = s.ibx_member_url;
    $('#link-summit').href = s.summit_base_url.replace(/\/+$/, '') + '/login';

    // Plan: only once something has been detected (or set by hand).
    const planObj = app.plans.find((p) => p.key === s.plan_option);
    const known = Boolean(planObj || s.coverage_tier);
    $('#plan-card').classList.toggle('hidden', !known);
    if (known) {
      $('#plan-options').innerHTML = app.plans.map((p) => `<label><input type="radio" name="plan" value="${p.key}" ${s.plan_option === p.key ? 'checked' : ''}/> ${esc(p.label)}</label>`).join('');
      $$('input[name="tier"]').forEach((r) => (r.checked = r.value === s.coverage_tier));
      $('#s-year').value = s.plan_year;
      const tierText = s.coverage_tier === 'family' ? 'employee + family' : s.coverage_tier === 'single' ? 'employee only' : 'tier not detected yet (run Fetch claims)';
      const source = { summit: 'detected from Summit', ibx: 'detected from IBX', manual: 'set by you' }[s.plan_source] || '';
      $('#plan-summary').innerHTML = `<b>${esc(planObj ? planObj.label : 'plan not detected yet (run Sync Summit)')}</b> · ${esc(tierText)} · ${s.plan_year} <span class="muted small">${esc(source)}</span>`;
      $('#plan-manual').classList.toggle('hidden', !state.showPlanManual);
      const r = planObj && s.coverage_tier ? planObj.rules[s.coverage_tier] : null;
      $('#plan-explainer').textContent = r ? `IBX in-network deductible ${money(r.ibxDeductible)}. You pay the first ${money(r.threshold)}; the HRA then reimburses 100% of the next ${money(r.cap)}. Copays: 50% back, up to $500 a year.` : '';
    }

    // Members: only once both portals have been read.
    const claimants = s.summit_claimants || [];
    const showMembers = app.members.length > 0 && claimants.length > 0;
    $('#members-card').classList.toggle('hidden', !showMembers);
    if (showMembers) {
      const claimantControl = (m) => `<select class="m-label"><option value="">— not paired —</option>${claimants.map((c) => `<option value="${esc(c.value)}" ${m.summit_claimant_label === c.value ? 'selected' : ''}>${esc(c.label)} (${esc(c.value)})</option>`).join('')}</select>`;
      $('#members tbody').innerHTML = app.members.map((m) => `<tr data-member="${m.id}"><td>${esc(m.display_name)}</td><td>${esc(m.relationship)}</td><td>${claimantControl(m)}</td></tr>`).join('');
    }
  }
  function credStatus(portal, saved, text) {
    const el = $(portal === 'ibx' ? '#c-ibx-status' : '#c-sum-status');
    el.textContent = text || (saved ? 'saved' : 'not saved');
    el.className = `pill ${saved ? 'ok' : 'warn'}`;
  }
  async function saveSetting(patch) {
    try {
      state.app.settings = await api('/api/settings', { method: 'PUT', body: patch });
      renderHeader();
      renderSetup();
      await reloadClaims();
    } catch (e) { toast(e.message, true); }
  }
  async function saveCredential(portal) {
    const user = $(portal === 'ibx' ? '#c-ibx-user' : '#c-sum-user').value.trim();
    const passEl = $(portal === 'ibx' ? '#c-ibx-pass' : '#c-sum-pass');
    if (!user) return;
    if (!passEl.value && !state.app.credentials[portal]) return; // need a password the first time
    try {
      credStatus(portal, false, 'saving…');
      state.app.credentials = await api(`/api/credentials/${portal}`, { method: 'PUT', body: { username: user, password: passEl.value } });
      passEl.value = '';
      renderHeader();
      renderSetup();
      renderTable();
    } catch (e) { toast(e.message, true); credStatus(portal, false, 'error'); }
  }

  // ---------- actions ----------
  async function startJob(path) {
    try {
      const job = await api(path, { method: 'POST' });
      state.jobs.unshift(job);
      showJobModal(job.id);
    } catch (e) { toast(e.message, true); }
  }

  async function openPrefill(claimNumber, benefit, force) {
    try {
      const job = await api(`/api/claims/${encodeURIComponent(claimNumber)}/prefill`, { method: 'POST', body: { benefit, force: !!force } });
      state.jobs.unshift(job);
      showJobModal(job.id);
    } catch (e) { toast(e.message, true); }
  }

  function openOverride(claimNumber) {
    const r = state.view.rows.find((x) => x.claim_number === claimNumber);
    $('#override-claim').textContent = `${r.member_name} · ${usDate(r.service_start)} · ${r.provider_name || ''} · claim #${claimNumber}`;
    const v = r.user_override_qualifies == null ? 'auto' : r.user_override_qualifies ? 'yes' : 'no';
    $$('input[name="ov"]').forEach((i) => (i.checked = i.value === v));
    $('#override-note').value = r.user_note || '';
    $('#override').classList.remove('hidden');
    $('#override-save').onclick = async () => {
      const val = $('input[name="ov"]:checked').value;
      await api(`/api/claims/${encodeURIComponent(claimNumber)}/override`, { method: 'PUT', body: { qualifies: val === 'auto' ? null : val === 'yes', note: $('#override-note').value || null } });
      $('#override').classList.add('hidden');
      await reloadClaims();
    };
  }

  function exportCsv() {
    const rows = filteredRows();
    const head = ['member', 'relationship', 'claim_number', 'service_start', 'service_end', 'provider', 'claim_type', 'network', 'ibx_status', 'billed', 'allowed', 'deductible', 'copay', 'coinsurance', 'patient_resp', 'status', 'reasons', 'expected_hra', 'deductible_submission', 'deductible_summit_id', 'copay_submission', 'copay_summit_id'];
    const line = (r) => [r.member_name, r.relationship, r.claim_number, r.service_start, r.service_end, r.provider_name, r.claim_type, r.network_status, r.claim_status,
      r.billed_cents / 100, r.allowed_cents / 100, r.deductible_cents / 100, r.copay_cents / 100, r.coinsurance_cents / 100, r.patient_resp_cents / 100,
      rowStatus(r).status, r.eligibility.reasons.join('; '), r.eligibility.expected_cents / 100,
      r.submissions.deductible?.status || '', r.submissions.deductible?.summit_claim_id || '', r.submissions.copay?.status || '', r.submissions.copay?.summit_claim_id || '']
      .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',');
    const csv = [head.join(','), ...rows.map(line)].join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `hra-claims-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  }

  // ---------- events ----------
  function wire() {
    $('#tabs').addEventListener('click', (e) => {
      const t = e.target.closest('.tab');
      if (!t || t.disabled) return;
      state.tab = t.dataset.tab;
      renderTabs();
    });
    $('#btn-fetch-2').onclick = () => startJob('/api/jobs/fetch');
    $('#btn-sync-2').onclick = () => startJob('/api/jobs/sync-summit');
    $('#job-pill').onclick = () => { const live = state.jobs.find((j) => ['queued', 'running', 'waiting_for_user'].includes(j.status)); if (live) showJobModal(live.id); else { state.tab = 'logs'; renderTabs(); } };
    $('#jm-close').onclick = () => { state.jobModalId = null; renderJobModal(); };
    $('#btn-export-logs').onclick = () => { window.location.href = '/api/logs/export'; };
    $('#override-cancel').onclick = () => $('#override').classList.add('hidden');
    $('#btn-csv').onclick = exportCsv;
    const adv = $('#advanced-ui');
    let advOn = false;
    try { advOn = localStorage.getItem('hra.advanced') === '1'; } catch {}
    adv.checked = advOn;
    document.body.classList.toggle('advanced', advOn);
    adv.addEventListener('change', () => {
      document.body.classList.toggle('advanced', adv.checked);
      try { localStorage.setItem('hra.advanced', adv.checked ? '1' : '0'); } catch {}
    });
    $('#job-toggle').onclick = (e) => { const l = $('#job-log'); l.classList.toggle('hidden'); e.target.textContent = l.classList.contains('hidden') ? 'Show log' : 'Hide log'; };
    for (const [id, key] of [['#f-member', 'member'], ['#f-status', 'status'], ['#f-text', 'text'], ['#f-network', 'network']]) {
      $(id).addEventListener('input', (e) => { state.filters[key] = e.target.value; renderTable(); });
    }
    $$('#claims th[data-sort]').forEach((th) => th.onclick = () => {
      const k = th.dataset.sort;
      state.sort = { key: k, desc: state.sort.key === k ? !state.sort.desc : k.endsWith('_cents') || k === 'service_start' };
      renderTable();
    });

    // setup tab
    $('#plan-change').onclick = () => { state.showPlanManual = !state.showPlanManual; $('#plan-manual').classList.toggle('hidden', !state.showPlanManual); };
    $('#plan-options').addEventListener('change', () => saveSetting({ plan_option: $('input[name="plan"]:checked')?.value ?? null, plan_source: 'manual' }));
    $('#tier-options').addEventListener('change', () => saveSetting({ coverage_tier: $('input[name="tier"]:checked')?.value ?? null, plan_source: 'manual' }));
    $('#s-year').addEventListener('change', (e) => saveSetting({ plan_year: Number(e.target.value) }));
    for (const id of ['#c-ibx-user', '#c-ibx-pass']) $(id).addEventListener('change', () => saveCredential('ibx'));
    for (const id of ['#c-sum-user', '#c-sum-pass']) $(id).addEventListener('change', () => saveCredential('summit'));

    // reset
    $('#btn-reset').onclick = () => { $('#reset-confirm').value = ''; $('#reset-go').disabled = true; $('#reset').classList.remove('hidden'); $('#reset-confirm').focus(); };
    $('#reset-cancel').onclick = () => $('#reset').classList.add('hidden');
    $('#reset-confirm').addEventListener('input', (e) => { $('#reset-go').disabled = e.target.value.trim() !== 'DELETE'; });
    $('#reset-go').onclick = async () => {
      try {
        await api('/api/reset', { method: 'POST', body: { confirm: 'DELETE' } });
        $('#reset').classList.add('hidden');
        state.tab = 'setup';
        state.showPlanManual = false;
        toast('Everything was deleted. Starting fresh.');
        await loadAll();
      } catch (e) { toast(e.message, true); }
    };

    document.body.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      try {
        if (act === 'prefill') await openPrefill(b.dataset.claim, b.dataset.benefit, b.dataset.force === '1');
        else if (act === 'show-todo') { $('#f-status').value = 'todo'; state.filters.status = 'todo'; renderTable(); $('#claims').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
        else if (act === 'override') openOverride(b.dataset.claim);
        else if (act === 'confirm') {
          const summit_claim_id = b.dataset.outcome === 'submitted' ? (prompt('Summit claim number (optional):') || undefined) : undefined;
          await api(`/api/submissions/${b.dataset.id}/confirm`, { method: 'POST', body: { outcome: b.dataset.outcome, summit_claim_id } });
          await reloadClaims();
        } else if (act === 'mark') {
          const id = prompt(`Mark the ${b.dataset.benefit} for this claim as already submitted. Summit claim number (optional):`);
          if (id === null) return;
          await api(`/api/claims/${encodeURIComponent(b.dataset.claim)}/mark-submitted`, { method: 'POST', body: { benefit: b.dataset.benefit, summit_claim_id: id || undefined } });
          await reloadClaims();
        }
      } catch (err) { toast(err.message, true); }
    });
    document.body.addEventListener('change', async (e) => {
      const link = e.target.closest('select[data-link]');
      if (link && link.value) {
        try { await api(`/api/summit-activity/${link.dataset.link}/link`, { method: 'POST', body: { claim_number: link.value } }); toast('Linked'); await reloadClaims(); } catch (err) { toast(err.message, true); }
        return;
      }
      const pair = e.target.closest('#members select.m-label');
      if (pair) {
        const tr = pair.closest('tr');
        try { state.app.members = await api(`/api/members/${tr.dataset.member}`, { method: 'PUT', body: { summit_claimant_label: pair.value || null } }); toast('Pairing saved'); } catch (err) { toast(err.message, true); }
      }
    });
  }

  function connectEvents() {
    const es = new EventSource('/api/events');
    es.onmessage = (ev) => {
      const data = JSON.parse(ev.data);
      if (data.type === 'hello') {
        state.jobs = data.jobs;
        const live = state.jobs.find((j) => ['queued', 'running', 'waiting_for_user'].includes(j.status));
        if (live && state.jobModalId === null) state.jobModalId = live.id;
        renderJobs();
        return;
      }
      if (data.type === 'job') {
        const i = state.jobs.findIndex((j) => j.id === data.job.id);
        if (i >= 0) state.jobs[i] = data.job; else state.jobs.unshift(data.job);
        renderJobs();
        if (['succeeded', 'failed'].includes(data.job.status)) { reloadState(); reloadClaims(); }
        else { state.app.busy = true; renderHeader(); }
      }
    };
    es.onerror = () => setTimeout(() => { if (es.readyState === EventSource.CLOSED) connectEvents(); }, 3000);
    state.es = es;
  }

  wire();
  loadAll().then(connectEvents).catch((e) => toast(e.message, true));
})();
