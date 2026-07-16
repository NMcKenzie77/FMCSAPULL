import { config, datasetForSource, type ImportSource } from '../config.js';

export type SocrataRecord = Record<string, unknown>;

export interface FetchOptions {
  source: ImportSource;
  limit?: number;
  offset?: number;
  where?: string;
  order?: string;
}

export interface DatasetCheckResult {
  source: ImportSource;
  datasetId: string;
  url: string;
  ok: boolean;
  status?: number;
  statusText?: string;
  sampleCount?: number;
  error?: string;
}

function requestHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': 'FMCSAPULL insurance lead importer/0.2'
  };
  if (config.socrataAppToken) headers['x-app-token'] = config.socrataAppToken;
  return headers;
}

function effectiveApiSource(source: ImportSource): ImportSource {
  // Backward compatibility: old jobs and buttons may still send carrier-daily.
  // The current Company Census dataset is the reliable daily-updated JSON feed.
  return source === 'carrier-daily' ? 'company-census' : source;
}

function ensureJsonImportSource(source: ImportSource): ImportSource {
  const effectiveSource = effectiveApiSource(source);
  if (effectiveSource === 'carrier-all-history') {
    throw new Error('carrier-all-history is now published as a bulk text download. Use company-census for lead imports.');
  }
  return effectiveSource;
}

export function socrataResourceUrl(datasetId: string): string {
  return `${config.dataHost}/resource/${datasetId}.json`;
}

export async function checkSocrataDataset(source: ImportSource): Promise<DatasetCheckResult> {
  const effectiveSource = effectiveApiSource(source);
  const datasetId = datasetForSource(effectiveSource);

  if (effectiveSource === 'carrier-all-history') {
    const url = `${config.dataHost}/download/${datasetId}/text/plain`;
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'text/plain,*/*',
          'user-agent': 'FMCSAPULL insurance lead importer/0.2',
          range: 'bytes=0-2047'
        },
        redirect: 'follow'
      });
      const sample = await response.text().catch(() => '');
      return {
        source,
        datasetId,
        url,
        ok: response.ok && sample.trim().length > 0,
        status: response.status,
        statusText: response.statusText,
        sampleCount: sample.trim() ? 1 : 0,
        error: response.ok ? undefined : sample.slice(0, 500)
      };
    } catch (error) {
      return {
        source,
        datasetId,
        url,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  const url = new URL(socrataResourceUrl(datasetId));
  url.searchParams.set('$limit', '1');
  url.searchParams.set('$order', 'dot_number DESC');

  try {
    const response = await fetch(url, { headers: requestHeaders() });
    const body = await response.text().catch(() => '');
    if (!response.ok) {
      return {
        source,
        datasetId,
        url: url.toString(),
        ok: false,
        status: response.status,
        statusText: response.statusText,
        error: body.slice(0, 500)
      };
    }

    const json = JSON.parse(body || '[]') as unknown;
    return {
      source,
      datasetId,
      url: url.toString(),
      ok: Array.isArray(json),
      status: response.status,
      statusText: response.statusText,
      sampleCount: Array.isArray(json) ? json.length : undefined,
      error: Array.isArray(json) ? undefined : 'Socrata response was not an array.'
    };
  } catch (error) {
    return {
      source,
      datasetId,
      url: url.toString(),
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function fetchSocrataPage(options: FetchOptions): Promise<SocrataRecord[]> {
  const source = ensureJsonImportSource(options.source);
  const datasetId = datasetForSource(source);
  const url = new URL(socrataResourceUrl(datasetId));
  url.searchParams.set('$limit', String(options.limit ?? 1000));
  url.searchParams.set('$offset', String(options.offset ?? 0));
  if (options.where) url.searchParams.set('$where', options.where);
  url.searchParams.set('$order', options.order ?? 'dot_number DESC');

  const response = await fetch(url, { headers: requestHeaders() });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`FMCSA Company Census request failed ${response.status} ${response.statusText}: ${body.slice(0, 500)}`);
  }

  const json = await response.json();
  if (!Array.isArray(json)) {
    throw new Error('FMCSA Company Census response was not an array.');
  }
  return json as SocrataRecord[];
}

export async function fetchSocrataRecords(source: ImportSource, totalLimit: number): Promise<SocrataRecord[]> {
  const effectiveSource = ensureJsonImportSource(source);
  const pageSize = Math.min(50000, Math.max(1, totalLimit));
  const records: SocrataRecord[] = [];
  let offset = 0;

  while (records.length < totalLimit) {
    const remaining = totalLimit - records.length;
    const page = await fetchSocrataPage({
      source: effectiveSource,
      limit: Math.min(pageSize, remaining),
      offset,
      order: 'dot_number DESC'
    });

    records.push(...page);
    if (page.length === 0 || page.length < Math.min(pageSize, remaining)) break;
    offset += page.length;
  }

  return records;
}
