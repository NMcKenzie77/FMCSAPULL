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

function tableRows(html: string): string[][] {
  const rows: string[][] = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match: RegExpExecArray | null;
  while ((match = rowRe.exec(html))) {
    const cells = tableCells(match[1]);
    if (cells.length) rows.push(cells);
  }
  return rows;
}

function cleanLabel(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function findCellValue(cells: string[], labels: string[]): string | null {
  const normalizedLabels = labels.map(cleanLabel);
  for (let i = 0; i < cells.length; i += 1) {
    const cell = cleanLabel(cells[i]);
    if (normalizedLabels.some((label) => cell === label || cell.includes(label))) {
      for (let j = i + 1; j < Math.min(i + 4, cells.length); j += 1) {
        const value = cells[j]?.trim();
        if (value && !normalizedLabels.includes(cleanLabel(value))) return value;
      }
    }
  }
  return null;
}

function parseNumber(value: string | null): number | null {
  if (!value) return null;
  const match = value.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}

function parseRate(value: string | null): number | null {
  return parseNumber(value);
}

function parseDate(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  const parsed = new Date(cleaned);
  if (Number.isNaN(parsed.getTime())) return cleaned;
  return parsed.toISOString().slice(0, 10);
}

function parseMileage(value: string | null): { mileage: number | null; year: string | null } {
  if (!value) return { mileage: null, year: null };
  const year = value.match(/\((\d{4})\)/)?.[1] ?? null;
  return { mileage: parseNumber(value), year };
}

function splitList(value: string | null): string[] {
  if (!value) return [];
  return value.split(/[,;|]/).map((item) => item.trim()).filter(Boolean);
}

function findInspectionRow(rows: string[][], label: string): string[] | null {
  const target = cleanLabel(label);
  return rows.find((row) => cleanLabel(row[0] || '').includes(target)) ?? null;
}

function findCrashValue(rows: string[][], label: string): number | null {
  const target = cleanLabel(label);
  const row = rows.find((item) => cleanLabel(item[0] || '').includes(target));
  if (!row) return null;
  for (let i = 1; i < row.length; i += 1) {
    const parsed = parseNumber(row[i]);
    if (parsed !== null) return parsed;
  }
  return null;
}

function parseSaferSnapshot(html: string, usdotNumber: string, snapshotUrl: string): SaferSnapshot {
  const cells = tableCells(html);
  const rows = tableRows(html);
  const mileage = parseMileage(findCellValue(cells, ['MCS-150 Mileage', 'MCS 150 Mileage']));
  const driverRow = findInspectionRow(rows, 'Driver');
  const vehicleRow = findInspectionRow(rows, 'Vehicle');
  const hazmatRow = findInspectionRow(rows, 'Hazmat');
  const fatalCrashes = findCrashValue(rows, 'Fatal');
  const injuryCrashes = findCrashValue(rows, 'Injury');
  const towAwayCrashes = findCrashValue(rows, 'Tow');
  const totalCrashValue = [fatalCrashes, injuryCrashes, towAwayCrashes].some((value) => value !== null)
    ? (fatalCrashes ?? 0) + (injuryCrashes ?? 0) + (towAwayCrashes ?? 0)
    : parseNumber(findCellValue(cells, ['Crashes', 'Total Crashes']));

  return {
    usdotNumber,
    legalName: findCellValue(cells, ['Legal Name']),
    dbaName: findCellValue(cells, ['DBA Name']),
    operatingStatus: findCellValue(cells, ['Operating Status', 'Entity Type']),
    authorityStatus: findCellValue(cells, ['Authority Status', 'Operating Authority Status']),
    safetyRating: findCellValue(cells, ['Safety Rating']),
    safetyRatingDate: parseDate(findCellValue(cells, ['Review Date', 'Rating Date', 'Safety Rating Date'])),
    mcs150Date: parseDate(findCellValue(cells, ['MCS-150 Form Date', 'MCS 150 Form Date'])),
    mcs150Mileage: mileage.mileage,
    mcs150MileageYear: mileage.year,
    powerUnits: parseNumber(findCellValue(cells, ['Power Units'])),
    drivers: parseNumber(findCellValue(cells, ['Drivers'])),
    cargoCarried: splitList(findCellValue(cells, ['Cargo Carried'])),
    driverInspections: parseNumber(driverRow?.[1] ?? null),
    driverOutOfService: parseNumber(driverRow?.[2] ?? null),
    driverOutOfServiceRate: parseRate(driverRow?.[3] ?? null),
    nationalDriverOutOfServiceRate: parseRate(driverRow?.[4] ?? null),
    vehicleInspections: parseNumber(vehicleRow?.[1] ?? null),
    vehicleOutOfService: parseNumber(vehicleRow?.[2] ?? null),
    vehicleOutOfServiceRate: parseRate(vehicleRow?.[3] ?? null),
    nationalVehicleOutOfServiceRate: parseRate(vehicleRow?.[4] ?? null),
    hazmatInspections: parseNumber(hazmatRow?.[1] ?? null),
    hazmatOutOfService: parseNumber(hazmatRow?.[2] ?? null),
    hazmatOutOfServiceRate: parseRate(hazmatRow?.[3] ?? null),
    totalCrashes: totalCrashValue,
    fatalCrashes,
    injuryCrashes,
    towAwayCrashes,
    fetchedAt: new Date().toISOString(),
    snapshotUrl,
    rawText: stripTags(html).slice(0, 12000),
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
