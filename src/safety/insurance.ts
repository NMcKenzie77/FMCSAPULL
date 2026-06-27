export type CarrierInsuranceFiling = {
  insuranceType: string | null;
  insuranceCarrier: string | null;
  policyNumber: string | null;
  effectiveDate: string | null;
  cancellationDate: string | null;
  formType: string | null;
  coverageFrom: string | null;
  coverageTo: string | null;
  rawRow: string[];
};

export type CarrierInsuranceProfile = {
  source: 'FMCSA_LI_PUBLIC';
  pulledAt: string;
  status: 'FOUND' | 'NO_FILING_FOUND' | 'SEARCH_BLOCKED' | 'ERROR';
  usdotNumber: string | null;
  docketNumber: string | null;
  docketPrefix: string | null;
  currentCarrier: string | null;
  currentPolicyNumber: string | null;
  currentFormType: string | null;
  effectiveDate: string | null;
  cancellationDate: string | null;
  filings: CarrierInsuranceFiling[];
  searchUrl: string;
  detailUrl: string | null;
  insuranceUrl: string | null;
  notes: string[];
  rawText: string;
};

type CarrierInput = {
  usdotNumber?: string | number | null;
  docketNumber?: string | number | null;
  docketPrefix?: string | null;
};

type HtmlResponse = { url: string; html: string; status: number };

const LI_BASE = 'https://li-public.fmcsa.dot.gov/LIVIEW/';

function clean(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#160;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || /^(none|n\/a|na|null|--|not available)$/i.test(cleaned)) return null;
  return cleaned;
}

function stripTags(html: string): string {
  return clean(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  ) || '';
}

