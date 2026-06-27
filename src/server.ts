import crypto from 'node:crypto';
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
const AGENT_SESSION_TTL_SECONDS = 60 * 60 * 12;

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

function text(value: unknown): string | null {
  const v = String(value ?? '').trim();
  return v || null;
}

function color(value: unknown, fallback: string): string {
  const v = String(value ?? '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback;
}

function htmlEscape(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
      raw,
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
  await query(`create table if not exists insurance_agencies (
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
  )`);

  await query(`alter table insurance_agencies add column if not exists website_url text`);
  await query(`alter table insurance_agencies add column if not exists logo_url text`);
  await query(`alter table insurance_agencies add column if not exists primary_color text`);
  await query(`alter table insurance_agencies add column if not exists accent_color text`);

  await query(`create table if not exists insurance_agents (
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
  )`);

  await query(
    `insert into insurance_agencies (
      agency_key, agency_name, legal_name, display_name, brand_name, service_area,
      lines_of_business, status, notes, website_url, primary_color, accent_color
    ) values (
      'invicta-capital-group', 'Invicta Capital Group', 'Invicta Capital Group',
      'Invicta Capital Group', 'Invicta', 'Nationwide',
      array['Property & Casualty','Life','Health']::text[], 'ACTIVE',
      'Default agency for Invicta commercial insurance lead engine.',
      'https://www.invictaprotection.com', '#2563eb', '#22c55e'
    ) on conflict (agency_key) do update set agency_name = excluded.agency_name, updated_at = now()`
  );
}

async function listAgencies() {
  await ensureAdminTables();
  const result = await query(`select a.*, count(ag.id)::int as agent_count
    from insurance_agencies a
    left join insurance_agents ag on ag.agency_key = a.agency_key and ag.status = 'ACTIVE'
    group by a.id
    order by a.created_at desc`);
  return result.rows;
}

async function listAgents() {
  await ensureAdminTables();
  const result = await query(`select ag.*, a.agency_name
    from insurance_agents ag
    left join insurance_agencies a on a.agency_key = ag.agency_key
    order by ag.created_at desc`);
  return result.rows;
}

async function recentImports() {
  if (!(await tableExists('import_runs'))) return [];
  const result = await query(`select source, fetched_count, inserted_count, updated_count, started_at
    from import_runs
    order by started_at desc
    limit 6`);
  return result.rows;
}

async function recentRegistryPulls() {
  if (!(await tableExists('state_registry_matches'))) return [];
  const result = await query(`select source_name, state_code, search_name, matched_name, entity_status, created_at
    from state_registry_matches
    order by created_at desc
    limit 6`);
  return result.rows;
}

function agentAuthSecret(): string {
  return process.env.AGENT_AUTH_SECRET || config.adminApiKey || config.databaseUrl || 'fmcsapull-agent-session-secret';
}

function signAgentPayload(payload: string): string {
  return crypto.createHmac('sha256', agentAuthSecret()).update(payload).digest('base64url');
}

function createAgentToken(agent: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    agentKey: String(agent.agent_key ?? ''),
    agencyKey: String(agent.agency_key ?? ''),
    email: String(agent.email ?? ''),
    iat: now,
    exp: now + AGENT_SESSION_TTL_SECONDS,
  }), 'utf8').toString('base64url');
  return `${payload}.${signAgentPayload(payload)}`;
}

function readAgentToken(req: express.Request): string {
  const header = req.header('authorization') || '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return String(req.query.agentToken ?? '').trim();
}

function verifyAgentToken(req: express.Request): Record<string, unknown> | null {
  const token = readAgentToken(req);
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;

  const expected = signAgentPayload(payload);
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== signatureBuffer.length) return null;
  if (!crypto.timingSafeEqual(expectedBuffer, signatureBuffer)) return null;

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (!decoded.agentKey || Number(decoded.exp ?? 0) < Math.floor(Date.now() / 1000)) return null;
    return decoded;
  } catch {
    return null;
  }
}

async function findAgentByEmail(email: string) {
  await ensureAdminTables();
  const result = await query(`select ag.*, a.agency_name, a.brand_name, a.primary_color, a.accent_color
    from insurance_agents ag
    left join insurance_agencies a on a.agency_key = ag.agency_key
    where lower(coalesce(ag.email, '')) = lower($1)
      and ag.status = 'ACTIVE'
    limit 1`, [email]);
  return result.rows[0] ?? null;
}

async function findAgentByRequest(req: express.Request) {
  const decoded = verifyAgentToken(req);
  if (!decoded) return null;
  await ensureAdminTables();
  const result = await query(`select ag.*, a.agency_name, a.brand_name, a.primary_color, a.accent_color
    from insurance_agents ag
    left join insurance_agencies a on a.agency_key = ag.agency_key
    where ag.agent_key = $1
      and ag.status = 'ACTIVE'
    limit 1`, [String(decoded.agentKey)]);
  return result.rows[0] ?? null;
}

function publicAgent(agent: Record<string, unknown>) {
  return {
    id: agent.id,
    agentKey: agent.agent_key,
    agencyKey: agent.agency_key,
    agentName: agent.agent_name,
    email: agent.email,
    phone: agent.phone,
    role: agent.role,
    status: agent.status,
    agencyName: agent.agency_name,
    brandName: agent.brand_name,
    primaryColor: agent.primary_color,
    accentColor: agent.accent_color,
  };
}

