// Dashboard client: plain fetch + DOM, no build step. Talks to the same HTTP
// API documented in the README.

const $ = (sel) => document.querySelector(sel);

let refreshTimer = null;

// ---------- helpers ----------

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function chip(value) {
  return el('span', `chip chip-${value}`, value.replace('_', ' '));
}

let toastTimer = null;
function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.add('hidden'), 2600);
}

async function withButton(button, fn) {
  button.disabled = true;
  try {
    await fn();
  } catch (error) {
    toast(`Error: ${error.message}`);
  } finally {
    button.disabled = false;
    await loadAll();
  }
}

// ---------- rendering ----------

function renderStats({ items, lowStock, jobs, runs }) {
  const totalUnits = items.reduce((sum, i) => sum + (i.available_units ?? 0), 0);
  const pending = jobs.filter((j) => j.status === 'pending').length;
  const dead = jobs.filter((j) => j.status === 'dead_letter').length;
  const lastRun = runs[0];
  const lastRunLabel = lastRun
    ? lastRun.mismatch_count + lastRun.chain_violation_count > 0
      ? 'drift found'
      : 'consistent'
    : '—';

  const stats = [
    { label: 'SKUs tracked', value: items.length },
    { label: 'Units on hand', value: totalUnits },
    { label: 'Low stock', value: lowStock.length, cls: lowStock.length ? 'alert' : '' },
    { label: 'Pending pushes', value: pending },
    { label: 'Dead-letter', value: dead, cls: dead ? 'alert' : 'good' },
    {
      label: 'Last reconcile',
      value: lastRunLabel,
      cls: lastRun && lastRunLabel !== 'consistent' ? 'alert' : lastRun ? 'good' : ''
    }
  ];

  const root = $('#stats');
  root.replaceChildren(
    ...stats.map(({ label, value, cls }) => {
      const card = el('div', `stat ${cls || ''}`);
      card.append(el('div', 'label', label), el('div', 'value', String(value)));
      return card;
    })
  );
}

function renderInventory(items, lowStock) {
  const lowSet = new Set(lowStock.map((i) => i.internal_sku));
  const tbody = $('#inventory-table tbody');
  tbody.replaceChildren(
    ...items.map((item) => {
      const tr = el('tr', lowSet.has(item.internal_sku) ? 'low-stock' : '');
      tr.append(
        el('td', 'sku', item.internal_sku),
        el('td', '', item.product_name || ''),
        (() => {
          const td = el('td');
          td.append(chip(item.tier));
          return td;
        })(),
        el('td', 'num', item.available_units ?? '—'),
        el('td', 'num', item.low_stock_threshold ?? '—')
      );
      return tr;
    })
  );
}

function renderJobs(jobs) {
  const tbody = $('#jobs-table tbody');
  tbody.replaceChildren(
    ...jobs.map((job) => {
      const tr = el('tr');
      const actionTd = el('td');
      if (job.status === 'dead_letter') {
        const btn = el('button', 'btn btn-small', 'Requeue');
        btn.addEventListener('click', () =>
          withButton(btn, async () => {
            await api(`/push-jobs/${job.id}/requeue`, { method: 'POST' });
            toast(`Job #${job.id} requeued with fresh attempts`);
          })
        );
        actionTd.append(btn);
      }
      const statusTd = el('td');
      statusTd.append(chip(job.status));
      if (job.last_error) statusTd.title = job.last_error;
      tr.append(
        el('td', 'num', String(job.id)),
        el('td', 'sku', job.internal_sku),
        el('td', '', job.platform),
        el('td', 'num', String(job.target_quantity)),
        statusTd,
        el('td', 'num', String(job.attempts)),
        actionTd
      );
      return tr;
    })
  );
}

function renderLedger(entries) {
  const tbody = $('#ledger-table tbody');
  tbody.replaceChildren(
    ...entries.map((entry) => {
      const tr = el('tr');
      const change = entry.change_units;
      tr.append(
        el('td', 'sku', entry.internal_sku),
        el('td', '', entry.reason),
        el('td', 'muted', entry.platform || '—'),
        el(
          'td',
          `num ${change < 0 ? 'delta-neg' : 'delta-pos'}`,
          change > 0 ? `+${change}` : String(change)
        ),
        el('td', 'num', `${entry.before_units ?? '∅'} → ${entry.after_units}`)
      );
      return tr;
    })
  );
}

