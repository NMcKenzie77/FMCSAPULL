import { query } from '../db.js';
import { upsertCarrierSafetyProfile, type CarrierSafetyProfile } from './profile.js';

type CarrierRow = Record<string, unknown> & { id: string; usdot_number: string };

type SaferSnapshot = {
  usdotNumber: string;
  legalName: string | null;
  dbaName: string | null;
  operatingStatus: string | null;
  authorityStatus: string | null;
  safetyRating: string | null;
  safetyRatingDate: string | null;
  mcs150Date: string | null;
  mcs150Mileage: number | null;
  mcs150MileageYear: string | null;
  powerUnits: number | null;
  drivers: number | null;
  cargoCarried: string[];
  driverInspections: number | null;
  vehicleInspections: number | null;
  hazmatInspections: number | null;
  driverOutOfService: number | null;
  vehicleOutOfService: number | null;
  hazmatOutOfService: number | null;
  driverOutOfServiceRate: number | null;
  vehicleOutOfServiceRate: number | null;
  hazmatOutOfServiceRate: number | null;
  nationalDriverOutOfServiceRate: number | null;
  nationalVehicleOutOfServiceRate: number | null;
  totalCrashes: number | null;
  fatalCrashes: number | null;
  injuryCrashes: number | null;
  towAwayCrashes: number | null;
  fetchedAt: string;
  snapshotUrl: string;
  rawText: string;
};

type SaferResult = { usdotNumber: string; ok: boolean; profile?: CarrierSafetyProfile; error?: string };

type InspectionStats = {
  vehicleInspections: number | null;
  driverInspections: number | null;
  hazmatInspections: number | null;
  vehicleOutOfService: number | null;
  driverOutOfService: number | null;
  hazmatOutOfService: number | null;
  vehicleOutOfServiceRate: number | null;
  driverOutOfServiceRate: number | null;
  hazmatOutOfServiceRate: number | null;
  nationalVehicleOutOfServiceRate: number | null;
  nationalDriverOutOfServiceRate: number | null;
};

type CrashStats = {
  totalCrashes: number | null;
  fatalCrashes: number | null;
  injuryCrashes: number | null;
  towAwayCrashes: number | null;
};

const CARGO_LABELS = [
  'General Freight',
  'Household Goods',
  'Metal: sheets, coils, rolls',
  'Motor Vehicles',
  'Drive/Tow away',
  'Logs, Poles, Beams, Lumber',
  'Building Materials',
  'Mobile Homes',
  'Machinery, Large Objects',
  'Fresh Produce',
  'Liquids/Gases',
  'Intermodal Cont.',
  'Passengers',
  'Oilfield Equipment',
  'Livestock',
  'Grain, Feed, Hay',
  'Coal/Coke',
  'Meat',
  'Garbage/Refuse',
  'US Mail',
  'Chemicals',
  'Commodities Dry Bulk',
  'Refrigerated Food',
  'Beverages',
  'Paper Products',
  'Utilities',
  'Agricultural/Farm Supplies',
  'Construction',
  'Water Well',
  'PETROLEUM',
];

function stripTags(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#160;/g, ' ')
    .replace(/&#8226;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tableCells(html: string): string[] {
  const cells: string[] = [];
  const re = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const value = stripTags(match[1]);
    if (value) cells.push(value);
  }
  return cells;
}

function cleanLabel(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value
    .replace(/SAFER Layout/gi, ' ')
    .replace(/SAFER Table Layout/gi, ' ')
    .replace(/For Licensing and Insurance details click here\.?/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || /^(none|n\/a|na|null|--|not available)$/i.test(cleaned)) return null;
  if (/^(physical address|phone|mailing address|duns number)$/i.test(cleaned.replace(/:$/, ''))) return null;
  return cleaned;
}

function findCellValue(cells: string[], labels: string[]): string | null {
  const normalizedLabels = labels.map(cleanLabel);
  for (let i = 0; i < cells.length; i += 1) {
    const cell = cleanLabel(cells[i]);
    if (normalizedLabels.some((label) => cell === label || cell.includes(label))) {
      for (let j = i + 1; j < Math.min(i + 4, cells.length); j += 1) {
        const value = normalizeValue(cells[j]);
        if (value && !normalizedLabels.includes(cleanLabel(value))) return value;
      }
    }
  }
  return null;
}

