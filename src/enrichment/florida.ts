import { ingestStateRegistryRecords, listCarrierTargetsForState } from './service.js';
import type { EnrichmentRunResult, StateRegistryRecordInput } from './registryTypes.js';

const SOURCE_NAME = 'FL_SUNBIZ';
const STATE_CODE = 'FL';
const SUNBIZ_BASE_URL = 'https://search.sunbiz.org';

interface FloridaSearchResult {
  companyName: string;
  records: Record<string, unknown>[];
  warning?: string;
}

interface SearchCandidate {
  detailUrl: string;
  rowText: string;
  score: number;
}

function clean(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length ? text : null;
}

function companySearchName(carrier: { legal_name: string | null; dba_name: string | null; usdot_number: string | null }): string | null {
  return carrier.legal_name || carrier.dba_name || (carrier.usdot_number ? `USDOT ${carrier.usdot_number}` : null);
}

function normalizeName(value: string): string {
  return value.toUpperCase().replace(/&/g, ' AND ').replace(/[^A-Z0-9]+/g, ' ').trim();
}

function nameOrder(value: string): string {
  return normalizeName(value).replace(/\s+/g, '');
}

function htmlDecode(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function htmlToLines(html: string): string[] {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|td|th|tr|h1|h2|h3|h4|label)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return htmlDecode(text)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function absoluteUrl(value: string): string {
  if (value.startsWith('http')) return value;
  return `${SUNBIZ_BASE_URL}${value.startsWith('/') ? '' : '/'}${value}`;
}

function searchUrl(companyName: string): string {
  const term = encodeURIComponent(companyName);
  return `${SUNBIZ_BASE_URL}/Inquiry/CorporationSearch/SearchResults/EntityName/${term}/Page1?searchNameOrder=${nameOrder(companyName)}`;
}

function candidateScore(rowText: string, companyName: string): number {
  const row = normalizeName(rowText);
  const company = normalizeName(companyName);
  let score = 0;
  if (row.includes(company)) score += 80;
  for (const token of company.split(' ').filter((item) => item.length > 2)) {
    if (row.includes(token)) score += 4;
  }
  if (/\bACTIVE\b/.test(row)) score += 10;
  if (/\bINACTIVE\b/.test(row)) score -= 10;
  if (/TRADEMARK|FICTITIOUS/.test(row)) score -= 20;
  return score;
}

function extractSearchCandidates(html: string, companyName: string): SearchCandidate[] {
  const candidates: SearchCandidate[] = [];
  const rowRegex = /<tr[\s\S]*?<\/tr>/gi;
  const linkRegex = /href="([^"]*SearchResultDetail[^"]*)"/i;
  const rows = html.match(rowRegex) ?? [];

  for (const row of rows) {
    const link = row.match(linkRegex)?.[1];
    if (!link) continue;
    const rowText = htmlToLines(row).join(' ');
    candidates.push({
      detailUrl: absoluteUrl(htmlDecode(link)),
      rowText,
      score: candidateScore(rowText, companyName)
    });
  }

  if (!candidates.length) {
    const linkMatches = html.matchAll(/href="([^"]*SearchResultDetail[^"]*)"/gi);
    for (const match of linkMatches) {
      const detailUrl = absoluteUrl(htmlDecode(match[1]));
      candidates.push({ detailUrl, rowText: '', score: 1 });
    }
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, 3);
}

async function getText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'user-agent': 'InvictaProtectionLeadEnrichment/1.0 (+internal commercial insurance enrichment)'
    }
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Florida Sunbiz returned ${response.status}: ${body.slice(0, 300)}`);
  }
  return response.text();
}

function findAfter(lines: string[], label: string): string | null {
  const normalizedLabel = label.toLowerCase();
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].toLowerCase() === normalizedLabel) {
      for (let j = i + 1; j < lines.length; j += 1) {
        const value = clean(lines[j]);
        if (value && value.toLowerCase() !== normalizedLabel) return value;
      }
    }
  }
  return null;
}

function findBetween(lines: string[], starts: string[], stops: string[]): string[] {
  const startIndex = lines.findIndex((line) => starts.some((start) => line.toLowerCase() === start.toLowerCase()));
  if (startIndex < 0) return [];
  const output: string[] = [];
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    if (stops.some((stop) => lines[i].toLowerCase() === stop.toLowerCase())) break;
    output.push(lines[i]);
  }
  return output.filter(Boolean);
}

function parseCityStateZip(line: string): { city: string | null; state: string | null; zip: string | null } | null {
  const commaMatch = line.match(/^(.+?),\s*([A-Z]{2})\s+([A-Z0-9-]{5,12})$/i);
  if (commaMatch) return { city: clean(commaMatch[1]), state: commaMatch[2].toUpperCase(), zip: clean(commaMatch[3]) };

  const simpleMatch = line.match(/^(.+?)\s+([A-Z]{2})\s+([A-Z0-9-]{5,12})$/i);
  if (simpleMatch) return { city: clean(simpleMatch[1]), state: simpleMatch[2].toUpperCase(), zip: clean(simpleMatch[3]) };
  return null;
}

function parseAddressBlock(block: string[]): { street: string | null; city: string | null; state: string | null; zip: string | null; fullAddress: string | null } {
  const cleaned = block
    .map(clean)
    .filter((item): item is string => Boolean(item))
    .filter((item) => !['Name & Address', 'Principal Address', 'Mailing Address'].includes(item));

  let city: string | null = null;
  let state: string | null = null;
  let zip: string | null = null;
  const streetLines: string[] = [];

  for (const line of cleaned) {
    const parsed = parseCityStateZip(line);
    if (parsed) {
      city = parsed.city;
      state = parsed.state;
      zip = parsed.zip;
    } else if (!/^Title\s+/i.test(line)) {
      streetLines.push(line);
    }
  }

  const street = streetLines.length ? streetLines.join(' ') : null;
  const fullAddress = [street, city, state, zip].filter(Boolean).join(', ') || null;
  return { street, city, state, zip, fullAddress };
}

function parseRegisteredAgent(lines: string[]): { name: string | null; address: ReturnType<typeof parseAddressBlock> } {
  const block = findBetween(lines, ['Registered Agent Name & Address'], ['Officer/Director Detail', 'Authorized Person(s) Detail', 'Annual Reports', 'Document Images']);
  const cleaned = block.map(clean).filter((item): item is string => Boolean(item));
  const name = cleaned[0] ?? null;
  return { name, address: parseAddressBlock(cleaned.slice(1)) };
}

function titleName(value: string): string {
  const code = value.replace(/^Title\s+/i, '').trim().toUpperCase();
  const mapping: Record<string, string> = {
    P: 'President',
    T: 'Treasurer',
    C: 'Chairman',
    V: 'Vice President',
    S: 'Secretary',
    D: 'Director',
    MGR: 'Manager',
    AMBR: 'Authorized Member',
    MGRM: 'Managing Member',
    AP: 'Authorized Person',
    RA: 'Registered Agent'
  };
  return mapping[code] ?? code || value;
}

function parseOfficers(lines: string[]): Array<Record<string, unknown>> {
  const block = findBetween(lines, ['Officer/Director Detail', 'Authorized Person(s) Detail'], ['Annual Reports', 'Document Images', 'Events']);
  const officers: Array<Record<string, unknown>> = [];

  for (let i = 0; i < block.length; i += 1) {
    const line = block[i];
    if (!/^Title\s+/i.test(line)) continue;
    const title = titleName(line);
    const name = clean(block[i + 1]);
    if (!name) continue;

    const addressLines: string[] = [];
    for (let j = i + 2; j < block.length; j += 1) {
      if (/^Title\s+/i.test(block[j])) break;
      if (block[j] === 'Name & Address') continue;
      addressLines.push(block[j]);
    }
    const address = parseAddressBlock(addressLines);
    officers.push({
      name,
      title,
      address: address.fullAddress,
      city: address.city,
      state: address.state,
      zip: address.zip
    });
  }

  return officers;
}

function parseDetailHtml(html: string, detailUrl: string, searchName: string): Record<string, unknown> {
  const lines = htmlToLines(html);
  const principal = parseAddressBlock(findBetween(lines, ['Principal Address'], ['Mailing Address', 'Registered Agent Name & Address', 'Officer/Director Detail', 'Authorized Person(s) Detail', 'Annual Reports']));
  const mailing = parseAddressBlock(findBetween(lines, ['Mailing Address'], ['Registered Agent Name & Address', 'Officer/Director Detail', 'Authorized Person(s) Detail', 'Annual Reports']));
  const registeredAgent = parseRegisteredAgent(lines);
  const officers = parseOfficers(lines);

  const entityName = findAfter(lines, 'Detail by Entity Name') ?? findAfter(lines, 'Florida Profit Corporation') ?? findAfter(lines, 'Florida Limited Liability Company') ?? searchName;
  const status = findAfter(lines, 'Status');

  return {
    entity_name: entityName,
    entity_id: findAfter(lines, 'Document Number'),
    entity_status: status,
    right_to_transact: status && status.toLowerCase().includes('active') ? 'ACTIVE' : status,
    filing_type: findAfter(lines, 'Filing Information'),
    fei_number: findAfter(lines, 'FEI/EIN Number'),
    file_date: findAfter(lines, 'Date Filed'),
    registered_office_street: principal.street,
    registered_office_city: principal.city,
    registered_office_state: principal.state,
    registered_office_zip: principal.zip,
    mailing_address_street: mailing.street,
    mailing_address_city: mailing.city,
    mailing_address_state: mailing.state,
    mailing_address_zip: mailing.zip,
    registered_agent_name: registeredAgent.name,
    registered_agent_address: registeredAgent.address.fullAddress,
    officers,
    source_url: detailUrl,
    search_name: searchName,
    source: 'FL_SUNBIZ_SEARCH'
  };
}

async function searchFloridaRegistry(companyName: string): Promise<FloridaSearchResult> {
  const html = await getText(searchUrl(companyName));
  const candidates = extractSearchCandidates(html, companyName);
  if (!candidates.length) return { companyName, records: [], warning: `No Florida Sunbiz results returned for ${companyName}.` };

  const records: Record<string, unknown>[] = [];
  const warnings: string[] = [];

  for (const candidate of candidates) {
    try {
      const detailHtml = await getText(candidate.detailUrl);
      records.push(parseDetailHtml(detailHtml, candidate.detailUrl, companyName));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Florida Sunbiz detail lookup failed for ${companyName}: ${message}`);
    }
  }

  return { companyName, records, warning: warnings.length ? warnings.join(' | ') : undefined };
}