function publicLead(row: Record<string, unknown>) {
  return {
    id: row.id,
    usdotNumber: row.usdot_number,
    leadStatus: row.lead_status,
    leadGrade: row.lead_grade,
    leadScore: row.lead_score,
    recommendedProducts: row.recommended_products ?? [],
    outreachAngle: row.outreach_angle,
    scoringReasons: row.scoring_reasons ?? [],
    salesReady: row.sales_ready,
    salesReadyReason: row.sales_ready_reason,
    decisionMakerName: row.decision_maker_name,
    decisionMakerTitle: row.decision_maker_title,
    decisionMakerEmail: row.decision_maker_email,
    decisionMakerPhone: row.decision_maker_phone,
    personalizationName: row.personalization_name,
    legalName: row.legal_name,
    dbaName: row.dba_name,
    city: row.hq_city || row.physical_city,
    state: row.hq_state || row.physical_state,
    carrierPhone: row.carrier_phone,
    carrierEmail: row.carrier_email,
    powerUnits: row.power_units,
    drivers: row.drivers,
    cargo: row.cargo ?? [],
  };
}

function gradeFilter(minGrade: string): string[] {
  const order = ['A+', 'A', 'B', 'C', 'D'];
  const index = order.indexOf(minGrade.trim().toUpperCase());
  return index < 0 ? ['A+', 'A', 'B'] : order.slice(0, index + 1);
}

async function getAgentLeads(limit: number, minGrade: string, qualityGate: boolean) {
  const conditions = ['l.lead_grade = any($1::text[])'];
  if (qualityGate) conditions.push('l.sales_ready = true');

  const result = await query(`select
      l.id, l.usdot_number, l.lead_status, l.lead_grade, l.lead_score,
      l.recommended_products, l.outreach_angle, l.scoring_reasons,
      l.sales_ready, l.sales_ready_reason,
      l.decision_maker_name, l.decision_maker_title, l.decision_maker_email, l.decision_maker_phone,
      l.personalization_name, l.hq_city, l.hq_state,
      c.legal_name, c.dba_name, c.physical_city, c.physical_state,
      c.phone as carrier_phone, c.email as carrier_email, c.power_units, c.drivers, c.cargo
    from insurance_leads l
    join fmcsa_carriers c on c.id = l.carrier_id
    where ${conditions.join(' and ')}
    order by l.sales_ready desc, l.lead_score desc, l.updated_at desc
    limit $2`, [gradeFilter(minGrade), limit]);

  return result.rows;
}