function findTextValue(rawText: string, label: string, stopLabels: string[]): string | null {
  const labelPattern = new RegExp(`${escapeRegex(label)}:\\s*`, 'i');
  const match = labelPattern.exec(rawText);
  if (!match) return null;
  const rest = rawText.slice(match.index + match[0].length);
  let end = rest.length;
  for (const stopLabel of stopLabels) {
    const stopWithColon = rest.search(new RegExp(`\\s${escapeRegex(stopLabel)}:\\s*`, 'i'));
    if (stopWithColon >= 0) end = Math.min(end, stopWithColon);
    const stopBare = rest.toLowerCase().indexOf(` ${stopLabel.toLowerCase()} `);
    if (stopBare >= 0) end = Math.min(end, stopBare);
  }
  return normalizeValue(rest.slice(0, end));
}

function textSection(rawText: string, start: string, end: string): string {
  const startIndex = rawText.toLowerCase().indexOf(start.toLowerCase());
  if (startIndex < 0) return '';
  const rest = rawText.slice(startIndex);
  const endIndex = rest.toLowerCase().indexOf(end.toLowerCase());
  return endIndex >= 0 ? rest.slice(0, endIndex) : rest;
}

function parseNumber(value: string | null | undefined): number | null {
  if (!value) return null;
  const cleaned = normalizeValue(value);
  if (!cleaned) return null;
  const match = cleaned.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}

function parseRate(value: string | null | undefined): number | null {
  return parseNumber(value);
}

