import express from 'express';
import { config, type ImportSource } from './config.js';
import { initSchema, query } from './db.js';
import { importFmcsa, refreshScores } from './importer.js';
import { exportToArkon, exportToSheets, getTopLeads } from './export/webhooks.js';
import { publicScoringRules } from './leads/scoringRules.js';
import { checkSocrataDataset } from './fmcsa/socrata.js';
import { enrichFloridaCarriers } from './enrichment/florida.js';
import { enrichTexasCarriers } from './enrichment/texas.js';
import { getEnrichmentSources, ingestStateRegistryRecords } from './enrichment/service.js';
import type { StateRegistryRecordInput } from './enrichment/registryTypes.js';

const app = express();
app.use(express.json({ limit: '5mb' }));

const importSources: ImportSource[] = ['carrier-daily', 'carrier-all-history', 'company-census'];

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!config.adminApiKey) return next();
  const provided = req.header('x-admin-api-key') || req.query.adminApiKey;
  if (provided !== config.adminApiKey) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  return next();
}

function boolQuery(value: unknown): boolean {
  return ['true', '1', 'yes', 'y'].includes(String(value ?? '').trim().toLowerCase());
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}

function registryInputsFromBody(body: unknown): StateRegistryRecordInput[] {
  if (!body || typeof body !== 'object') return [];
  const payload = body as Record<string, unknown>;
  const stateCode = String(payload.stateCode ?? payload.state ?? '').trim().toUpperCase();
  const sourceName = String(payload.sourceName ?? payload.source ?? 'STATE_REGISTRY').trim();
  const recordsValue = Array.isArray(payload.records) ? payload.records : payload.record ? [payload.record] : [];

  return recordsValue
    .filter((record): record is Record<string, unknown> => Boolean(record && typeof record === 'object' && !Array.isArray(record)))
    .map((raw) => ({
      stateCode,
      sourceName,
      searchName: payload.searchName ? String(payload.searchName) : null,
      carrierId: payload.carrierId ? Number(payload.carrierId) : null,
      usdotNumber: payload.usdotNumber ? String(payload.usdotNumber) : null,
      legalName: payload.legalName ? String(payload.legalName) : null,
      raw
    }));
}

function adminPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Invicta Capital Group — Lead Engine Admin</title>
  <style>
    :root{
      --bg:#07111f;
      --panel:#0d1b2f;
      --panel2:#10233f;
      --border:rgba(148,163,184,.22);
      --text:#e5e7eb;
      --muted:#94a3b8;
      --accent:#38bdf8;
      --good:#34d399;
      --warn:#f59e0b;
      --bad:#fb7185;
      --shadow:0 22px 70px rgba(0,0,0,.4);
    }
    *{box-sizing:border-box}
    body{margin:0;font-family:Arial,Helvetica,sans-serif;background:radial-gradient(circle at top left,#12345a 0,#07111f 34%,#050914 100%);color:var(--text)}
    .wrap{max-width:1180px;margin:0 auto;padding:22px 16px 60px}
    .top{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:18px}
    .brand h1{margin:0;font-size:24px;letter-spacing:-.02em}.brand p{margin:6px 0 0;color:var(--muted);font-size:14px}
    .pill{border:1px solid var(--border);background:rgba(13,27,47,.75);border-radius:999px;padding:8px 12px;color:var(--muted);font-size:13px}
    .card{background:linear-gradient(180deg,rgba(13,27,47,.94),rgba(16,35,63,.92));border:1px solid var(--border);border-radius:18px;box-shadow:var(--shadow)}
    .login{max-width:520px;margin:60px auto;padding:24px}.login h2{margin:0 0 8px}.login p{color:var(--muted);line-height:1.5}
    input,select{width:100%;background:#07111f;border:1px solid var(--border);border-radius:12px;color:var(--text);padding:12px 13px;font-size:15px;outline:none}input:focus,select:focus{border-color:var(--accent)}
    button{border:0;border-radius:12px;background:var(--accent);color:#00111d;padding:11px 14px;font-weight:800;cursor:pointer}button.secondary{background:#1f3558;color:var(--text);border:1px solid var(--border)}button.danger{background:#7f1d1d;color:#fff}button:disabled{opacity:.55;cursor:not-allowed}
    .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:14px}.stat{padding:16px}.stat .label{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}.stat .value{font-size:30px;font-weight:900;margin-top:8px}
    .main{display:grid;grid-template-columns:340px 1fr;gap:14px}.panel{padding:16px}.panel h2{font-size:17px;margin:0 0 12px}.actions{display:grid;gap:10px}.row{display:grid;grid-template-columns:1fr 100px;gap:8px}.hint{font-size:12px;color:var(--muted);line-height:1.45;margin-top:6px}
    .lead{padding:16px;margin-bottom:12px}.leadTop{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.lead h3{margin:0;font-size:19px}.score{font-size:13px;border-radius:999px;padding:6px 9px;background:rgba(52,211,153,.14);color:var(--good);border:1px solid rgba(52,211,153,.35);white-space:nowrap}.meta{display:grid;grid-template-columns:repeat(2,1fr);gap:9px;margin-top:13px}.item{border:1px solid var(--border);border-radius:12px;padding:10px;background:rgba(7,17,31,.45)}.item b{display:block;font-size:12px;color:var(--muted);margin-bottom:4px}.item span{font-size:14px;word-break:break-word}.products{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px}.tag{font-size:12px;border:1px solid var(--border);background:#07111f;border-radius:999px;padding:6px 8px;color:#cbd5e1}.angle{margin-top:12px;color:#cbd5e1;line-height:1.45;font-size:14px}
    pre{white-space:pre-wrap;word-break:break-word;background:#04101f;border:1px solid var(--border);border-radius:14px;padding:12px;max-height:360px;overflow:auto;color:#cbd5e1}.hidden{display:none}.status{font-size:13px;color:var(--muted)}.ok{color:var(--good)}.bad{color:var(--bad)}
    @media(max-width:900px){.grid{grid-template-columns:repeat(2,1fr)}.main{grid-template-columns:1fr}.meta{grid-template-columns:1fr}.top{align-items:flex-start;flex-direction:column}}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div class="brand">
        <h1>Invicta Capital Group Lead Engine</h1>
        <p>FMCSA import, commercial P&C scoring, state enrichment, quality gate, and ARKON export control.</p>
      </div>
      <div class="pill" id="sessionPill">Admin session not started</div>
    </div>

    <section class="card login" id="loginCard">
      <h2>Admin Login</h2>
      <p>Enter the Railway admin API key. The key stays in this browser session and is sent as the <strong>x-admin-api-key</strong> header for admin actions.</p>
      <input id="adminKey" type="password" placeholder="Admin API key" autocomplete="current-password" />
      <div style="display:flex;gap:10px;margin-top:12px">
        <button id="loginBtn">Login</button>
        <button class="secondary" id="clearBtn" type="button">Clear</button>
      </div>
      <p class="status" id="loginStatus"></p>
    </section>

    <section id="dashboard" class="hidden">
      <div class="grid">
        <div class="card stat"><div class="label">Carriers</div><div class="value" id="statCarriers">—</div></div>
        <div class="card stat"><div class="label">Leads</div><div class="value" id="statLeads">—</div></div>
        <div class="card stat"><div class="label">Hot Leads</div><div class="value" id="statHot">—</div></div>
        <div class="card stat"><div class="label">Sales Ready</div><div class="value" id="statReady">—</div></div>
      </div>

      <div class="main">
        <div class="card panel">
          <h2>Admin Controls</h2>
          <div class="actions">
            <button class="secondary" id="refreshBtn">Refresh Dashboard</button>
            <button id="importBtn">Import FMCSA Census 1,000</button>
            <button id="scoreBtn">Refresh Scoring</button>
            <div class="row">
              <button id="txBtn">Enrich Texas</button>
              <select id="txLimit"><option>10</option><option>25</option><option>50</option></select>
            </div>
            <div class="row">
              <button id="flBtn">Enrich Florida</button>
              <select id="flLimit"><option>10</option><option>25</option><option>50</option></select>
            </div>
            <button id="arkonBtn">Test ARKON Export: 1 Lead</button>
            <button id="sheetsBtn" class="secondary">Export Sheets: 10 Leads</button>
            <button id="logoutBtn" class="danger">Logout</button>
          </div>
          <p class="hint">Exports are quality-gated. If ARKON or Sheets webhooks are not configured, the export will safely return skipped=true.</p>
          <h2 style="margin-top:18px">Last Action</h2>
          <pre id="output">Ready.</pre>
        </div>

        <div class="card panel">
          <h2>Sales-Ready Leads</h2>
          <div id="leads"></div>
        </div>
      </div>
    </section>
  </div>

  <script>
    const keyInput = document.getElementById('adminKey');
    const loginCard = document.getElementById('loginCard');
    const dashboard = document.getElementById('dashboard');
    const loginStatus = document.getElementById('loginStatus');
    const sessionPill = document.getElementById('sessionPill');
    const output = document.getElementById('output');
    const leadsEl = document.getElementById('leads');

    function adminKey(){ return sessionStorage.getItem('FMCSA_ADMIN_KEY') || ''; }
    function headers(){ return { 'content-type': 'application/json', 'x-admin-api-key': adminKey() }; }
    function setOutput(value){ output.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); }
    function fmt(value){ return value === null || value === undefined || value === '' ? 'N/A' : String(value); }

    async function api(path, options){
      const response = await fetch(path, options || {});
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch (_error) { data = { ok:false, raw:text }; }
      if (!response.ok) throw new Error(data.error || text || 'Request failed');
      return data;
    }

    async function adminPost(path, body){
      return api(path, { method:'POST', headers:headers(), body:JSON.stringify(body || {}) });
    }

    async function adminGet(path){
      return api(path, { headers:headers() });
    }

    function showDashboard(){
      loginCard.classList.add('hidden');
      dashboard.classList.remove('hidden');
      sessionPill.textContent = 'Admin session active';
      sessionPill.classList.add('ok');
    }

    function showLogin(){
      dashboard.classList.add('hidden');
      loginCard.classList.remove('hidden');
      sessionPill.textContent = 'Admin session not started';
      sessionPill.classList.remove('ok');
    }

    async function loadStats(){
      const data = await api('/stats');
      const stats = data.stats || {};
      document.getElementById('statCarriers').textContent = fmt(stats.carriers);
      document.getElementById('statLeads').textContent = fmt(stats.leads);
      document.getElementById('statHot').textContent = fmt(stats.hot_leads);
      document.getElementById('statReady').textContent = fmt(stats.sales_ready_leads);
    }

    function renderLeads(leads){
      if (!leads.length) {
        leadsEl.innerHTML = '<p class="status">No sales-ready leads yet. Run import, scoring, and enrichment.</p>';
        return;
      }
      leadsEl.innerHTML = leads.map(function(lead){
        const products = (lead.recommended_products || []).map(function(product){ return '<span class="tag">' + product + '</span>'; }).join('');
        return '<div class="lead card">'
          + '<div class="leadTop"><div><h3>' + fmt(lead.legal_name) + '</h3><div class="status">DBA: ' + fmt(lead.dba_name) + ' · USDOT ' + fmt(lead.usdot_number) + '</div></div><div class="score">Grade ' + fmt(lead.lead_grade) + ' · ' + fmt(lead.lead_score) + '</div></div>'
          + '<div class="meta">'
          + '<div class="item"><b>Operating Base</b><span>' + fmt(lead.hq_street) + '<br>' + fmt(lead.hq_city) + ', ' + fmt(lead.hq_state) + ' ' + fmt(lead.hq_zip) + '<br>Source: ' + fmt(lead.hq_source) + '</span></div>'
          + '<div class="item"><b>Fleet</b><span>' + fmt(lead.power_units) + ' power units<br>' + fmt(lead.drivers) + ' drivers</span></div>'
          + '<div class="item"><b>Contact</b><span>' + fmt(lead.phone) + '<br>' + fmt(lead.email) + '</span></div>'
          + '<div class="item"><b>Decision Maker</b><span>' + fmt(lead.decision_maker_name) + '<br>' + fmt(lead.decision_maker_title) + '</span></div>'
          + '</div>'
          + '<div class="products">' + products + '</div>'
          + '<div class="angle">' + fmt(lead.outreach_angle) + '</div>'
          + '<div class="hint ok">' + fmt(lead.sales_ready_reason) + '</div>'
          + '</div>';
      }).join('');
    }

    async function loadLeads(){
      const data = await api('/leads?limit=25&minGrade=B&qualityGate=true');
      renderLeads(data.leads || []);
    }

    async function refreshAll(){
      await loadStats();
      await loadLeads();
    }

    async function login(){
      const key = keyInput.value.trim();
      if (!key) { loginStatus.textContent = 'Enter the admin key.'; loginStatus.className = 'status bad'; return; }
      sessionStorage.setItem('FMCSA_ADMIN_KEY', key);
      try {
        await adminGet('/admin/enrichment/sources');
        loginStatus.textContent = '';
        showDashboard();
        await refreshAll();
      } catch (error) {
        sessionStorage.removeItem('FMCSA_ADMIN_KEY');
        loginStatus.textContent = error.message || 'Login failed.';
        loginStatus.className = 'status bad';
      }
    }

    async function run(label, fn){
      setOutput(label + '...');
      const buttons = Array.from(document.querySelectorAll('button'));
      buttons.forEach(function(button){ button.disabled = true; });
      try {
        const data = await fn();
        setOutput(data);
        await refreshAll();
      } catch (error) {
        setOutput({ ok:false, error:error.message || String(error) });
      } finally {
        buttons.forEach(function(button){ button.disabled = false; });
      }
    }

    document.getElementById('loginBtn').addEventListener('click', login);
    keyInput.addEventListener('keydown', function(event){ if (event.key === 'Enter') login(); });
    document.getElementById('clearBtn').addEventListener('click', function(){ keyInput.value=''; sessionStorage.removeItem('FMCSA_ADMIN_KEY'); });
    document.getElementById('logoutBtn').addEventListener('click', function(){ sessionStorage.removeItem('FMCSA_ADMIN_KEY'); showLogin(); });
    document.getElementById('refreshBtn').addEventListener('click', function(){ run('Refreshing dashboard', refreshAll); });
    document.getElementById('importBtn').addEventListener('click', function(){ run('Importing FMCSA census', function(){ return adminPost('/admin/import', { source:'company-census', limit:1000 }); }); });
    document.getElementById('scoreBtn').addEventListener('click', function(){ run('Refreshing scores', function(){ return adminPost('/admin/score/refresh', {}); }); });
    document.getElementById('txBtn').addEventListener('click', function(){ run('Enriching Texas leads', function(){ return adminPost('/admin/enrich/texas', { limit:Number(document.getElementById('txLimit').value) }); }); });
    document.getElementById('flBtn').addEventListener('click', function(){ run('Enriching Florida leads', function(){ return adminPost('/admin/enrich/fl', { limit:Number(document.getElementById('flLimit').value) }); }); });
    document.getElementById('arkonBtn').addEventListener('click', function(){ run('Testing ARKON export', function(){ return adminPost('/admin/export/arkon', { limit:1, minGrade:'B' }); }); });
    document.getElementById('sheetsBtn').addEventListener('click', function(){ run('Exporting to Sheets', function(){ return adminPost('/admin/export/sheets', { limit:10, minGrade:'B' }); }); });

    if (adminKey()) { showDashboard(); refreshAll().catch(function(error){ setOutput({ ok:false, error:error.message }); }); }
  </script>
</body>
</html>`;
}

app.get('/admin', (_req, res) => {
  res.type('html').send(adminPageHtml());
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'fmcsa-insurance-leads' });
});

app.get('/scoring/rules', (_req, res) => {
  res.json({ ok: true, scoring: publicScoringRules() });
});

app.get('/admin/datasets/check', requireAdmin, async (req, res, next) => {
  try {
    const requestedSource = req.query.source ? String(req.query.source) as ImportSource : undefined;
    const sources = requestedSource ? [requestedSource] : importSources;
    const invalid = sources.filter((source) => !importSources.includes(source));
    if (invalid.length) return res.status(400).json({ ok: false, error: `Invalid source: ${invalid.join(', ')}` });

    const results = await Promise.all(sources.map((source) => checkSocrataDataset(source)));
    res.json({ ok: true, results });
  } catch (error) {
    next(error);
  }
});

app.post('/admin/db/init', requireAdmin, async (_req, res, next) => {
  try {
    await initSchema();
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/admin/import', requireAdmin, async (req, res, next) => {
  try {
    const source = (req.body?.source ?? config.defaultImportSource) as ImportSource;
    const limit = Number.parseInt(String(req.body?.limit ?? config.importLimit), 10);
    const result = await importFmcsa(source, Number.isFinite(limit) ? limit : config.importLimit);
    res.json({ ok: true, result });
  } catch (error) {
    next(error);
  }
});

app.post('/admin/score/refresh', requireAdmin, async (_req, res, next) => {
  try {
    const result = await refreshScores();
    res.json({ ok: true, result });
  } catch (error) {
    next(error);
  }
});

app.get('/admin/enrichment/sources', requireAdmin, async (_req, res, next) => {
  try {
    const sources = await getEnrichmentSources();
    res.json({ ok: true, sources });
  } catch (error) {
    next(error);
  }
});

app.post('/admin/enrich/state-records', requireAdmin, async (req, res, next) => {
  try {
    const records = registryInputsFromBody(req.body);
    if (!records.length) {
      return res.status(400).json({ ok: false, error: 'Provide stateCode, sourceName, and record or records[].' });
    }
    const invalid = records.filter((record) => !record.stateCode || !record.sourceName);
    if (invalid.length) return res.status(400).json({ ok: false, error: 'stateCode and sourceName are required.' });

    const result = await ingestStateRegistryRecords(records);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/admin/enrich/texas', requireAdmin, async (req, res, next) => {
  try {
    const limit = Number.parseInt(String(req.body?.limit ?? config.texasEnrichmentLimit), 10);
    const result = await enrichTexasCarriers({
      limit: Number.isFinite(limit) ? limit : config.texasEnrichmentLimit,
      usdotNumbers: stringArray(req.body?.usdotNumbers ?? req.body?.usdotNumber),
      records: Array.isArray(req.body?.records) ? req.body.records : undefined
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/admin/enrich/fl', requireAdmin, async (req, res, next) => {
  try {
    const limit = Number.parseInt(String(req.body?.limit ?? 25), 10);
    const result = await enrichFloridaCarriers({
      limit: Number.isFinite(limit) ? limit : 25,
      usdotNumbers: stringArray(req.body?.usdotNumbers ?? req.body?.usdotNumber),
      records: Array.isArray(req.body?.records) ? req.body.records : undefined
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get('/leads', async (req, res, next) => {
  try {
    const limit = Math.min(500, Number.parseInt(String(req.query.limit ?? 100), 10) || 100);
    const minGrade = String(req.query.minGrade ?? 'B');
    const qualityGate = boolQuery(req.query.qualityGate);
    const leads = await getTopLeads(limit, minGrade, qualityGate);
    res.json({ ok: true, count: leads.length, qualityGate, leads });
  } catch (error) {
    next(error);
  }
});

app.post('/admin/export/arkon', requireAdmin, async (req, res, next) => {
  try {
    const result = await exportToArkon(Number(req.body?.limit ?? 100), String(req.body?.minGrade ?? 'B'));
    res.json({ ok: true, result });
  } catch (error) {
    next(error);
  }
});

app.post('/admin/export/sheets', requireAdmin, async (req, res, next) => {
  try {
    const result = await exportToSheets(Number(req.body?.limit ?? 100), String(req.body?.minGrade ?? 'B'));
    res.json({ ok: true, result });
  } catch (error) {
    next(error);
  }
});

app.get('/stats', async (_req, res, next) => {
  try {
    const result = await query(`
      select
        (select count(*)::int from fmcsa_carriers) as carriers,
        (select count(*)::int from insurance_leads) as leads,
        (select count(*)::int from insurance_leads where lead_grade in ('A+', 'A')) as hot_leads,
        (select count(*)::int from insurance_leads where sales_ready = true) as sales_ready_leads,
        (select max(started_at) from import_runs) as last_import_at
    `);
    res.json({ ok: true, stats: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(error);
  res.status(500).json({ ok: false, error: message });
});

app.listen(config.port, () => {
  console.log(`FMCSA insurance lead service listening on ${config.port}`);
});