function renderReconciliations(runs) {
  const tbody = $('#recon-table tbody');
  tbody.replaceChildren(
    ...runs.slice(0, 8).map((run) => {
      const dirty = run.mismatch_count + run.chain_violation_count > 0;
      const tr = el('tr');
      const resultTd = el('td');
      resultTd.append(chip(dirty ? 'drift' : 'clean'));
      tr.append(
        el('td', 'muted', run.created_at),
        el('td', 'num', String(run.checked_skus)),
        el('td', 'num', String(run.mismatch_count)),
        el('td', 'num', String(run.chain_violation_count)),
        resultTd
      );
      return tr;
    })
  );
}

function renderReconcileReport(report) {
  const root = $('#reconcile-report');
  root.className = `reconcile-report ${report.consistent ? 'clean' : 'dirty'}`;
  root.replaceChildren();
  root.append(
    el(
      'p',
      '',
      `Replayed ${report.checkedSkus} SKU(s) from the ledger — ` +
        (report.consistent ? 'ledger and live stock agree.' : 'inconsistencies found:')
    )
  );
  for (const m of report.mismatches) {
    root.append(
      el(
        'p',
        'delta-neg',
        `${m.internal_sku}: expected ${m.expected_units}, actual ${m.actual_units} (Δ ${m.delta})`
      )
    );
  }
  for (const v of report.chainViolations) {
    root.append(el('p', 'delta-neg', `${v.internal_sku} ledger #${v.ledger_id}: ${v.detail}`));
  }
}

// ---------- data loading ----------

async function loadAll() {
  const [inv, low, jobs, ledger, recon] = await Promise.all([
    api('/inventory'),
    api('/inventory/low-stock'),
    api('/push-jobs?limit=30'),
    api('/ledger?limit=30'),
    api('/reconciliations')
  ]);

  renderStats({ items: inv.items, lowStock: low.items, jobs: jobs.jobs, runs: recon.runs });
  renderInventory(inv.items, low.items);
  renderJobs(jobs.jobs);
  renderLedger(ledger.entries);
  renderReconciliations(recon.runs);
}

// ---------- wire up controls ----------

$('#btn-sync').addEventListener('click', (e) =>
  withButton(e.target, async () => {
    const data = await api('/sync/all', { method: 'POST' });
    const orders = [...(data.result.shopify.result || []), ...(data.result.etsy.result || [])];
    const processed = orders.filter((o) => o.status === 'processed').length;
    const duplicates = orders.filter((o) => o.status === 'duplicate').length;
    toast(`Sync done: ${processed} processed, ${duplicates} deduplicated`);
  })
);

$('#btn-process').addEventListener('click', (e) =>
  withButton(e.target, async () => {
    const data = await api('/push-jobs/process', { method: 'POST' });
    if (data.processed === 0) return toast('No push jobs due');
    const byOutcome = {};
    for (const r of data.results) byOutcome[r.outcome] = (byOutcome[r.outcome] || 0) + 1;
    toast(
      'Pushes: ' +
        Object.entries(byOutcome)
          .map(([k, n]) => `${n} ${k.replace('_', ' ')}`)
          .join(', ')
    );
  })
);

$('#btn-reconcile').addEventListener('click', (e) =>
  withButton(e.target, async () => {
    const data = await api('/reconcile', { method: 'POST' });
    renderReconcileReport(data.report);
    toast(data.report.consistent ? 'Reconciliation: consistent' : 'Reconciliation: drift found!');
  })
);

$('#outage-toggle').addEventListener('change', async (e) => {
  const on = e.target.checked;
  try {
    await api('/chaos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ failureRate: on ? 1 : 0 })
    });
    document.body.classList.toggle('outage', on);
    toast(on ? 'Outage on: every write-back now fails' : 'Outage off: platforms recovered');
  } catch (error) {
    e.target.checked = !on;
    toast(`Error: ${error.message}`);
  }
});

// ---------- boot ----------

loadAll().catch((error) => toast(`Error: ${error.message}`));
refreshTimer = setInterval(() => loadAll().catch(() => {}), 4000);