function parseDate(value: string | null | undefined): string | null {
  const cleaned = normalizeValue(value);
  if (!cleaned) return null;
  const mdy = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
  const ymd = cleaned.match(/^(\d{4})(\d{2})(\d{2})/);
  if (ymd) return `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
  const parsed = new Date(cleaned);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function parseMileage(value: string | null): { mileage: number | null; year: string | null } {
  if (!value) return { mileage: null, year: null };
  const year = value.match(/\((\d{4})\)/)?.[1] ?? null;
  return { mileage: parseNumber(value), year };
}

function splitList(value: string | null): string[] {
  if (!value) return [];
  return value.split(/[,;|]/).map((item) => normalizeValue(item)).filter((item): item is string => Boolean(item));
}

function parseCargo(rawText: string, fallback: string | null): string[] {
  const section = textSection(rawText, 'Cargo Carried:', 'ID/Operations | Inspections/Crashes In US');
  const selected: string[] = [];
  for (const label of CARGO_LABELS) {
    const pattern = new RegExp(`(?:^|\\s)X\\s+${escapeRegex(label)}(?:\\s|$)`, 'i');
    if (pattern.test(section)) selected.push(label === 'PETROLEUM' ? 'Petroleum' : label);
  }
  return selected.length ? selected : splitList(fallback).filter((item) => !/safer layout/i.test(item));
}

function parseInspectionStats(rawText: string): InspectionStats {
  const section = textSection(rawText, 'US Inspection results', 'Canadian Inspection results');
  const inspections = section.match(/Inspection Type\s+Vehicle\s+Driver\s+Hazmat\s+IEP\s+Inspections\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)/i);
  const outOfService = section.match(/Out of Service\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)/i);
  const rateSegment = section.match(/Out of Service %\s+([\s\S]*?)Nat'?l Average/i)?.[1] ?? '';
  const rates = (rateSegment.match(/\d+(?:\.\d+)?\s*%/g) || []).map(parseRate);
  const natSegment = section.match(/Nat'?l Average[\s\S]*?\*\s*([\s\S]*?)\*OOS/i)?.[1] ?? '';
  const natRates = (natSegment.match(/\d+(?:\.\d+)?\s*%/g) || []).map(parseRate);
  const vehicleInspections = parseNumber(inspections?.[1]);
  const driverInspections = parseNumber(inspections?.[2]);
  const hazmatInspections = parseNumber(inspections?.[3]);

  return {
    vehicleInspections,
    driverInspections,
    hazmatInspections,
    vehicleOutOfService: parseNumber(outOfService?.[1]),
    driverOutOfService: parseNumber(outOfService?.[2]),
    hazmatOutOfService: parseNumber(outOfService?.[3]),
    vehicleOutOfServiceRate: rates[0] ?? null,
    driverOutOfServiceRate: rates[1] ?? null,
    hazmatOutOfServiceRate: hazmatInspections === 0 && rates.length === 3 ? null : rates[2] ?? null,
    nationalVehicleOutOfServiceRate: natRates[0] ?? null,
    nationalDriverOutOfServiceRate: natRates[1] ?? null,
  };
}

function parseCrashStats(rawText: string): CrashStats {
  const section = textSection(rawText, 'Crashes reported to FMCSA by states', 'ID/Operations | Inspections/Crashes In Canada');
  const match = section.match(/Crashes:\s*Type\s+Fatal\s+Injury\s+Tow\s+Total\s+Crashes\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)/i);
  return {
    fatalCrashes: parseNumber(match?.[1]),
    injuryCrashes: parseNumber(match?.[2]),
    towAwayCrashes: parseNumber(match?.[3]),
    totalCrashes: parseNumber(match?.[4]),
  };
}

function parseSafetyRating(rawText: string, cells: string[]): { rating: string | null; ratingDate: string | null } {
  const ratingMatch = rawText.match(/Rating:\s*(Satisfactory|Conditional|Unsatisfactory|Not Rated|Unrated|None|Non-Ratable)/i);
  const date = parseDate(findTextValue(rawText, 'Rating Date', ['Review Date', 'Rating', 'Type']))
    || parseDate(findCellValue(cells, ['Rating Date', 'Safety Rating Date']))
    || parseDate(findTextValue(rawText, 'Review Date', ['Rating', 'Type']));
  return {
    rating: normalizeValue(ratingMatch?.[1]) || findCellValue(cells, ['Safety Rating']),
    ratingDate: date,
  };
}

function parseSaferSnapshot(html: string, usdotNumber: string, snapshotUrl: string): SaferSnapshot {
  const cells = tableCells(html);
  const rawText = stripTags(html);
  const mileage = parseMileage(findTextValue(rawText, 'MCS-150 Mileage (Year)', ['OPERATING AUTHORITY INFORMATION']) || findCellValue(cells, ['MCS-150 Mileage', 'MCS 150 Mileage']));
  const inspections = parseInspectionStats(rawText);
  const crashes = parseCrashStats(rawText);
  const rating = parseSafetyRating(rawText, cells);

  return {
    usdotNumber,
    legalName: findTextValue(rawText, 'Legal Name', ['DBA Name', 'Physical Address']) || findCellValue(cells, ['Legal Name']),
    dbaName: findTextValue(rawText, 'DBA Name', ['Physical Address', 'Phone', 'Mailing Address']) || findCellValue(cells, ['DBA Name']),
    operatingStatus: findTextValue(rawText, 'USDOT Status', ['Out of Service Date', 'USDOT Number']) || findTextValue(rawText, 'Entity Type', ['New Entrant Status', 'USDOT Status']) || findCellValue(cells, ['Operating Status', 'Entity Type']),
    authorityStatus: findTextValue(rawText, 'Operating Authority Status', ['MC/MX/FF Number(s)', 'COMPANY INFORMATION']) || findCellValue(cells, ['Authority Status', 'Operating Authority Status']),
    safetyRating: rating.rating,
    safetyRatingDate: rating.ratingDate,
    mcs150Date: parseDate(findTextValue(rawText, 'MCS-150 Form Date', ['MCS-150 Mileage', 'OPERATING AUTHORITY INFORMATION']) || findCellValue(cells, ['MCS-150 Form Date', 'MCS 150 Form Date'])),
    mcs150Mileage: mileage.mileage,
    mcs150MileageYear: mileage.year,
    powerUnits: parseNumber(findTextValue(rawText, 'Power Units', ['Non-CMV Units', 'Drivers']) || findCellValue(cells, ['Power Units'])),
    drivers: parseNumber(findTextValue(rawText, 'Drivers', ['Operation Classification', 'Carrier Operation']) || findCellValue(cells, ['Drivers'])),
    cargoCarried: parseCargo(rawText, findCellValue(cells, ['Cargo Carried'])),
    driverInspections: inspections.driverInspections,
    driverOutOfService: inspections.driverOutOfService,
    driverOutOfServiceRate: inspections.driverOutOfServiceRate,
    nationalDriverOutOfServiceRate: inspections.nationalDriverOutOfServiceRate,
    vehicleInspections: inspections.vehicleInspections,
    vehicleOutOfService: inspections.vehicleOutOfService,
    vehicleOutOfServiceRate: inspections.vehicleOutOfServiceRate,
    nationalVehicleOutOfServiceRate: inspections.nationalVehicleOutOfServiceRate,
    hazmatInspections: inspections.hazmatInspections,
    hazmatOutOfService: inspections.hazmatOutOfService,
    hazmatOutOfServiceRate: inspections.hazmatOutOfServiceRate,
    totalCrashes: crashes.totalCrashes,
    fatalCrashes: crashes.fatalCrashes,
    injuryCrashes: crashes.injuryCrashes,
    towAwayCrashes: crashes.towAwayCrashes,
    fetchedAt: new Date().toISOString(),
    snapshotUrl,
    rawText: rawText.slice(0, 12000),
  };
}

function snapshotToProfileRow(carrier: CarrierRow, snapshot: SaferSnapshot) {
  return {
    ...carrier,
    usdotNumber: snapshot.usdotNumber,
    legalName: snapshot.legalName || carrier.legal_name,
    dbaName: snapshot.dbaName || carrier.dba_name,
    operatingStatus: snapshot.operatingStatus || carrier.usdot_status,
    authorityStatus: snapshot.authorityStatus || carrier.authority_status || carrier.allowed_to_operate,
    safetyRating: snapshot.safetyRating,
    safetyRatingDate: snapshot.safetyRatingDate,
    powerUnits: snapshot.powerUnits ?? carrier.power_units,
    drivers: snapshot.drivers ?? carrier.drivers,
    mcs150Date: snapshot.mcs150Date || carrier.mcs150_date,
    mcs150Mileage: snapshot.mcs150Mileage ?? carrier.mcs150_mileage,
    mcs150MileageYear: snapshot.mcs150MileageYear || carrier.mcs150_mileage_year,
    cargo: snapshot.cargoCarried.length ? snapshot.cargoCarried : carrier.cargo,
    raw: {
      ...(carrier.raw && typeof carrier.raw === 'object' ? carrier.raw as Record<string, unknown> : {}),
      safer: snapshot,
      safety_rating: snapshot.safetyRating,
      safety_rating_date: snapshot.safetyRatingDate,
      driver_inspections: snapshot.driverInspections,
      vehicle_inspections: snapshot.vehicleInspections,
      hazmat_inspections: snapshot.hazmatInspections,
      driver_oos: snapshot.driverOutOfService,
      vehicle_oos: snapshot.vehicleOutOfService,
      hazmat_oos: snapshot.hazmatOutOfService,
      driver_oos_rate: snapshot.driverOutOfServiceRate,
      vehicle_oos_rate: snapshot.vehicleOutOfServiceRate,
      hazmat_oos_rate: snapshot.hazmatOutOfServiceRate,
      national_driver_oos_rate: snapshot.nationalDriverOutOfServiceRate,
      national_vehicle_oos_rate: snapshot.nationalVehicleOutOfServiceRate,
      total_crashes: snapshot.totalCrashes,
      fatal_crashes: snapshot.fatalCrashes,
      injury_crashes: snapshot.injuryCrashes,
      tow_away_crashes: snapshot.towAwayCrashes,
      snapshot_url: snapshot.snapshotUrl,
    },
  };
}

export async function fetchSaferSnapshotByUsdot(usdotNumber: string): Promise<SaferSnapshot> {
  const normalizedUsdot = String(usdotNumber || '').replace(/\D/g, '');
  if (!normalizedUsdot) throw new Error('USDOT number is required for SAFER lookup.');
  const url = `https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=${encodeURIComponent(normalizedUsdot)}`;
  const response = await fetch(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'user-agent': 'ARKON-FMCSAPULL/1.0 carrier-safety-profile',
    },
  });
  const html = await response.text();
  if (!response.ok) throw new Error(`SAFER returned ${response.status} for USDOT ${normalizedUsdot}`);
  if (/no records found|record not found|cannot be found/i.test(html)) throw new Error(`No SAFER snapshot found for USDOT ${normalizedUsdot}`);
  return parseSaferSnapshot(html, normalizedUsdot, url);
}

async function carriersForSafetyRefresh(limit: number, usdotNumbers: string[]): Promise<CarrierRow[]> {
  if (usdotNumbers.length) {
    const result = await query<CarrierRow>(
      `select * from fmcsa_carriers where usdot_number = any($1::text[]) order by last_seen_at desc`,
      [usdotNumbers]
    );
    return result.rows;
  }

  const result = await query<CarrierRow>(
    `select c.*
       from fmcsa_carriers c
       left join carrier_safety_profiles sp on sp.carrier_id = c.id
      order by case when sp.id is null then 0 else 1 end, c.last_seen_at desc
      limit $1`,
    [limit]
  );
  return result.rows;
}

export async function enrichSaferCarrierSafety(options: { limit?: number; usdotNumbers?: string[] } = {}): Promise<{ ok: true; requested: number; refreshed: number; failed: number; results: SaferResult[] }> {
  const limit = Math.min(Math.max(Number(options.limit ?? 25) || 25, 1), 250);
  const usdotNumbers = (options.usdotNumbers || []).map((value) => String(value).replace(/\D/g, '')).filter(Boolean);
  const carriers = await carriersForSafetyRefresh(limit, usdotNumbers);
  const results: SaferResult[] = [];

  for (const carrier of carriers) {
    const usdotNumber = String(carrier.usdot_number || '').trim();
    try {
      const snapshot = await fetchSaferSnapshotByUsdot(usdotNumber);
      const profile = await upsertCarrierSafetyProfile({ query }, Number(carrier.id), snapshotToProfileRow(carrier, snapshot));
      results.push({ usdotNumber, ok: true, profile });
    } catch (error) {
      results.push({ usdotNumber, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    ok: true,
    requested: carriers.length,
    refreshed: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    results,
  };
}
