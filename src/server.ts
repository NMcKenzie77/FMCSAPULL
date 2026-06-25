import express from 'express';
import { config, type ImportSource } from './config.js';
import { initSchema, query } from './db.js';
import { importFmcsa, refreshScores } from './importer.js';
import { exportToArkon, exportToSheets, getTopLeads } from './export/webhooks.js';
import { publicScoringRules } from './leads/scoringRules.js';
import { checkSocrataDataset } from './fmcsa/socrata.js';
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
