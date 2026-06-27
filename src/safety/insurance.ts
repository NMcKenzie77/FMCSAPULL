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
  while ((match = re.exec(html))) {
    values.push(absUrl(match[1]));
  }
  return Array.from(new Set(values));
}

function parseApplicantId(html: string): string | null {
  const fromHref = html.match(/pv_apcant_id=([0-9]+)/i)?.[1];
  return fromHref || null;
}

function findInsuranceUrls(html: string, applicantId: string | null): string[] {
  const found = links(html).filter((url) => /insur|insurance|filing|carrierins/i.test(url));
  if (applicantId) {
    found.push(`${LI_BASE}pkg_carrquery.prc_activeinsurance?pv_apcant_id=${encodeURIComponent(applicantId)}`);
    found.push(`${LI_BASE}pkg_carrquery.prc_insurance?pv_apcant_id=${encodeURIComponent(applicantId)}`);
    found.push(`${LI_BASE}pkg_carrquery.prc_insdetails?pv_apcant_id=${encodeURIComponent(applicantId)}`);
    found.push(`${LI_BASE}pkg_carrquery.prc_getinscarrier?pv_apcant_id=${encodeURIComponent(applicantId)}`);
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

function searchUrl(input: CarrierInput): string {
  const usdot = String(input.usdotNumber || '').replace(/\D/g, '');
  const docket = String(input.docketNumber || '').replace(/\D/g, '');
  const prefix = String(input.docketPrefix || 'MC').replace(/[^A-Z]/gi, '').toUpperCase() || 'MC';
  const params = new URLSearchParams();
  if (usdot) params.set('p_dotno', usdot);
  if (docket) {
    params.set('pn_docketno', docket);
    params.set('pv_docket_prefix', prefix);
    params.set('pv_pref_docket', prefix);
  }
  return `${LI_BASE}pkg_carrquery.prc_carrlist?${params.toString()}`;
}

async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'user-agent': 'ARKON-FMCSAPULL/1.0 carrier-insurance-profile',
    },
  });
  const html = await response.text();
  if (!response.ok) throw new Error(`FMCSA L&I returned ${response.status}`);
  return html;
}

export async function fetchCarrierInsuranceProfile(input: CarrierInput): Promise<CarrierInsuranceProfile> {
  const usdotNumber = String(input.usdotNumber || '').replace(/\D/g, '') || null;
  const docketNumber = String(input.docketNumber || '').replace(/\D/g, '') || null;
  const docketPrefix = input.docketPrefix || null;
  const url = searchUrl(input);
  const pulledAt = new Date().toISOString();
  const notes: string[] = [];

  const searchHtml = await fetchHtml(url);
  const searchText = stripTags(searchHtml);
  if (/challenge question|captcha|verification/i.test(searchText) && !/Insurance|BMC|Policy/i.test(searchText)) {
    return { source: 'FMCSA_LI_PUBLIC', pulledAt, status: 'SEARCH_BLOCKED', usdotNumber, docketNumber, docketPrefix, currentCarrier: null, currentPolicyNumber: null, currentFormType: null, effectiveDate: null, cancellationDate: null, filings: [], searchUrl: url, detailUrl: null, insuranceUrl: null, notes: ['FMCSA L&I search returned a verification challenge.'], rawText: searchText.slice(0, 12000) };
  }

  const applicantId = parseApplicantId(searchHtml);
  const detailUrl = applicantId ? `${LI_BASE}pkg_carrquery.prc_getdetail?pv_apcant_id=${encodeURIComponent(applicantId)}` : null;
  let htmls = [searchHtml];
  let insuranceUrl: string | null = null;

  if (detailUrl) {
    try {
      const detailHtml = await fetchHtml(detailUrl);
      htmls.push(detailHtml);
      for (const candidate of findInsuranceUrls(detailHtml, applicantId)) {
        try {
          const candidateHtml = await fetchHtml(candidate);
          htmls.push(candidateHtml);
          const candidateParsed = parseInsuranceHtml(candidateHtml);
          if (candidateParsed.filings.length) {
            insuranceUrl = candidate;
            break;
          }
        } catch (error) {
          notes.push(`Could not read L&I candidate page: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      notes.push(`Could not read L&I detail page: ${error instanceof Error ? error.message : String(error)}`);
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
    searchUrl: url,
    detailUrl,
    insuranceUrl,
    notes,
    rawText,
  };
}
