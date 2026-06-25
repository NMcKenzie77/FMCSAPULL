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

function buildTexasSearchUrl(companyName: string): string {
  const base = config.txComptrollerApiUrl;
  const encoded = encodeURIComponent(companyName);
  if (base.includes('{name}')) return base.replaceAll('{name}', encoded);
  if (base.includes('{query}')) return base.replaceAll('{query}', encoded);
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}search=${encoded}`;
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

async function searchTexasRegistry(companyName: string): Promise<TexasSearchResult> {
  if (!config.txComptrollerApiKey) {
    return { companyName, records: [], warning: 'TX_COMPTROLLER_API_KEY is not configured in Railway.' };
  }
  if (!config.txComptrollerApiUrl) {
    return { companyName, records: [], warning: 'TX_COMPTROLLER_API_URL is not configured in Railway.' };
  }

  const response = await fetch(buildTexasSearchUrl(companyName), {
    headers: {
      accept: 'application/json',
      'x-api-key': config.txComptrollerApiKey
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Texas registry API returned ${response.status}: ${body.slice(0, 400)}`);
  }

  const payload = await response.json() as unknown;
  return { companyName, records: extractRecords(payload) };
}

export async function enrichTexasCarriers(options: { limit?: number; usdotNumbers?: string[]; records?: Record<string, unknown>[] } = {}): Promise<EnrichmentRunResult> {
  const sourceName = 'TX_COMPTROLLER';
  const directRecords = options.records ?? [];
  if (directRecords.length) {
    return ingestStateRegistryRecords(directRecords.map((raw): StateRegistryRecordInput => ({
      stateCode: 'TX',
      sourceName,
      searchName: null,
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
    if (search.warning) {
      warnings.push(search.warning);
      continue;
    }
    if (!search.records.length) {
      warnings.push(`No Texas registry records returned for ${searchName}.`);
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