function adminPageHtml(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Invicta Admin</title>
  <style>
    :root{--bg:#0b1220;--card:#111a2b;--border:#1e293b;--muted:#64748b;--text:#e2e8f0;--input:#16202f;--inputBorder:#283548;--blue:#2563eb;--red:#7f1d1d}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Arial,sans-serif}.top{border-bottom:1px solid var(--border);padding:14px 24px;display:flex;justify-content:space-between;gap:16px}.links{display:flex;gap:16px;color:#94a3b8;font-size:13px;flex-wrap:wrap}.wrap{max-width:1240px;margin:0 auto;padding:30px 22px}.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px;margin:18px 0}.two{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:18px}.num{font-size:34px;font-weight:800}.muted{color:var(--muted);font-size:13px;line-height:1.45}.label{color:#cbd5e1;font-size:13px;font-weight:700;margin-top:12px}button{border:0;border-radius:8px;padding:9px 13px;background:var(--blue);color:white;font-weight:700;cursor:pointer;min-height:38px}button:disabled{opacity:.55}button.gray{background:#1e293b;color:#cbd5e1;border:1px solid var(--inputBorder)}button.red{background:var(--red);color:#fecaca}input,select{background:var(--input);border:1px solid var(--inputBorder);border-radius:8px;padding:9px 11px;color:var(--text);min-height:38px;width:100%}.form3{display:grid;grid-template-columns:1fr 1fr auto;gap:10px}.form4{display:grid;grid-template-columns:1fr 1fr 120px 120px;gap:10px;margin-top:10px}.form2{display:grid;grid-template-columns:1fr auto;gap:10px;margin-top:10px}table{width:100%;border-collapse:collapse;font-size:13px;margin-top:12px}td,th{border-bottom:1px solid #16202f;padding:10px;text-align:left;vertical-align:middle}th{color:var(--muted);text-transform:uppercase;font-size:11px}.hidden{display:none!important}.ok{color:#4ade80}.warn{color:#fbbf24}.sw{display:inline-block;width:18px;height:18px;border-radius:99px;border:1px solid #475569;margin-right:4px;vertical-align:middle}.logoPrev{max-width:40px;max-height:28px;border-radius:5px;background:#fff}pre{background:#07111f;border:1px solid var(--border);border-radius:12px;padding:12px;white-space:pre-wrap;max-height:340px;overflow:auto}.rowActions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}@media(max-width:900px){.two,.form3,.form4,.form2{grid-template-columns:1fr}.top{display:block}.links{margin-top:10px}}
  </style>
</head>
<body>
  <div class="top"><b>Invicta Admin</b><div class="links"><span>Overview</span><span>Agencies</span><span>Agents</span><span>API Pulls</span><span>Integrations</span><a href="/agent/login" style="color:#93c5fd">Agent login</a><span id="sessionPill">Signed out</span></div></div>
  <main class="wrap">
    <section id="loginCard" class="card" style="max-width:520px;margin:60px auto"><h1>Admin Login</h1><p class="muted">Enter the admin key.</p><input id="adminKey" type="password" placeholder="Admin key"/><div class="rowActions" style="margin-top:12px"><button id="loginBtn" type="button">Open admin</button><button class="gray" id="clearBtn" type="button">Clear</button></div><p id="loginStatus" class="muted"></p></section>
    <section id="dashboard" class="hidden">
      <div style="display:flex;justify-content:space-between;gap:16px"><div><h1>Overview</h1><p class="muted">Manage agencies, agents, agency branding, API pulls, integrations, and admin operations.</p></div><button class="red" id="logoutBtn" type="button">Logout</button></div>
      <div class="grid"><div class="card"><div class="num" id="agencyCount">-</div><div class="label">Active agencies</div></div><div class="card"><div class="num" id="agentCount">-</div><div class="label">Active agents</div></div><div class="card"><div class="num" id="apiPullCount">-</div><div class="label">API / data pulls</div></div><div class="card"><div class="num" id="readyCount">-</div><div class="label">Ready leads</div></div></div>
      <div class="two"><section class="card"><h2>Agencies & Branding</h2><p class="muted">Add an agency/client and set its branding.</p><div class="form3"><input id="agencyNameInput" placeholder="Agency / client name"/><input id="agencyServiceInput" value="Nationwide"/><button id="addAgencyBtn" type="button">+ New agency</button></div><div class="form4"><input id="agencyBrandInput" placeholder="Brand name"/><input id="agencyWebsiteInput" placeholder="Website URL"/><input id="agencyPrimaryInput" placeholder="#2563eb" value="#2563eb"/><input id="agencyAccentInput" placeholder="#22c55e" value="#22c55e"/></div><div class="form2"><input id="agencyLogoInput" placeholder="Logo URL"/><button class="gray" type="button" id="previewBrandBtn">Preview</button></div><table><thead><tr><th>Logo</th><th>Agency</th><th>Brand</th><th>Colors</th><th>Agents</th><th>Status</th></tr></thead><tbody id="agencyRows"></tbody></table></section><section class="card"><h2>Agents</h2><p class="muted">Add agents under an agency/client. Agents log in with this email.</p><div class="form3"><input id="agentNameInput" placeholder="Agent name"/><input id="agentEmailInput" placeholder="Email"/><select id="agentAgencySelect"></select></div><div class="form2"><input id="agentPhoneInput" placeholder="Phone"/><button id="addAgentBtn" type="button">+ New agent</button></div><table><thead><tr><th>Agent</th><th>Email</th><th>Agency</th><th>Status</th></tr></thead><tbody id="agentRows"></tbody></table></section></div>
      <div class="two"><section class="card"><h2>Recent API / data pulls</h2><button class="gray" id="refreshBtn" type="button">Refresh</button><table><thead><tr><th>Source</th><th>Details</th><th>Date</th></tr></thead><tbody id="pullRows"></tbody></table></section><section class="card"><h2>Integration status</h2><table><tbody id="integrationRows"></tbody></table></section></div>
      <div class="two"><section class="card"><h2>Administrator operations</h2><div style="display:grid;gap:10px"><button class="gray" id="dbInitBtn" type="button">Initialize DB schema</button><button id="importBtn" type="button">Import 1,000 carriers</button><button id="scoreBtn" type="button">Refresh scores</button><div style="display:grid;grid-template-columns:1fr 90px;gap:8px"><button id="txBtn" type="button">Run Texas verification</button><select id="txLimit"><option>10</option><option>25</option><option>50</option></select></div><div style="display:grid;grid-template-columns:1fr 90px;gap:8px"><button id="flBtn" type="button">Run Florida verification</button><select id="flLimit"><option>10</option><option>25</option><option>50</option></select></div><button class="gray" id="arkonBtn" type="button">Test CRM export: 1 lead</button></div></section><section class="card"><h2>Audit output</h2><pre id="output">Ready.</pre></section></div>
    </section>
  </main>
  <script>
    (function(){
      var KEY='FMCSA_ADMIN_KEY';
      function id(x){return document.getElementById(x)} function k(){return sessionStorage.getItem(KEY)||''} function h(){return {'content-type':'application/json','x-admin-api-key':k()}} function v(x){var e=id(x);return e&&'value'in e?String(e.value||'').trim():''} function sv(x,y){var e=id(x);if(e&&'value'in e)e.value=y} function esc(x){return String(x==null?'':x).replace(/[&<>\"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]})} function out(x){id('output').textContent=typeof x==='string'?x:JSON.stringify(x,null,2)} async function req(p,o){var r=await fetch(p,o||{}),raw=await r.text(),d;try{d=raw?JSON.parse(raw):{}}catch(e){d={raw:raw}}if(!r.ok)throw new Error(d.error||raw||('Request failed '+r.status));return d} async function get(p){return req(p,{headers:h()})} async function post(p,b){return req(p,{method:'POST',headers:h(),body:JSON.stringify(b||{})})}
      function show(){id('loginCard').classList.add('hidden');id('dashboard').classList.remove('hidden');id('sessionPill').textContent='Signed in'} function hide(){id('dashboard').classList.add('hidden');id('loginCard').classList.remove('hidden');id('sessionPill').textContent='Signed out'}
      function renderAgencies(a){var rows=id('agencyRows'),sel=id('agentAgencySelect');rows.innerHTML='';sel.innerHTML='';if(!a.length){rows.innerHTML='<tr><td colspan="6" class="muted">No agencies yet.</td></tr>';sel.innerHTML='<option value="">No agencies</option>';return}a.forEach(function(x){var opt=document.createElement('option');opt.value=x.agency_key;opt.textContent=x.agency_name||x.agency_key;sel.appendChild(opt);var logo=x.logo_url?'<img class="logoPrev" src="'+esc(x.logo_url)+'"/>':'<span class="muted">LOGO</span>';var colors='<span class="sw" style="background:'+esc(x.primary_color||'#2563eb')+'"></span><span class="sw" style="background:'+esc(x.accent_color||'#22c55e')+'"></span>';var tr=document.createElement('tr');tr.innerHTML='<td>'+logo+'</td><td><b>'+esc(x.agency_name)+'</b><br><span class="muted">'+esc(x.service_area||'')+'</span></td><td>'+esc(x.brand_name||x.display_name||'')+'</td><td>'+colors+'</td><td>'+esc(x.agent_count||0)+'</td><td>'+esc(x.status||'ACTIVE')+'</td>';rows.appendChild(tr)})}
      function renderAgents(a){var rows=id('agentRows');rows.innerHTML='';if(!a.length){rows.innerHTML='<tr><td colspan="4" class="muted">No agents yet.</td></tr>';return}a.forEach(function(x){var tr=document.createElement('tr');tr.innerHTML='<td><b>'+esc(x.agent_name)+'</b><br><span class="muted">'+esc(x.phone||'')+'</span></td><td>'+esc(x.email||'N/A')+'</td><td>'+esc(x.agency_name||x.agency_key||'N/A')+'</td><td>'+esc(x.status||'ACTIVE')+'</td>';rows.appendChild(tr)})}
      function renderPulls(a){var rows=id('pullRows');rows.innerHTML='';if(!a.length){rows.innerHTML='<tr><td colspan="3" class="muted">No recent pulls yet.</td></tr>';return}a.forEach(function(x){var tr=document.createElement('tr');tr.innerHTML='<td>'+esc(x.source||'N/A')+'</td><td>'+esc(x.details||'')+'</td><td>'+esc(x.date?new Date(x.date).toLocaleString():'N/A')+'</td>';rows.appendChild(tr)})}
      function renderIntegrations(x){var rows=id('integrationRows');rows.innerHTML='';[['Admin key',x.adminApiKeyConfigured],['ARKON webhook',x.arkonWebhookConfigured],['Google Sheets webhook',x.googleSheetsWebhookConfigured],['Texas Comptroller key',x.txComptrollerKeyConfigured]].forEach(function(i){var tr=document.createElement('tr');tr.innerHTML='<td>'+esc(i[0])+'</td><td>'+(i[1]?'<span class="ok">Configured</span>':'<span class="warn">Not configured</span>')+'</td>';rows.appendChild(tr)})}
      async function load(){var d=await get('/admin/overview');id('agencyCount').textContent=d.metrics.agencies.active;id('agentCount').textContent=d.metrics.agents.active;id('apiPullCount').textContent=d.metrics.apiPulls.total;id('readyCount').textContent=d.metrics.leads.salesReady;renderAgencies(d.agencies||[]);renderAgents(d.agents||[]);renderPulls(d.recentPulls||[]);renderIntegrations(d.integrations||{});show();out({ok:true,message:'Admin loaded',updatedAt:new Date().toISOString()})}
      async function addAgency(){var name=v('agencyNameInput');if(!name){out('Agency/client name is required.');id('agencyNameInput').focus();return}id('addAgencyBtn').disabled=true;try{out(await post('/admin/agencies',{agencyName:name,serviceArea:v('agencyServiceInput')||'Nationwide',brandName:v('agencyBrandInput')||name,websiteUrl:v('agencyWebsiteInput'),logoUrl:v('agencyLogoInput'),primaryColor:v('agencyPrimaryInput')||'#2563eb',accentColor:v('agencyAccentInput')||'#22c55e'}));sv('agencyNameInput','');sv('agencyBrandInput','');await load()}catch(e){out('Add agency failed: '+(e.message||e))}finally{id('addAgencyBtn').disabled=false}}
      async function addAgent(){var name=v('agentNameInput');if(!name){out('Agent name is required.');id('agentNameInput').focus();return}id('addAgentBtn').disabled=true;try{out(await post('/admin/agents',{agentName:name,email:v('agentEmailInput'),phone:v('agentPhoneInput'),agencyKey:v('agentAgencySelect'),role:'AGENT'}));sv('agentNameInput','');sv('agentEmailInput','');sv('agentPhoneInput','');await load()}catch(e){out('Add agent failed: '+(e.message||e))}finally{id('addAgentBtn').disabled=false}}
      function bind(x,fn){id(x).addEventListener('click',function(e){e.preventDefault();fn()})} bind('loginBtn',async function(){sessionStorage.setItem(KEY,v('adminKey'));try{await load()}catch(e){id('loginStatus').textContent=e.message||String(e)}}); bind('clearBtn',function(){sessionStorage.removeItem(KEY);sv('adminKey','')}); bind('logoutBtn',function(){sessionStorage.removeItem(KEY);hide()}); bind('refreshBtn',function(){load().catch(function(e){out(e.message||e)})}); bind('addAgencyBtn',addAgency); bind('addAgentBtn',addAgent); bind('previewBrandBtn',function(){out({agencyName:v('agencyNameInput'),brandName:v('agencyBrandInput'),websiteUrl:v('agencyWebsiteInput'),logoUrl:v('agencyLogoInput'),primaryColor:v('agencyPrimaryInput'),accentColor:v('agencyAccentInput')})}); bind('dbInitBtn',function(){post('/admin/db/init',{}).then(out).then(load).catch(function(e){out(e.message||e)})}); bind('importBtn',function(){post('/admin/import',{limit:1000}).then(out).then(load).catch(function(e){out(e.message||e)})}); bind('scoreBtn',function(){post('/admin/score/refresh',{}).then(out).then(load).catch(function(e){out(e.message||e)})}); bind('txBtn',function(){post('/admin/enrich/texas',{limit:Number(v('txLimit')||10)}).then(out).then(load).catch(function(e){out(e.message||e)})}); bind('flBtn',function(){post('/admin/enrich/fl',{limit:Number(v('flLimit')||10)}).then(out).then(load).catch(function(e){out(e.message||e)})}); bind('arkonBtn',function(){post('/admin/export/arkon',{limit:1,minGrade:'B'}).then(out).then(load).catch(function(e){out(e.message||e)})}); if(k()){sv('adminKey',k());load().catch(function(e){hide();id('loginStatus').textContent=e.message||String(e)})}
    })();
  </script>
</body>
</html>`;
}

function agentPageHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Invicta Agent Portal</title><style>*{box-sizing:border-box}body{margin:0;background:#0b1220;color:#e2e8f0;font-family:Arial,sans-serif}.top{border-bottom:1px solid #1e293b;padding:14px 24px;display:flex;justify-content:space-between;gap:16px}.wrap{max-width:1180px;margin:0 auto;padding:30px 22px}.card{background:#111a2b;border:1px solid #1e293b;border-radius:14px;padding:18px}.login{max-width:520px;margin:70px auto}.muted{color:#64748b;font-size:13px}.hidden{display:none!important}input,select{background:#16202f;border:1px solid #283548;border-radius:9px;padding:10px 12px;color:#e2e8f0;min-height:40px;width:100%}button{border:0;border-radius:9px;padding:10px 14px;background:#2563eb;color:white;font-weight:700;cursor:pointer;min-height:40px}button.gray{background:#1e293b;color:#cbd5e1;border:1px solid #283548}button.red{background:#7f1d1d;color:#fecaca}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px;margin:18px 0}.num{font-size:30px;font-weight:800}.leadGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:14px;margin-top:16px}.lead{background:#0f172a;border:1px solid #1e293b;border-radius:14px;padding:16px}.badge{display:inline-flex;border-radius:999px;padding:4px 9px;font-size:11px;font-weight:800;border:1px solid #334155;color:#cbd5e1;background:#111827}.badge.ready{border-color:#166534;color:#86efac;background:#052e16}.badge.grade{border-color:#92400e;color:#fcd34d;background:#451a03}.lead h3{margin:10px 0 6px;font-size:17px}.meta{font-size:12px;color:#94a3b8;margin-top:3px}.reason{font-size:12px;color:#cbd5e1;border-top:1px solid #1e293b;margin-top:12px;padding-top:10px}.toolbar{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-top:22px}.filters{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.filters select{width:auto;min-width:110px}.error{color:#fca5a5;font-size:13px;margin-top:12px;white-space:pre-wrap}@media(max-width:720px){.top,.row,.toolbar,.filters{display:grid;grid-template-columns:1fr}.filters select{width:100%}}</style></head><body><div class="top"><b>Invicta Agent Portal</b><div class="row"><span id="agentPill" class="muted">Signed out</span><button id="logoutBtn" type="button" class="red hidden">Logout</button></div></div><main class="wrap"><section id="loginCard" class="card login"><h1>Agent Login</h1><p class="muted">Enter the email address your admin added under Agents.</p><input id="emailInput" type="email" placeholder="agent@example.com" autocomplete="email"/><div class="row" style="margin-top:12px"><button id="loginBtn" type="button">Login</button><a href="/admin" class="muted">Admin</a></div><div id="loginError" class="error"></div></section><section id="dashboard" class="hidden"><div class="toolbar"><div><h1 id="welcomeTitle">Agent Dashboard</h1><p id="agencyLine" class="muted">Loading...</p></div><div class="filters"><label class="muted">Min grade</label><select id="minGrade"><option>A+</option><option>A</option><option selected>B</option><option>C</option><option>D</option></select><label class="muted"><input id="readyOnly" type="checkbox" style="width:auto;min-height:0"/> Ready only</label><button id="refreshBtn" type="button" class="gray">Refresh leads</button></div></div><div class="grid"><div class="card"><div class="num" id="leadCount">-</div><div class="muted">Visible leads</div></div><div class="card"><div class="num" id="readyCount">-</div><div class="muted">Sales ready</div></div><div class="card"><div class="num" id="hotCount">-</div><div class="muted">A-grade leads</div></div></div><div id="leadStatus" class="muted">Loading leads...</div><div id="leadGrid" class="leadGrid"></div></section></main><script>(function(){var KEY='FMCSA_AGENT_TOKEN',token=localStorage.getItem(KEY)||'',agent=null;function id(x){return document.getElementById(x)}function esc(v){return String(v==null?'':v).replace(/[&<>\"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]})}function arr(v){return Array.isArray(v)?v:[]}function auth(){return {'content-type':'application/json','authorization':'Bearer '+token}}async function api(p,o){var r=await fetch(p,o||{}),raw=await r.text(),d;try{d=raw?JSON.parse(raw):{}}catch(e){d={raw:raw}}if(!r.ok)throw new Error(d.error||raw||('Request failed '+r.status));return d}function showLogin(msg){id('dashboard').classList.add('hidden');id('loginCard').classList.remove('hidden');id('logoutBtn').classList.add('hidden');id('agentPill').textContent='Signed out';id('loginError').textContent=msg||''}function showDash(){id('loginCard').classList.add('hidden');id('dashboard').classList.remove('hidden');id('logoutBtn').classList.remove('hidden')}function renderAgent(){id('agentPill').textContent=agent?'Signed in: '+agent.agentName:'Signed in';id('welcomeTitle').textContent=agent?'Welcome, '+agent.agentName:'Agent Dashboard';id('agencyLine').textContent=agent?(agent.agencyName||agent.agencyKey||'Agency')+' · '+(agent.email||'No email'):''}async function login(){id('loginError').textContent='';var email=id('emailInput').value.trim();if(!email){id('loginError').textContent='Enter your agent email.';return}try{var d=await api('/api/agent/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:email})});token=d.token;localStorage.setItem(KEY,token);agent=d.agent;renderAgent();showDash();await loadLeads()}catch(e){id('loginError').textContent=e.message||String(e)}}async function boot(){if(!token){showLogin('');return}try{var d=await api('/api/agent/me',{headers:auth()});agent=d.agent;renderAgent();showDash();await loadLeads()}catch(e){localStorage.removeItem(KEY);token='';showLogin('Session expired. Log in again.')}}function leadTitle(l){return l.dbaName||l.legalName||('USDOT '+l.usdotNumber)}function renderLeads(leads){id('leadGrid').innerHTML='';var ready=leads.filter(function(l){return l.salesReady}).length,hot=leads.filter(function(l){return l.leadGrade==='A+'||l.leadGrade==='A'}).length;id('leadCount').textContent=leads.length;id('readyCount').textContent=ready;id('hotCount').textContent=hot;id('leadStatus').textContent=leads.length?'Showing '+leads.length+' leads.':'No leads match this filter.';leads.forEach(function(l){var contact=l.decisionMakerName||l.personalizationName||'';var products=arr(l.recommendedProducts).join(', ');var reasons=arr(l.scoringReasons).slice(0,3).join(' · ');var div=document.createElement('div');div.className='lead';div.innerHTML='<div class="row"><span class="badge grade">Grade '+esc(l.leadGrade)+' · '+esc(l.leadScore)+'</span>'+(l.salesReady?'<span class="badge ready">Sales ready</span>':'<span class="badge">Research</span>')+'</div><h3>'+esc(leadTitle(l))+'</h3><div class="meta">USDOT '+esc(l.usdotNumber)+' · '+esc(l.city||'')+', '+esc(l.state||'')+'</div><div class="meta">Units: '+esc(l.powerUnits||'N/A')+' · Drivers: '+esc(l.drivers||'N/A')+'</div><div class="reason"><b>Decision maker:</b> '+esc(contact||'not verified yet')+'<br>Email: '+esc(l.decisionMakerEmail||l.carrierEmail||'N/A')+'<br>Phone: '+esc(l.decisionMakerPhone||l.carrierPhone||'N/A')+'</div><div class="reason"><b>Angle:</b> '+esc(l.outreachAngle||'Commercial trucking insurance review')+'<br><b>Products:</b> '+esc(products||'P&C, Life, Health')+'</div><div class="reason">'+esc(reasons||l.salesReadyReason||'No scoring notes available.')+'</div>';id('leadGrid').appendChild(div)})}async function loadLeads(){id('leadStatus').textContent='Loading leads...';id('leadGrid').innerHTML='';try{var d=await api('/api/agent/leads?limit=100&minGrade='+encodeURIComponent(id('minGrade').value)+'&qualityGate='+(id('readyOnly').checked?'true':'false'),{headers:auth()});renderLeads(d.leads||[])}catch(e){id('leadStatus').textContent='Failed to load leads: '+(e.message||String(e))}}id('loginBtn').addEventListener('click',login);id('emailInput').addEventListener('keydown',function(e){if(e.key==='Enter')login()});id('refreshBtn').addEventListener('click',loadLeads);id('minGrade').addEventListener('change',loadLeads);id('readyOnly').addEventListener('change',loadLeads);id('logoutBtn').addEventListener('click',function(){localStorage.removeItem(KEY);token='';agent=null;showLogin('')});boot()})();</script></body></html>`;
}

app.get('/admin', (_req, res) => res.type('html').send(adminPageHtml()));
app.get('/agent', (_req, res) => res.type('html').send(agentPageHtml()));
app.get('/agent/login', (_req, res) => res.type('html').send(agentPageHtml()));

app.post('/api/agent/login', async (req, res, next) => {
  try {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    if (!email) return res.status(400).json({ ok: false, error: 'Agent email is required.' });

    const agent = await findAgentByEmail(email);
    if (!agent) return res.status(404).json({ ok: false, error: 'No active agent found for that email. Add the agent in Admin first.' });

    res.json({ ok: true, token: createAgentToken(agent), agent: publicAgent(agent) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/agent/me', async (req, res, next) => {
  try {
    const agent = await findAgentByRequest(req);
    if (!agent) return res.status(401).json({ ok: false, error: 'Unauthorized or expired agent session.' });
    res.json({ ok: true, agent: publicAgent(agent) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/agent/leads', async (req, res, next) => {
  try {
    const agent = await findAgentByRequest(req);
    if (!agent) return res.status(401).json({ ok: false, error: 'Unauthorized or expired agent session.' });

    const limit = Math.min(250, Number.parseInt(String(req.query.limit ?? 100), 10) || 100);
    const minGrade = String(req.query.minGrade ?? 'B');
    const qualityGate = boolQuery(req.query.qualityGate);
    const leads = await getAgentLeads(limit, minGrade, qualityGate);

    res.json({ ok: true, agent: publicAgent(agent), count: leads.length, leads: leads.map(publicLead) });
  } catch (error) {
    next(error);
  }
});

app.get('/admin/overview', requireAdmin, async (_req, res, next) => {
  try {
    await ensureAdminTables();

    const [agencyCount, agentCount, carrierCount, leadCount, hotLeadCount, readyLeadCount, importRunCount, registryPullCount, imports, registry, agencies, agents] = await Promise.all([
      safeCount('insurance_agencies', "status = 'ACTIVE'"),
      safeCount('insurance_agents', "status = 'ACTIVE'"),
      safeCount('fmcsa_carriers'),
      safeCount('insurance_leads'),
      safeCount('insurance_leads', "lead_grade in ('A+', 'A')"),
      safeCount('insurance_leads', 'sales_ready = true'),
      safeCount('import_runs'),
      safeCount('state_registry_matches'),
      recentImports(),
      recentRegistryPulls(),
      listAgencies(),
      listAgents(),
    ]);

    const recentPulls = [
      ...imports.map((row) => ({ source: row.source ?? 'FMCSA', details: `fetched ${row.fetched_count ?? 0}, inserted ${row.inserted_count ?? 0}, updated ${row.updated_count ?? 0}`, date: row.started_at })),
      ...registry.map((row) => ({ source: `${row.source_name ?? 'STATE'} ${row.state_code ?? ''}`.trim(), details: `${row.search_name ?? row.matched_name ?? 'registry pull'} - ${row.entity_status ?? 'unknown'}`, date: row.created_at })),
    ].sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? ''))).slice(0, 8);

    res.json({
      ok: true,
      admin: { signedInAs: 'Verified administrator', role: 'System Administrator', agencyName: 'Invicta Capital Group', agencyId: config.defaultAgencyId },
      integrations: { adminApiKeyConfigured: Boolean(config.adminApiKey), arkonWebhookConfigured: Boolean(config.arkonWebhookUrl), googleSheetsWebhookConfigured: Boolean(config.googleSheetsWebhookUrl), txComptrollerKeyConfigured: Boolean(config.txComptrollerApiKey) },
      metrics: { agencies: { active: agencyCount }, agents: { active: agentCount }, apiPulls: { total: importRunCount + registryPullCount, importRuns: importRunCount, registryPulls: registryPullCount }, carriers: carrierCount, leads: { total: leadCount, hot: hotLeadCount, salesReady: readyLeadCount } },
      recentPulls,
      agencies,
      agents,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/admin/agencies', requireAdmin, async (req, res, next) => {
  try {
    await ensureAdminTables();
    const agencyName = String(req.body?.agencyName ?? req.body?.name ?? '').trim();
    if (!agencyName) return res.status(400).json({ ok: false, error: 'agencyName is required.' });

    const agencyKey = slug(req.body?.agencyKey ?? agencyName);
    const result = await query(`insert into insurance_agencies (
        agency_key, agency_name, legal_name, display_name, brand_name, service_area, website_url, logo_url, primary_color, accent_color, lines_of_business, status
      ) values ($1,$2,$2,$2,$3,$4,$5,$6,$7,$8,array['Property & Casualty','Life','Health']::text[],'ACTIVE')
      on conflict (agency_key) do update set agency_name = excluded.agency_name, legal_name = excluded.legal_name, display_name = excluded.display_name, brand_name = excluded.brand_name, service_area = excluded.service_area, website_url = excluded.website_url, logo_url = excluded.logo_url, primary_color = excluded.primary_color, accent_color = excluded.accent_color, status = 'ACTIVE', updated_at = now()
      returning *`, [agencyKey, agencyName, text(req.body?.brandName) ?? agencyName, text(req.body?.serviceArea) ?? 'Nationwide', text(req.body?.websiteUrl), text(req.body?.logoUrl), color(req.body?.primaryColor, '#2563eb'), color(req.body?.accentColor, '#22c55e')]);

    res.json({ ok: true, agency: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

app.post('/admin/agents', requireAdmin, async (req, res, next) => {
  try {
    await ensureAdminTables();
    const agentName = String(req.body?.agentName ?? req.body?.name ?? '').trim();
    if (!agentName) return res.status(400).json({ ok: false, error: 'agentName is required.' });

    const email = String(req.body?.email ?? '').trim();
    const agentKey = slug(req.body?.agentKey ?? (email || agentName));
    const result = await query(`insert into insurance_agents (agent_key, agency_key, agent_name, email, phone, role, status, lines_of_business)
      values ($1,$2,$3,$4,$5,$6,'ACTIVE',array['Property & Casualty','Life','Health']::text[])
      on conflict (agent_key) do update set agency_key = excluded.agency_key, agent_name = excluded.agent_name, email = excluded.email, phone = excluded.phone, role = excluded.role, status = 'ACTIVE', updated_at = now()
      returning *`, [agentKey, String(req.body?.agencyKey ?? config.defaultAgencyId), agentName, email || null, String(req.body?.phone ?? '').trim() || null, String(req.body?.role ?? 'AGENT')]);

    res.json({ ok: true, agent: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

app.get('/admin/config/status', requireAdmin, (_req, res) => res.json({ ok: true, admin: { signedInAs: 'Verified administrator', role: 'System Administrator', agencyName: 'Invicta Capital Group', agencyId: config.defaultAgencyId }, integrations: { adminApiKeyConfigured: Boolean(config.adminApiKey), arkonWebhookConfigured: Boolean(config.arkonWebhookUrl), googleSheetsWebhookConfigured: Boolean(config.googleSheetsWebhookUrl), txComptrollerKeyConfigured: Boolean(config.txComptrollerApiKey) } }));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'fmcsa-insurance-leads' }));
app.get('/scoring/rules', (_req, res) => res.json({ ok: true, scoring: publicScoringRules() }));

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

app.post('/admin/db/init', requireAdmin, async (_req, res, next) => { try { await initSchema(); await ensureAdminTables(); res.json({ ok: true }); } catch (error) { next(error); } });
app.post('/admin/import', requireAdmin, async (req, res, next) => { try { const source = (req.body?.source ?? config.defaultImportSource) as ImportSource; const limit = Number.parseInt(String(req.body?.limit ?? config.importLimit), 10); const result = await importFmcsa(source, Number.isFinite(limit) ? limit : config.importLimit); res.json({ ok: true, result }); } catch (error) { next(error); } });
app.post('/admin/score/refresh', requireAdmin, async (_req, res, next) => { try { const result = await refreshScores(); res.json({ ok: true, result }); } catch (error) { next(error); } });
app.get('/admin/enrichment/sources', requireAdmin, async (_req, res, next) => { try { const sources = await getEnrichmentSources(); res.json({ ok: true, sources }); } catch (error) { next(error); } });

app.post('/admin/enrich/state-records', requireAdmin, async (req, res, next) => {
  try {
    const records = registryInputsFromBody(req.body);
    if (!records.length) return res.status(400).json({ ok: false, error: 'Provide stateCode, sourceName, and record or records[].' });
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
    const result = await enrichTexasCarriers({ limit: Number.isFinite(limit) ? limit : config.texasEnrichmentLimit, usdotNumbers: stringArray(req.body?.usdotNumbers ?? req.body?.usdotNumber), records: Array.isArray(req.body?.records) ? req.body.records : undefined });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/admin/enrich/fl', requireAdmin, async (req, res, next) => {
  try {
    const limit = Number.parseInt(String(req.body?.limit ?? 25), 10);
    const result = await enrichFloridaCarriers({ limit: Number.isFinite(limit) ? limit : 25, usdotNumbers: stringArray(req.body?.usdotNumbers ?? req.body?.usdotNumber), records: Array.isArray(req.body?.records) ? req.body.records : undefined });
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

app.post('/admin/export/arkon', requireAdmin, async (req, res, next) => { try { const result = await exportToArkon(Number(req.body?.limit ?? 100), String(req.body?.minGrade ?? 'B')); res.json({ ok: true, result }); } catch (error) { next(error); } });
app.post('/admin/export/sheets', requireAdmin, async (req, res, next) => { try { const result = await exportToSheets(Number(req.body?.limit ?? 100), String(req.body?.minGrade ?? 'B')); res.json({ ok: true, result }); } catch (error) { next(error); } });

app.get('/stats', async (_req, res, next) => {
  try {
    const result = await query(`select
      (select count(*)::int from fmcsa_carriers) as carriers,
      (select count(*)::int from insurance_leads) as leads,
      (select count(*)::int from insurance_leads where lead_grade in ('A+', 'A')) as hot_leads,
      (select count(*)::int from insurance_leads where sales_ready = true) as sales_ready_leads,
      (select max(started_at) from import_runs) as last_import_at`);
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
