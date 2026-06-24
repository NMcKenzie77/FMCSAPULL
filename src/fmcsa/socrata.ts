import { config, datasetForSource, type ImportSource } from '../config.js';

export type SocrataRecord = Record<string, unknown>;

export interface FetchOptions {
  source: ImportSource;
  limit?: number;
  offset?: number;
  where?: string;
}

export function socrataResourceUrl(datasetId: string): string {
  return `${config.dataHost}/resource/${datasetId}.json`;
}

export async function fetchSocrataPage(options: FetchOptions): Promise<SocrataRecord[]> {
  const datasetId = datasetForSource(options.source);
  const url = new URL(socrataResourceUrl(datasetId));
  url.searchParams.set('$limit', String(options.limit ?? 1000));
  url.searchParams.set('$offset', String(options.offset ?? 0));
  if (options.where) url.searchParams.set('$where', options.where);

  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'FMCSAPULL insurance lead importer/0.1'
    }
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Socrata request failed ${response.status} ${response.statusText}: ${body.slice(0, 500)}`);
  }

  const json = await response.json();
  if (!Array.isArray(json)) {
    throw new Error('Socrata response was not an array.');
  }
  return json as SocrataRecord[];
}

export async function fetchSocrataRecords(source: ImportSource, totalLimit: number): Promise<SocrataRecord[]> {
  const pageSize = Math.min(50000, Math.max(1, totalLimit));
  const records: SocrataRecord[] = [];
  let offset = 0;

  while (records.length < totalLimit) {
    const remaining = totalLimit - records.length;
    const page = await fetchSocrataPage({
      source,
      limit: Math.min(pageSize, remaining),
      offset
    });

    records.push(...page);
    if (page.length === 0 || page.length < Math.min(pageSize, remaining)) break;
    offset += page.length;
  }

  return records;
}
