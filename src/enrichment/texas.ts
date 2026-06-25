import { config } from '../config.js';
import { ingestStateRegistryRecords, listCarrierTargetsForState } from './service.js';
import type { EnrichmentRunResult, StateRegistryRecordInput } from './registryTypes.js';

interface TexasSearchResult {
  companyName: string;
  records: Record<string, unknown>[];
  warning?: string;
}

function companySearchName(carrier: { legal_name: string | null; dba_name: string | null; usdot_number: string | null }): string | null {
  return carrier.legal_name || carrier.dba_name || (carrier.usdot_number ? `USDOT ${carrier.usdot_number}` : null);
}

function apiBaseUrl(): string {
  return config.txComptrollerApiBaseUrl.replace(/\/+$/, '');
}

function texasUrl(path: string, params?: Record<string, string | number | null | undefined>): string {
  const url = new URL(`${apiBaseUrl()}${path}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null && String(value).trim()) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function headers(): HeadersInit {
  return {
    accept: 'application/json',
    'x-api-key': config.txComptrollerApiKey
  };
}

function clean(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length ? text : null;
}

function extractRecords(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)));
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  for (const key of ['data', 'results', 'items', 'entities', 'taxpayers', 'records']) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)));
    }
  }
  return [record];
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = clean(record[key]);
    if (value) return value;
  }
  return null;
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: headers() });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Texas Comptroller API returned ${response.status}: ${body.slice(0, 400)}`);
  }
  return response.json() as Promise<unknown>;
}

async function searchFranchiseTaxList(companyName: string): Promise<Record<string, unknown>[]> {
  const payload = await getJson(texasUrl('/franchise-tax-list', { name: companyName }));
  return extractRecords(payload);
}

async function getFranchiseAccountDetails(taxpayerId: string): Promise<Record<string, unknown> | null> {
  const normalized = taxpayerId.replace(/\D/g, '');
  if (!/^\d{11}$/.test(normalized)) return null;
  const payload = await getJson(texasUrl(`/franchise-tax/${normalized}`));
  const records = extractRecords(payload);
  return records[0] ?? null;
}

function mergedTexasRecord(summary: Record<string, unknown>, detail: Record<string, unknown> | null): Record<string, unknown> {
  if (!detail) return summary;
  return {
    ...summary,
    ...detail,
    txSearchSummary: summary
  };
}

async function searchTexasRegistry(companyName: string): Promise<TexasSearchResult> {
  if (!config.txComptrollerApiKey) {
    return { companyName, records: [], warning: 'TX_COMPTROLLER_API_KEY is not configured in Railway.' };
  }

  const summaries = await searchFranchiseTaxList(companyName);
  if (!summaries.length) return { companyName, records: [] };

  const records: Record<string, unknown>[] = [];
  const warnings: string[] = [];

  for (const summary of summaries.slice(0, 5)) {
    const taxpayerId = firstString(summary, ['taxpayerId', 'taxpayerID', 'taxpayer_id', 'TAXPAYER_ID']);
    if (!taxpayerId) {
      records.push(summary);
      continue;
    }

    try {
      const detail = await getFranchiseAccountDetails(taxpayerId);
      records.push(mergedTexasRecord(summary, detail));
      if (!detail) warnings.push(`Texas summary for ${companyName} returned taxpayerId ${taxpayerId}, but it was not an 11-digit detail ID.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Texas detail lookup failed for ${companyName} taxpayerId ${taxpayerId}: ${message}`);
      records.push(summary);
    }
  }

  return { companyName, records, warning: warnings.length ? warnings.join(' | ') : undefined };
}

export async function enrichTexasCarriers(options: { limit?: number; usdotNumbers?: string[]; records?: Record<string, unknown>[] } = {}): Promise<EnrichmentRunResult> {
  const sourceName = 'TX_COMPTROLLER';
  const directRecords = options.records ?? [];
  const singleUsdot = options.usdotNumbers?.length === 1 ? options.usdotNumbers[0] : null;
  if (directRecords.length) {
    return ingestStateRegistryRecords(directRecords.map((raw): StateRegistryRecordInput => ({
      stateCode: 'TX',
      sourceName,
      searchName: null,
      usdotNumber: singleUsdot,
      raw
    })));
  }

  const limit = Math.max(1, Math.min(100, options.limit ?? config.texasEnrichmentLimit));
  const carriers = await listCarrierTargetsForState('TX', limit, options.usdotNumbers ?? []);
  const registryInputs: StateRegistryRecordInput[] = [];
  const warnings: string[] = [];

  for (const carrier of carriers) {
    const searchName = companySearchName(carrier);
    if (!searchName) {
      warnings.push(`Skipping carrier ${carrier.usdot_number ?? carrier.id}: no searchable company name.`);
      continue;
    }

    const search = await searchTexasRegistry(searchName);
    if (search.warning) warnings.push(search.warning);
    if (!search.records.length) {
      warnings.push(`No Texas Comptroller records returned for ${searchName}.`);
      continue;
    }

    for (const raw of search.records) {
      registryInputs.push({
        stateCode: 'TX',
        sourceName,
        searchName,
        carrierId: Number(carrier.id),
        usdotNumber: carrier.usdot_number,
        legalName: carrier.legal_name ?? carrier.dba_name,
        raw
      });
    }
  }

  if (!registryInputs.length) {
    return {
      ok: true,
      sourceName,
      stateCode: 'TX',
      attempted: carriers.length,
      enriched: 0,
      skipped: carriers.length,
      results: [],
      warnings
    };
  }

  const result = await ingestStateRegistryRecords(registryInputs);
  result.warnings.unshift(...warnings);
  return result;
}
