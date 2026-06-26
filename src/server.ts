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

function slug(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || `item-${Date.now()}`;
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

async function tableExists(tableName: string): Promise<boolean> {
  const result = await query('select to_regclass($1) as table_name', [`public.${tableName}`]);
  return Boolean(result.rows[0]?.table_name);
}

async function safeCount(tableName: string, whereClause = 'true'): Promise<number> {
  if (!/^[_a-zA-Z][_a-zA-Z0-9]*$/.test(tableName)) return 0;
  if (!(await tableExists(tableName))) return 0;
  const result = await query(`select count(*)::int as count from ${tableName} where ${whereClause}`);
  return Number(result.rows[0]?.count ?? 0);
}

async function ensureAdminTables() {
  await query(`
    create table if not exists insurance_agencies (
      id bigserial primary key,
      agency_key text not null unique,
      agency_name text not null,
      legal_name text,
      display_name text,
      brand_name text,
      service_area text,
      lines_of_business text[] not null default '{}',
      status text not null default 'ACTIVE',
      notes text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);
  await query(`
    create table if not exists insurance_agents (
      id bigserial primary key,
      agent_key text not null unique,
      agency_key text,
      agent_name text not null,
      email text,
      phone text,
      role text not null default 'AGENT',
      status text not null default 'ACTIVE',
      lines_of_business text[] not null default '{}',
      notes text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);
  await query(`
    insert into insurance_agencies (agency_key, agency_name, legal_name, display_name, brand_name, service_area, lines_of_business, status, notes)
    values ('invicta-capital-group', 'Invicta Capital Group', 'Invicta Capital Group', 'Invicta Capital Group', 'Invicta', 'Nationwide', array['Property & Casualty','Life','Health']::text[], 'ACTIVE', 'Default agency for Invicta commercial insurance lead engine.')
    on conflict (agency_key) do update set agency_name = excluded.agency_name, updated_at = now()
  `);
}

async function listAgencies() {
  await ensureAdminTables();
  const result = await query(`
    select a.*, count(ag.id)::int as agent_count
    from insurance_agencies a
    left join insurance_agents ag on ag.agency_key = a.agency_key and ag.status = 'ACTIVE'
    group by a.id
    order by a.created_at desc
  `);
  return result.rows;
}

async function listAgents() {
  await ensureAdminTables();
  const result = await query(`
    select ag.*, a.agency_name
    from insurance_agents ag
    left join insurance_agencies a on a.agency_key = ag.agency_key
    order by ag.created_at desc
  `);
  return result.rows;
}

async function recentImports() {
  if (!(await tableExists('import_runs'))) return [];
  const result = await query(`select source, fetched_count, inserted_count, updated_count, started_at from import_runs order by started_at desc limit 6`);
  return result.rows;
}

async function recentRegistryPulls() {
  if (!(await tableExists('state_registry_matches'))) return [];
  const result = await query(`select source_name, state_code, search_name, matched_name, entity_status, created_at from state_registry_matches order by created_at desc limit 6`);
  return result.rows;
}

function adminPageHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Invicta Admin Overview</title><style>
  body{margin:0;background:#0b1220;color:#e2e8f0;font-family:Arial,Helvetica,sans-serif}.adm a{color:inherit;text-decoration:none}.topbar{border-bottom:1px solid #1e293b;padding:14px 24px;display:flex;align-items:center;justify-content:space-between}.brand{display:flex;align-items:center;gap:10px}.mark{width:30px;height:30px;background:#3b82f6;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700}.links{display:flex;gap:18px;font-size:13px;color:#94a3b8;align-items:center;flex-wrap:wrap}.wrap{max-width:1200px;margin:0 auto;padding:32px 24px}.hero{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:24px}.eyebrow{color:#60a5fa;font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;margin-bottom:8px}.hero h1{font-size:30px;line-height:1.1;font-weight:800;letter-spacing:-.03em;margin:0}.hero p{color:#64748b;font-size:14px;margin:9px 0 0}.card{background:#111a2b;border:1px solid #1e293b;border-radius:12px}.btn{display:inline-block;border:0;border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer;font-weight:700}.blue{background:#2563eb;color:#fff}.gray{background:#1e293b;color:#94a3b8;border:1px solid #283548}.red{background:#7f1d1d;color:#fecaca}.greenText{color:#4ade80}.redText{color:#f87171}.login{max-width:520px;margin:72px auto;padding:24px}.login input,input,select,textarea{background:#16202f;border:1px solid #283548;border-radius:8px;padding:10px 12px;color:#e2e8f0}.login input,input,textarea{width:100%}.login p,.muted{color:#64748b;font-size:13px}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px;margin-bottom:18px}.stat{display:block;padding:18px 20px;min-height:104px}.stat .num{font-size:34px;line-height:1;font-weight:800;letter-spacing:-.04em}.stat .label{font-size:13px;color:#cbd5e1;margin-top:14px;font-weight:700}.stat .helper{font-size:12px;color:#64748b;margin-top:4px}.grid2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:18px}.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.panel{padding:22px;min-height:240px}.panelHead{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:18px}.panel h2{font-size:15px;margin:0;font-weight:800}.panel p{color:#64748b;font-size:12px;margin:5px 0 0}table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;padding:10px 12px;color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.04em;font-weight:600;border-bottom:1px solid #1e293b}td{padding:12px;border-bottom:1px solid #16202f;vertical-align:middle}tr:hover td{background:#111f34}.ops{display:grid;gap:10px}.row{display:grid;grid-template-columns:1fr 90px;gap:8px}.hidden{display:none}pre{background:#07111f;border:1px solid #1e293b;border-radius:12px;padding:12px;white-space:pre-wrap;max-height:340px;overflow:auto;color:#cbd5e1}@media(max-width:850px){.hero,.grid2,.grid3{grid-template-columns:1fr;display:grid}.topbar{align-items:flex-start;gap:14px;flex-direction:column}.links{gap:10px}}
  </style></head><body><div class="adm"><nav class="topbar"><div class="brand"><span class="mark">I</span><span style="font-weight:700;font-size:15px">Invicta Admin</span></div><div class="links"><span>Overview</span><span>Agencies</span><span>Agents</span><span>API Pulls</span><span>Integrations</span><span>Audit log</span><span id="sessionPill">Signed out</span></div></nav><main class="wrap"><section class="login card" id="loginCard"><div class="eyebrow">Secure access</div><h1>Admin Login</h1><p>Enter the admin key to view agencies, agents, API pulls, integrations, and admin operations.</p><input id="adminKey" type="password" placeholder="Admin key"/><div style="display:flex;gap:10px;margin-top:12px"><button class="btn blue" id="loginBtn">Open admin</button><button class="btn gray" id="clearBtn">Clear</button></div><p id="loginStatus"></p></section><section id="dashboard" class="hidden"><div class="hero"><div><div class="eyebrow">Control center</div><h1>Overview</h1><p>Monitor agencies, agents, API pulls, integrations, and recent platform activity from one clean view.</p></div><button class="btn red" id="logoutBtn">Logout</button></div><div class="stats"><div class="card stat"><div class="num" id="agencyCount">—</div><div class="label">Active agencies</div><div class="helper">Insurance agencies in system</div></div><div class="card stat"><div class="num" id="agentCount">—</div><div class="label">Active agents</div><div class="helper">Approved production users</div></div><div class="card stat"><div class="num" id="apiPullCount">—</div><div class="label">API / data pulls</div><div class="helper">FMCSA imports plus registry pulls</div></div><div class="card stat"><div class="num" id="readyCount">—</div><div class="label">Ready leads</div><div class="helper">Quality-gated exportable records</div></div></div><div class="grid2"><section class="card panel"><div class="panelHead"><div><h2>Agencies</h2><p>Add agencies and review active agent counts.</p></div></div><div class="grid3"><input id="agencyNameInput" placeholder="Agency name"/><input id="agencyServiceInput" placeholder="Service area" value="Nationwide"/><button class="btn blue" id="addAgencyBtn">+ New agency</button></div><table style="margin-top:14px"><thead><tr><th>Agency</th><th>Key</th><th>Agents</th><th>Status</th></tr></thead><tbody id="agencyRows"></tbody></table></section><section class="card panel"><div class="panelHead"><div><h2>Agents</h2><p>Add production users under an agency.</p></div></div><div class="grid3"><input id="agentNameInput" placeholder="Agent name"/><input id="agentEmailInput" placeholder="Email"/><select id="agentAgencySelect"></select></div><div style="display:flex;gap:10px;margin-top:10px"><input id="agentPhoneInput" placeholder="Phone"/><button class="btn blue" id="addAgentBtn">+ New agent</button></div><table style="margin-top:14px"><thead><tr><th>Agent</th><th>Email</th><th>Agency</th><th>Status</th></tr></thead><tbody id="agentRows"></tbody></table></section></div><div class="grid2" style="margin-top:18px"><section class="card panel"><div class="panelHead"><div><h2>Recent API / data pulls</h2><p>Latest FMCSA import and registry enrichment activity.</p></div><button class="btn gray" id="refreshBtn">Refresh</button></div><table><thead><tr><th>Source</th><th>Details</th><th>Date</th></tr></thead><tbody id="pullRows"></tbody></table></section><section class="card panel"><div class="panelHead"><div><h2>Integration status</h2><p>Connection readiness for production operations.</p></div></div><table><tbody id="integrationRows"></tbody></table></section></div><div class="grid2" style="margin-top:18px"><section class="card panel"><div class="panelHead"><div><h2>Administrator operations</h2><p>Controlled jobs. Agent lead work belongs outside this admin view.</p></div></div><div class="ops"><button class="btn gray" id="dbInitBtn">Initialize DB schema</button><button class="btn blue" id="importBtn">Import 1,000 carriers</button><button class="btn blue" id="scoreBtn">Refresh scores</button><div class="row"><button class="btn blue" id="txBtn">Run Texas verification</button><select id="txLimit"><option>10</option><option>25</option><option>50</option></select></div><div class="row"><button class="btn blue" id="flBtn">Run Florida verification</button><select id="flLimit"><option>10</option><option>25</option><option>50</option></select></div><button class="btn gray" id="arkonBtn">Test CRM export: 1 lead</button></div></section><section class="card panel"><div class="panelHead"><div><h2>Audit output</h2><p>Last admin action response.</p></div></div><pre id="output">Ready.</pre></section></div></section></main></div><script>
  const loginCard=document.getElementById('loginCard'),dashboard=document.getElementById('dashboard'),output=document.getElementById('output');function k(){return sessionStorage.getItem('FMCSA_ADMIN_KEY')||''}function h(){return{'content-type':'application/json','x-admin-api-key':k()}}function f(v){return v===null||v===undefined||v===''?'N/A':String(v)}function yn(v){return v?'<span class="greenText">Configured</span>':'<span class="redText">Not configured</span>'}function out(v){output.textContent=typeof v==='string'?v:JSON.stringify(v,null,2)}async function api(p,o){const r=await fetch(p,o||{}),t=await r.text();let d;try{d=JSON.parse(t)}catch(e){d={raw:t}}if(!r.ok)throw new Error(d.error||t);return d}async function get(p){return api(p,{headers:h()})}async function post(p,b){return api(p,{method:'POST',headers:h(),body:JSON.stringify(b||{})})}function show(){loginCard.classList.add('hidden');dashboard.classList.remove('hidden');sessionPill.textContent='Signed in'}function hide(){dashboard.classList.add('hidden');loginCard.classList.remove('hidden');sessionPill.textContent='Signed out'}
  async function load(){const d=await get('/admin/overview');const m=d.metrics;agencyCount.textContent=f(m.agencies.active);agentCount.textContent=f(m.agents.active);apiPullCount.textContent=f(m.apiPulls.total);readyCount.textContent=f(m.leads.salesReady);integrationRows.innerHTML='<tr><td>Admin auth</td><td>'+yn(d.integrations.adminApiKeyConfigured)+'</td></tr><tr><td>CRM webhook</td><td>'+yn(d.integrations.arkonWebhookConfigured)+'</td></tr><tr><td>Sheets webhook</td><td>'+yn(d.integrations.googleSheetsWebhookConfigured)+'</td></tr><tr><td>Texas API key</td><td>'+yn(d.integrations.txComptrollerKeyConfigured)+'</td></tr>';pullRows.innerHTML=(d.recentPulls||[]).length?d.recentPulls.map(x=>'<tr><td>'+f(x.source)+'</td><td>'+f(x.details)+'</td><td>'+f(x.date)+'</td></tr>').join(''):'<tr><td colspan="3">No pull history yet.</td></tr>';agencyRows.innerHTML=(d.agencies||[]).map(a=>'<tr><td>'+f(a.agency_name)+'</td><td>'+f(a.agency_key)+'</td><td>'+f(a.agent_count)+'</td><td>'+f(a.status)+'</td></tr>').join('');agentRows.innerHTML=(d.agents||[]).length?(d.agents||[]).map(a=>'<tr><td>'+f(a.agent_name)+'</td><td>'+f(a.email)+'</td><td>'+f(a.agency_name||a.agency_key)+'</td><td>'+f(a.status)+'</td></tr>').join(''):'<tr><td colspan="4">No agents yet.</td></tr>';agentAgencySelect.innerHTML=(d.agencies||[]).map(a=>'<option value="'+f(a.agency_key)+'">'+f(a.agency_name)+'</option>').join('')}
  async function login(){sessionStorage.setItem('FMCSA_ADMIN_KEY',adminKey.value.trim());try{await get('/admin/overview');show();await load()}catch(e){sessionStorage.removeItem('FMCSA_ADMIN_KEY');loginStatus.textContent=e.message}}async function run(label,fn){out(label+'...');try{const d=await fn();out(d);await load()}catch(e){out({ok:false,error:e.message})}}
  loginBtn.onclick=login;clearBtn.onclick=()=>{adminKey.value='';sessionStorage.removeItem('FMCSA_ADMIN_KEY')};logoutBtn.onclick=()=>{sessionStorage.removeItem('FMCSA_ADMIN_KEY');hide()};refreshBtn.onclick=()=>run('Refreshing admin overview',load);dbInitBtn.onclick=()=>run('Initializing schema',()=>post('/admin/db/init',{}));importBtn.onclick=()=>run('Importing carriers',()=>post('/admin/import',{source:'company-census',limit:1000}));scoreBtn.onclick=()=>run('Refreshing scores',()=>post('/admin/score/refresh',{}));txBtn.onclick=()=>run('Running Texas verification',()=>post('/admin/enrich/texas',{limit:Number(txLimit.value)}));flBtn.onclick=()=>run('Running Florida verification',()=>post('/admin/enrich/fl',{limit:Number(flLimit.value)}));arkonBtn.onclick=()=>run('Testing CRM export',()=>post('/admin/export/arkon',{limit:1,minGrade:'B'}));addAgencyBtn.onclick=()=>run('Creating agency',()=>post('/admin/agencies',{agencyName:agencyNameInput.value,serviceArea:agencyServiceInput.value}));addAgentBtn.onclick=()=>run('Creating agent',()=>post('/admin/agents',{agentName:agentNameInput.value,email:agentEmailInput.value,phone:agentPhoneInput.value,agencyKey:agentAgencySelect.value}));if(k()){show();load().catch(e=>out({ok:false,error:e.message}))}
  </script></body></html>`;
}

app.get('/admin', (_req, res) => res.type('html').send(adminPageHtml()));

app.get('/admin/overview', requireAdmin, async (_req, res, next) => {
  try {
    await ensureAdminTables();
    const [agencyCount, agentCount, carrierCount, leadCount, hotLeadCount, readyLeadCount, importRunCount, registryPullCount, imports, registry, agencies, agents] = await Promise.all([
      safeCount('insurance_agencies', "status = 'ACTIVE'"), safeCount('insurance_agents', "status = 'ACTIVE'"), safeCount('fmcsa_carriers'), safeCount('insurance_leads'), safeCount('insurance_leads', "lead_grade in ('A+', 'A')"), safeCount('insurance_leads', 'sales_ready = true'), safeCount('import_runs'), safeCount('state_registry_matches'), recentImports(), recentRegistryPulls(), listAgencies(), listAgents()
    ]);
    const recentPulls = [...imports.map((row) => ({ source: row.source ?? 'FMCSA', details: `fetched ${row.fetched_count ?? 0}, inserted ${row.inserted_count ?? 0}, updated ${row.updated_count ?? 0}`, date: row.started_at })), ...registry.map((row) => ({ source: `${row.source_name ?? 'STATE'} ${row.state_code ?? ''}`.trim(), details: `${row.search_name ?? row.matched_name ?? 'registry pull'} · ${row.entity_status ?? 'unknown'}`, date: row.created_at }))].sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? ''))).slice(0, 8);
    res.json({ ok: true, admin: { signedInAs: 'Verified administrator', role: 'System Administrator', agencyName: 'Invicta Capital Group', agencyId: config.defaultAgencyId }, integrations: { adminApiKeyConfigured: Boolean(config.adminApiKey), arkonWebhookConfigured: Boolean(config.arkonWebhookUrl), googleSheetsWebhookConfigured: Boolean(config.googleSheetsWebhookUrl), txComptrollerKeyConfigured: Boolean(config.txComptrollerApiKey) }, metrics: { agencies: { active: agencyCount }, agents: { active: agentCount }, apiPulls: { total: importRunCount + registryPullCount, importRuns: importRunCount, registryPulls: registryPullCount }, carriers: carrierCount, leads: { total: leadCount, hot: hotLeadCount, salesReady: readyLeadCount } }, recentPulls, agencies, agents });
  } catch (error) { next(error); }
});

app.post('/admin/agencies', requireAdmin, async (req, res, next) => {
  try {
    await ensureAdminTables();
    const agencyName = String(req.body?.agencyName ?? req.body?.name ?? '').trim();
    if (!agencyName) return res.status(400).json({ ok: false, error: 'agencyName is required.' });
    const agencyKey = slug(req.body?.agencyKey ?? agencyName);
    const result = await query(`insert into insurance_agencies (agency_key, agency_name, legal_name, display_name, brand_name, service_area, lines_of_business, status) values ($1,$2,$2,$2,$2,$3,array['Property & Casualty','Life','Health']::text[],'ACTIVE') on conflict (agency_key) do update set agency_name = excluded.agency_name, service_area = excluded.service_area, status = 'ACTIVE', updated_at = now() returning *`, [agencyKey, agencyName, String(req.body?.serviceArea ?? 'Nationwide')]);
    res.json({ ok: true, agency: result.rows[0] });
  } catch (error) { next(error); }
});

app.post('/admin/agents', requireAdmin, async (req, res, next) => {
  try {
    await ensureAdminTables();
    const agentName = String(req.body?.agentName ?? req.body?.name ?? '').trim();
    if (!agentName) return res.status(400).json({ ok: false, error: 'agentName is required.' });
    const email = String(req.body?.email ?? '').trim();
    const agentKey = slug(req.body?.agentKey ?? email || agentName);
    const result = await query(`insert into insurance_agents (agent_key, agency_key, agent_name, email, phone, role, status, lines_of_business) values ($1,$2,$3,$4,$5,$6,'ACTIVE',array['Property & Casualty','Life','Health']::text[]) on conflict (agent_key) do update set agency_key = excluded.agency_key, agent_name = excluded.agent_name, email = excluded.email, phone = excluded.phone, role = excluded.role, status = 'ACTIVE', updated_at = now() returning *`, [agentKey, String(req.body?.agencyKey ?? config.defaultAgencyId), agentName, email || null, String(req.body?.phone ?? '').trim() || null, String(req.body?.role ?? 'AGENT')]);
    res.json({ ok: true, agent: result.rows[0] });
  } catch (error) { next(error); }
});

app.get('/admin/config/status', requireAdmin, (_req, res) => res.json({ ok: true, admin: { signedInAs: 'Verified administrator', role: 'System Administrator', agencyName: 'Invicta Capital Group', agencyId: config.defaultAgencyId }, integrations: { adminApiKeyConfigured: Boolean(config.adminApiKey), arkonWebhookConfigured: Boolean(config.arkonWebhookUrl), googleSheetsWebhookConfigured: Boolean(config.googleSheetsWebhookUrl), txComptrollerKeyConfigured: Boolean(config.txComptrollerApiKey) } }));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'fmcsa-insurance-leads' }));
app.get('/scoring/rules', (_req, res) => res.json({ ok: true, scoring: publicScoringRules() }));

app.get('/admin/datasets/check', requireAdmin, async (req, res, next) => { try { const requestedSource = req.query.source ? String(req.query.source) as ImportSource : undefined; const sources = requestedSource ? [requestedSource] : importSources; const invalid = sources.filter((source) => !importSources.includes(source)); if (invalid.length) return res.status(400).json({ ok: false, error: `Invalid source: ${invalid.join(', ')}` }); const results = await Promise.all(sources.map((source) => checkSocrataDataset(source))); res.json({ ok: true, results }); } catch (error) { next(error); } });
app.post('/admin/db/init', requireAdmin, async (_req, res, next) => { try { await initSchema(); await ensureAdminTables(); res.json({ ok: true }); } catch (error) { next(error); } });
app.post('/admin/import', requireAdmin, async (req, res, next) => { try { const source = (req.body?.source ?? config.defaultImportSource) as ImportSource; const limit = Number.parseInt(String(req.body?.limit ?? config.importLimit), 10); const result = await importFmcsa(source, Number.isFinite(limit) ? limit : config.importLimit); res.json({ ok: true, result }); } catch (error) { next(error); } });
app.post('/admin/score/refresh', requireAdmin, async (_req, res, next) => { try { const result = await refreshScores(); res.json({ ok: true, result }); } catch (error) { next(error); } });
app.get('/admin/enrichment/sources', requireAdmin, async (_req, res, next) => { try { const sources = await getEnrichmentSources(); res.json({ ok: true, sources }); } catch (error) { next(error); } });
app.post('/admin/enrich/state-records', requireAdmin, async (req, res, next) => { try { const records = registryInputsFromBody(req.body); if (!records.length) return res.status(400).json({ ok: false, error: 'Provide stateCode, sourceName, and record or records[].' }); const invalid = records.filter((record) => !record.stateCode || !record.sourceName); if (invalid.length) return res.status(400).json({ ok: false, error: 'stateCode and sourceName are required.' }); const result = await ingestStateRegistryRecords(records); res.json(result); } catch (error) { next(error); } });
app.post('/admin/enrich/texas', requireAdmin, async (req, res, next) => { try { const limit = Number.parseInt(String(req.body?.limit ?? config.texasEnrichmentLimit), 10); const result = await enrichTexasCarriers({ limit: Number.isFinite(limit) ? limit : config.texasEnrichmentLimit, usdotNumbers: stringArray(req.body?.usdotNumbers ?? req.body?.usdotNumber), records: Array.isArray(req.body?.records) ? req.body.records : undefined }); res.json(result); } catch (error) { next(error); } });
app.post('/admin/enrich/fl', requireAdmin, async (req, res, next) => { try { const limit = Number.parseInt(String(req.body?.limit ?? 25), 10); const result = await enrichFloridaCarriers({ limit: Number.isFinite(limit) ? limit : 25, usdotNumbers: stringArray(req.body?.usdotNumbers ?? req.body?.usdotNumber), records: Array.isArray(req.body?.records) ? req.body.records : undefined }); res.json(result); } catch (error) { next(error); } });
app.get('/leads', async (req, res, next) => { try { const limit = Math.min(500, Number.parseInt(String(req.query.limit ?? 100), 10) || 100); const minGrade = String(req.query.minGrade ?? 'B'); const qualityGate = boolQuery(req.query.qualityGate); const leads = await getTopLeads(limit, minGrade, qualityGate); res.json({ ok: true, count: leads.length, qualityGate, leads }); } catch (error) { next(error); } });
app.post('/admin/export/arkon', requireAdmin, async (req, res, next) => { try { const result = await exportToArkon(Number(req.body?.limit ?? 100), String(req.body?.minGrade ?? 'B')); res.json({ ok: true, result }); } catch (error) { next(error); } });
app.post('/admin/export/sheets', requireAdmin, async (req, res, next) => { try { const result = await exportToSheets(Number(req.body?.limit ?? 100), String(req.body?.minGrade ?? 'B')); res.json({ ok: true, result }); } catch (error) { next(error); } });
app.get('/stats', async (_req, res, next) => { try { const result = await query(`select (select count(*)::int from fmcsa_carriers) as carriers, (select count(*)::int from insurance_leads) as leads, (select count(*)::int from insurance_leads where lead_grade in ('A+', 'A')) as hot_leads, (select count(*)::int from insurance_leads where sales_ready = true) as sales_ready_leads, (select max(started_at) from import_runs) as last_import_at`); res.json({ ok: true, stats: result.rows[0] }); } catch (error) { next(error); } });
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { const message = error instanceof Error ? error.message : String(error); console.error(error); res.status(500).json({ ok: false, error: message }); });
app.listen(config.port, () => { console.log(`FMCSA insurance lead service listening on ${config.port}`); });
