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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Invicta Admin</title><style>
  body{margin:0;background:#f5f7fb;color:#0f172a;font-family:Arial,Helvetica,sans-serif}.shell{display:grid;grid-template-columns:240px 1fr;min-height:100vh}.side{background:#0b1220;color:white;padding:22px}.side h1{font-size:17px;margin:0}.side p{color:#94a3b8;font-size:12px;line-height:1.5}.nav{margin-top:24px;display:grid;gap:8px}.nav div{padding:11px 12px;border-radius:12px;background:#111827;color:#cbd5e1}.nav .on{background:white;color:#0f172a;font-weight:800}.main{padding:26px;max-width:1200px}.top{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.top h2{font-size:30px;margin:0 0 6px}.top p{margin:0;color:#64748b}.pill,.card{background:white;border:1px solid #e2e8f0;border-radius:18px;box-shadow:0 18px 45px rgba(15,23,42,.08)}.pill{padding:9px 13px;font-size:13px;color:#64748b}.card{padding:18px}.login{max-width:520px;margin:64px auto}.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:18px 0}.num{font-size:31px;font-weight:900}.label{color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:.08em}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}.info{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.box{background:#f8fafc;border:1px solid #e2e8f0;border-radius:14px;padding:12px}.box b{display:block;color:#64748b;font-size:12px;margin-bottom:5px}.box span{font-weight:800}button{border:0;background:#2563eb;color:white;border-radius:12px;padding:11px 13px;font-weight:800;cursor:pointer}button.secondary{background:white;color:#0f172a;border:1px solid #e2e8f0}.actions{display:grid;gap:9px}.row{display:grid;grid-template-columns:1fr 84px;gap:8px}input,select{width:100%;padding:11px;border:1px solid #e2e8f0;border-radius:12px}.hidden{display:none}.ok{color:#16a34a}.bad{color:#dc2626}.muted{color:#64748b;font-size:13px}pre{background:#0b1220;color:#cbd5e1;border-radius:14px;padding:12px;max-height:330px;overflow:auto;white-space:pre-wrap}.table{width:100%;border-collapse:collapse}.table td,.table th{border-bottom:1px solid #e2e8f0;padding:10px;text-align:left;font-size:13px}@media(max-width:900px){.shell{grid-template-columns:1fr}.side{display:none}.grid4,.grid2,.info{grid-template-columns:1fr}.top{display:block}}
  </style></head><body><div class="shell"><aside class="side"><h1>Invicta Capital Group</h1><p>Administrator console</p><div class="nav"><div class="on">Admin Overview</div><div>Users & Roles</div><div>Agency Settings</div><div>Integrations</div><div>Data Jobs</div><div>Audit Output</div></div><p style="margin-top:24px">This page is for system administration, not agent lead work.</p></aside><main class="main"><div class="top"><div><h2>System Administration</h2><p>Signed-in admin, agency settings, integrations, database counts, and controlled jobs.</p></div><div class="pill" id="sessionPill">Not signed in</div></div><section class="card login" id="loginCard"><h2>Admin Login</h2><p class="muted">Enter the admin key to open the administrator console.</p><input id="adminKey" type="password" placeholder="Admin key"/><div style="display:flex;gap:10px;margin-top:12px"><button id="loginBtn">Open Admin Console</button><button class="secondary" id="clearBtn">Clear</button></div><p class="muted" id="loginStatus"></p></section><section id="dashboard" class="hidden"><div class="grid4"><div class="card"><div class="label">Carriers</div><div class="num" id="statCarriers">—</div></div><div class="card"><div class="label">Lead Rows</div><div class="num" id="statLeads">—</div></div><div class="card"><div class="label">Hot Leads</div><div class="num" id="statHot">—</div></div><div class="card"><div class="label">Ready Leads</div><div class="num" id="statReady">—</div></div></div><div class="grid2"><div class="card"><h3>Who is signed in</h3><div class="info"><div class="box"><b>Signed in as</b><span id="who">—</span></div><div class="box"><b>Role</b><span id="role">—</span></div><div class="box"><b>Agency</b><span>Invicta Capital Group</span></div><div class="box"><b>Agency ID</b><span id="agency">—</span></div></div><h3>Integration status</h3><table class="table"><tbody id="integrations"></tbody></table></div><div class="card"><h3>Administrator Operations</h3><div class="actions"><button class="secondary" id="refreshBtn">Refresh Admin Console</button><button class="secondary" id="dbInitBtn">Initialize Database Schema</button><button id="importBtn">Import 1,000 Carriers</button><button id="scoreBtn">Refresh Scores</button><div class="row"><button id="txBtn">Run Texas Verification</button><select id="txLimit"><option>10</option><option>25</option><option>50</option></select></div><div class="row"><button id="flBtn">Run Florida Verification</button><select id="flLimit"><option>10</option><option>25</option><option>50</option></select></div><button id="arkonBtn">Test CRM Export: 1 Lead</button><button id="sheetsBtn" class="secondary">Test Sheet Export: 10 Leads</button><button id="logoutBtn" style="background:#991b1b">Logout</button></div></div></div><div class="grid2" style="margin-top:14px"><div class="card"><h3>Quality Gate Snapshot</h3><table class="table"><thead><tr><th>Company</th><th>USDOT</th><th>Grade</th><th>Status</th></tr></thead><tbody id="readyRows"></tbody></table></div><div class="card"><h3>Admin Audit Output</h3><pre id="output">Ready.</pre></div></div></section></main></div><script>
  const keyInput=document.getElementById('adminKey'),loginCard=document.getElementById('loginCard'),dashboard=document.getElementById('dashboard'),sessionPill=document.getElementById('sessionPill'),output=document.getElementById('output');
  function k(){return sessionStorage.getItem('FMCSA_ADMIN_KEY')||''}function h(){return{'content-type':'application/json','x-admin-api-key':k()}}function out(v){output.textContent=typeof v==='string'?v:JSON.stringify(v,null,2)}function f(v){return v===null||v===undefined||v===''?'N/A':String(v)}function yn(v){return v?'<span class="ok">Configured</span>':'<span class="bad">Not configured</span>'}
  async function api(p,o){const r=await fetch(p,o||{});const t=await r.text();let d;try{d=JSON.parse(t)}catch(e){d={raw:t}}if(!r.ok)throw new Error(d.error||t);return d}async function post(p,b){return api(p,{method:'POST',headers:h(),body:JSON.stringify(b||{})})}async function get(p){return api(p,{headers:h()})}
  async function stats(){const d=await api('/stats'),s=d.stats||{};statCarriers.textContent=f(s.carriers);statLeads.textContent=f(s.leads);statHot.textContent=f(s.hot_leads);statReady.textContent=f(s.sales_ready_leads)}
  async function admin(){const d=await get('/admin/config/status');who.textContent=f(d.admin.signedInAs);role.textContent=f(d.admin.role);agency.textContent=f(d.admin.agencyId);integrations.innerHTML='<tr><td>CRM Webhook</td><td>'+yn(d.integrations.arkonWebhookConfigured)+'</td></tr><tr><td>Sheets Webhook</td><td>'+yn(d.integrations.googleSheetsWebhookConfigured)+'</td></tr><tr><td>Texas API</td><td>'+yn(d.integrations.txComptrollerKeyConfigured)+'</td></tr><tr><td>Admin Auth</td><td>'+yn(d.integrations.adminApiKeyConfigured)+'</td></tr>'}
  async function ready(){const d=await api('/leads?limit=5&minGrade=B&qualityGate=true'),rows=d.leads||[];readyRows.innerHTML=rows.length?rows.map(x=>'<tr><td>'+f(x.legal_name)+'</td><td>'+f(x.usdot_number)+'</td><td>'+f(x.lead_grade)+'</td><td>'+(x.sales_ready?'<span class="ok">Ready</span>':'<span class="bad">Blocked</span>')+'</td></tr>').join(''):'<tr><td colspan="4">No ready leads.</td></tr>'}
  async function refresh(){await stats();await admin();await ready()}function show(){loginCard.classList.add('hidden');dashboard.classList.remove('hidden');sessionPill.textContent='Admin session active';sessionPill.classList.add('ok')}function hide(){dashboard.classList.add('hidden');loginCard.classList.remove('hidden');sessionPill.textContent='Not signed in';sessionPill.classList.remove('ok')}
  async function login(){sessionStorage.setItem('FMCSA_ADMIN_KEY',keyInput.value.trim());try{await get('/admin/config/status');show();await refresh()}catch(e){sessionStorage.removeItem('FMCSA_ADMIN_KEY');loginStatus.textContent=e.message}}
  async function run(label,fn){out(label+'...');try{const d=await fn();out(d);await refresh()}catch(e){out({ok:false,error:e.message})}}
  loginBtn.onclick=login;clearBtn.onclick=()=>{keyInput.value='';sessionStorage.removeItem('FMCSA_ADMIN_KEY')};logoutBtn.onclick=()=>{sessionStorage.removeItem('FMCSA_ADMIN_KEY');hide()};refreshBtn.onclick=()=>run('Refreshing admin console',refresh);dbInitBtn.onclick=()=>run('Initializing database schema',()=>post('/admin/db/init',{}));importBtn.onclick=()=>run('Importing carriers',()=>post('/admin/import',{source:'company-census',limit:1000}));scoreBtn.onclick=()=>run('Refreshing scores',()=>post('/admin/score/refresh',{}));txBtn.onclick=()=>run('Running Texas verification',()=>post('/admin/enrich/texas',{limit:Number(txLimit.value)}));flBtn.onclick=()=>run('Running Florida verification',()=>post('/admin/enrich/fl',{limit:Number(flLimit.value)}));arkonBtn.onclick=()=>run('Testing CRM export',()=>post('/admin/export/arkon',{limit:1,minGrade:'B'}));sheetsBtn.onclick=()=>run('Testing Sheet export',()=>post('/admin/export/sheets',{limit:10,minGrade:'B'}));if(k()){show();refresh().catch(e=>out({ok:false,error:e.message}))}
  </script></body></html>`;
}

app.get('/admin', (_req, res) => {
  res.type('html').send(adminPageHtml());
});

app.get('/admin/config/status', requireAdmin, (_req, res) => {
  res.json({
    ok: true,
    admin: {
      signedInAs: 'Verified administrator',
      role: 'System Administrator',
      agencyName: 'Invicta Capital Group',
      agencyId: config.defaultAgencyId
    },
    integrations: {
      adminApiKeyConfigured: Boolean(config.adminApiKey),
      arkonWebhookConfigured: Boolean(config.arkonWebhookUrl),
      googleSheetsWebhookConfigured: Boolean(config.googleSheetsWebhookUrl),
      txComptrollerKeyConfigured: Boolean(config.txComptrollerApiKey)
    }
  });
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