function tableRows(html: string): string[][] {
  const rows: string[][] = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(html))) {
    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowMatch[1]))) {
      const value = clean(stripTags(cellMatch[1]));
      if (value) cells.push(value);
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

function absUrl(href: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  return new URL(href.replace(/^\//, ''), LI_BASE).toString();
}

function links(html: string): string[] {
  const values: string[] = [];
  const re = /href=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) values.push(absUrl(match[1]));
  return Array.from(new Set(values));
}

function parseApplicantId(html: string): string | null {
  return html.match(/pv_apcant_id=([0-9]+)/i)?.[1] || html.match(/p_apcant_id=([0-9]+)/i)?.[1] || null;
}

function endpoint(name: string, params?: URLSearchParams): string {
  return `${LI_BASE}${name}${params ? `?${params.toString()}` : ''}`;
}

function searchUrls(input: CarrierInput): string[] {
  const usdot = String(input.usdotNumber || '').replace(/\D/g, '');
  const docket = String(input.docketNumber || '').replace(/\D/g, '');
  const prefix = String(input.docketPrefix || 'MC').replace(/[^A-Z]/gi, '').toUpperCase() || 'MC';

  const variants: URLSearchParams[] = [];
  const add = (params: Record<string, string>) => variants.push(new URLSearchParams(params));

  if (usdot) {
    add({ p_dotno: usdot });
    add({ pn_dotno: usdot });
    add({ pv_dotno: usdot });
  }
  if (docket) {
    add({ pn_docketno: docket, pv_pref_docket: prefix });
    add({ p_docketno: docket, p_docketprefix: prefix });
    add({ pv_docket_prefix: prefix, pn_docketno: docket, pv_pref_docket: prefix });
  }

  const procedures = ['PKG_CARRQUERY.PRC_CARRLIST', 'pkg_carrquery.prc_carrlist'];
  return Array.from(new Set(procedures.flatMap((procedure) => variants.map((params) => endpoint(procedure, params)))));
}

function findInsuranceUrls(html: string, applicantId: string | null): string[] {
  const found = links(html).filter((url) => /insur|insurance|filing|carrierins/i.test(url));
  if (applicantId) {
    for (const procedure of [
      'PKG_CARRQUERY.PRC_ACTIVEINSURANCE',
      'PKG_CARRQUERY.PRC_INSURANCE',
      'PKG_CARRQUERY.PRC_INSDETAILS',
      'PKG_CARRQUERY.PRC_GETINSCARRIER',
      'pkg_carrquery.prc_activeinsurance',
      'pkg_carrquery.prc_insurance',
      'pkg_carrquery.prc_insdetails',
      'pkg_carrquery.prc_getinscarrier',
    ]) {
      found.push(endpoint(procedure, new URLSearchParams({ pv_apcant_id: applicantId })));
    }
  }
  return Array.from(new Set(found));
}

function parseDate(value: string | null): string | null {
  const cleaned = clean(value);
  if (!cleaned) return null;
  const mdy = cleaned.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
  const parsed = new Date(cleaned);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function looksLikeCarrier(value: string | null): boolean {
  if (!value) return false;
  if (/\b(BMC|POLICY|FORM|EFFECTIVE|CANCEL|COVERAGE|LIABILITY|DATE|TYPE)\b/i.test(value)) return false;
  return /\b(INSURANCE|CASUALTY|INDEMNITY|MUTUAL|UNDERWRITER|UNDERWRITERS|SURETY|FIRE|MARINE|PROPERTY|GENERAL|NATIONAL|COMPANY|CO\.?|CORP\.?|INC\.?)\b/i.test(value);
}

function parseFilingRow(row: string[]): CarrierInsuranceFiling | null {
  const joined = row.join(' | ');
  if (!/(BMC|insurance|liability|cargo|bond|surety|policy)/i.test(joined)) return null;

  const carrier = row.find(looksLikeCarrier) || null;
  const formType = row.find((cell) => /\bBMC[- ]?(91X?|34|84|85)\b/i.test(cell)) || joined.match(/\bBMC[- ]?(91X?|34|84|85)\b/i)?.[0] || null;
  const policyNumber = row.find((cell) => /[A-Z0-9][-A-Z0-9]{4,}/i.test(cell) && !looksLikeCarrier(cell) && !/BMC/i.test(cell)) || null;
  const dates = row.map(parseDate).filter((date): date is string => Boolean(date));

  return {
    insuranceType: row.find((cell) => /liability|cargo|bond|surety/i.test(cell)) || null,
    insuranceCarrier: carrier,
    policyNumber,
    effectiveDate: dates[0] || null,
    cancellationDate: dates.length > 1 ? dates[dates.length - 1] : null,
    formType,
    coverageFrom: row.find((cell) => /^\$?[\d,]+$/.test(cell)) || null,
    coverageTo: null,
    rawRow: row,
  };
}

function parseInsuranceHtml(html: string): { filings: CarrierInsuranceFiling[]; rawText: string } {
  const rawText = stripTags(html).slice(0, 12000);
  const parsedRows = tableRows(html).map(parseFilingRow).filter((row): row is CarrierInsuranceFiling => Boolean(row));
  if (parsedRows.length) return { filings: parsedRows, rawText };

  const textCarrier = rawText.match(/(?:Insurance Carrier|Carrier Name|Company Name)\s*:?\s*([A-Z0-9 &'.,()-]{4,80}?)(?:\s{2,}| Policy| Form| Effective|$)/i)?.[1];
  const formType = rawText.match(/\bBMC[- ]?(91X?|34|84|85)\b/i)?.[0] || null;
  if (textCarrier || formType) {
    return {
      rawText,
      filings: [{
        insuranceType: rawText.match(/(BI\s*&\s*PD|Bodily Injury|Property Damage|Cargo|Bond|Surety)/i)?.[1] || null,
        insuranceCarrier: clean(textCarrier),
        policyNumber: rawText.match(/Policy\s*(?:Number|No\.)?\s*:?\s*([A-Z0-9-]{4,})/i)?.[1] || null,
        effectiveDate: parseDate(rawText.match(/Effective\s*Date\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i)?.[1] || null),
        cancellationDate: parseDate(rawText.match(/Cancellation\s*Date\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i)?.[1] || null),
        formType,
        coverageFrom: null,
        coverageTo: null,
        rawRow: [rawText.slice(0, 800)],
      }],
    };
  }

  return { filings: [], rawText };
}

async function fetchHtml(url: string): Promise<HtmlResponse> {
  const response = await fetch(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'user-agent': 'ARKON-FMCSAPULL/1.0 carrier-li-profile',
    },
  });
  const html = await response.text();
  return { url, html, status: response.status };
}

async function fetchFirstAvailable(urls: string[], notes: string[]): Promise<HtmlResponse | null> {
  for (const url of urls) {
    try {
      const result = await fetchHtml(url);
      notes.push(`L&I probe ${result.status}: ${url}`);
      if (result.status >= 200 && result.status < 300) return result;
    } catch (error) {
      notes.push(`L&I probe failed: ${url} :: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return null;
}

export async function fetchCarrierInsuranceProfile(input: CarrierInput): Promise<CarrierInsuranceProfile> {
  const usdotNumber = String(input.usdotNumber || '').replace(/\D/g, '') || null;
  const docketNumber = String(input.docketNumber || '').replace(/\D/g, '') || null;
  const docketPrefix = input.docketPrefix || null;
  const pulledAt = new Date().toISOString();
  const notes: string[] = [];
  const urls = searchUrls(input);
  const searchResult = await fetchFirstAvailable(urls, notes);
  const searchUrl = searchResult?.url || urls[0] || LI_BASE;

  if (!searchResult) {
    return { source: 'FMCSA_LI_PUBLIC', pulledAt, status: 'ERROR', usdotNumber, docketNumber, docketPrefix, currentCarrier: null, currentPolicyNumber: null, currentFormType: null, effectiveDate: null, cancellationDate: null, filings: [], searchUrl, detailUrl: null, insuranceUrl: null, notes: ['No FMCSA L&I route returned HTTP 200.', ...notes], rawText: '' };
  }

  const searchHtml = searchResult.html;
  const searchText = stripTags(searchHtml);
  if (/challenge question|captcha|verification/i.test(searchText) && !/Insurance|BMC|Policy/i.test(searchText)) {
    return { source: 'FMCSA_LI_PUBLIC', pulledAt, status: 'SEARCH_BLOCKED', usdotNumber, docketNumber, docketPrefix, currentCarrier: null, currentPolicyNumber: null, currentFormType: null, effectiveDate: null, cancellationDate: null, filings: [], searchUrl, detailUrl: null, insuranceUrl: null, notes: ['FMCSA L&I search returned a verification challenge.', ...notes], rawText: searchText.slice(0, 12000) };
  }

  const applicantId = parseApplicantId(searchHtml);
  const detailCandidates = applicantId
    ? [
        endpoint('PKG_CARRQUERY.PRC_GETDETAIL', new URLSearchParams({ pv_apcant_id: applicantId })),
        endpoint('pkg_carrquery.prc_getdetail', new URLSearchParams({ pv_apcant_id: applicantId })),
      ]
    : [];
  const detailResult = detailCandidates.length ? await fetchFirstAvailable(detailCandidates, notes) : null;
  const detailUrl = detailResult?.url || null;
  const htmls = [searchHtml];
  if (detailResult) htmls.push(detailResult.html);
  let insuranceUrl: string | null = null;

  const insuranceCandidates = findInsuranceUrls(detailResult?.html || searchHtml, applicantId);
  for (const candidate of insuranceCandidates) {
    const result = await fetchFirstAvailable([candidate], notes);
    if (!result) continue;
    htmls.push(result.html);
    const parsed = parseInsuranceHtml(result.html);
    if (parsed.filings.length) {
      insuranceUrl = result.url;
      break;
    }
  }

  const filings = htmls.flatMap((html) => parseInsuranceHtml(html).filings);
  const uniqueFilings = filings.filter((filing, index, list) => {
    const key = `${filing.insuranceCarrier || ''}|${filing.policyNumber || ''}|${filing.formType || ''}|${filing.effectiveDate || ''}`;
    return list.findIndex((item) => `${item.insuranceCarrier || ''}|${item.policyNumber || ''}|${item.formType || ''}|${item.effectiveDate || ''}` === key) === index;
  });
  const current = uniqueFilings.find((filing) => filing.insuranceCarrier) || uniqueFilings[0] || null;
  const rawText = htmls.map(stripTags).join('\n---\n').slice(0, 12000);

  return {
    source: 'FMCSA_LI_PUBLIC',
    pulledAt,
    status: current ? 'FOUND' : 'NO_FILING_FOUND',
    usdotNumber,
    docketNumber,
    docketPrefix,
    currentCarrier: current?.insuranceCarrier || null,
    currentPolicyNumber: current?.policyNumber || null,
    currentFormType: current?.formType || null,
    effectiveDate: current?.effectiveDate || null,
    cancellationDate: current?.cancellationDate || null,
    filings: uniqueFilings,
    searchUrl,
    detailUrl,
    insuranceUrl,
    notes,
    rawText,
  };
}