export async function enrichFloridaCarriers(options: { limit?: number; usdotNumbers?: string[]; records?: Record<string, unknown>[] } = {}): Promise<EnrichmentRunResult> {
  const directRecords = options.records ?? [];
  const singleUsdot = options.usdotNumbers?.length === 1 ? options.usdotNumbers[0] : null;
  if (directRecords.length) {
    return ingestStateRegistryRecords(directRecords.map((raw): StateRegistryRecordInput => ({
      stateCode: STATE_CODE,
      sourceName: SOURCE_NAME,
      searchName: null,
      usdotNumber: singleUsdot,
      raw
    })));
  }

  const limit = Math.max(1, Math.min(50, options.limit ?? 25));
  const carriers = await listCarrierTargetsForState(STATE_CODE, limit, options.usdotNumbers ?? []);
  const registryInputs: StateRegistryRecordInput[] = [];
  const warnings: string[] = [];

  for (const carrier of carriers) {
    const searchName = companySearchName(carrier);
    if (!searchName) {
      warnings.push(`Skipping carrier ${carrier.usdot_number ?? carrier.id}: no searchable company name.`);
      continue;
    }

    const search = await searchFloridaRegistry(searchName);
    if (search.warning) warnings.push(search.warning);
    if (!search.records.length) continue;

    for (const raw of search.records) {
      registryInputs.push({
        stateCode: STATE_CODE,
        sourceName: SOURCE_NAME,
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
      sourceName: SOURCE_NAME,
      stateCode: STATE_CODE,
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
