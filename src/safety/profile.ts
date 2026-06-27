import type { QueryResult } from 'pg';
import { query } from '../db.js';

export type CarrierSafetyRiskLevel = 'LOW' | 'MODERATE' | 'ELEVATED' | 'HIGH' | 'UNKNOWN';
export type CarrierSafetyProfile = ReturnType<typeof buildCarrierSafetyProfile>;

type CarrierLike = Record<string, unknown>;
type Queryable = { query(sql: string, params?: unknown[]): Promise<QueryResult> };

function firstDefined(...values: unknown[]) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function text(...values: unknown[]): string | null {
  const selected = firstDefined(...values);
  if (selected === undefined || selected === null) return null;
  const value = String(selected).trim();
  return value || null;
}

function num(...values: unknown[]): number | null {
  const selected = firstDefined(...values);
  if (selected === undefined || selected === null || selected === '') return null;
  const value = Number(selected);
  return Number.isFinite(value) ? value : null;
}

function textArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}

function dateText(...values: unknown[]): string | null {
  const value = text(...values);
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString().slice(0, 10);
}

function monthsSince(value: string | null): number | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  const diff = Date.now() - parsed.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24 * 30.4375));
}

function rawObject(row: CarrierLike): Record<string, unknown> {
  const raw = firstDefined(row.raw, row.raw_json, row.rawSource);
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

function rawText(row: CarrierLike, ...keys: string[]): string | null {
  const raw = rawObject(row);
  return text(...keys.map((key) => raw[key]));
}

function rawNum(row: CarrierLike, ...keys: string[]): number | null {
  const raw = rawObject(row);
  return num(...keys.map((key) => raw[key]));
}

function determineRiskLevel(points: number, hasKnownData: boolean): CarrierSafetyRiskLevel {
  if (!hasKnownData) return 'UNKNOWN';
  if (points >= 6) return 'HIGH';
  if (points >= 4) return 'ELEVATED';
  if (points >= 2) return 'MODERATE';
  return 'LOW';
}

function producerQuestions(riskLevel: CarrierSafetyRiskLevel, missingData: string[]): string[] {
  const questions = [
    'Who is your current commercial auto carrier?',
    'When is your current insurance renewal date?',
    'Do you run local, regional, or long-haul routes?',
    'What radius do you operate in?',
    'Do you have current loss runs available?',
  ];

  if (riskLevel === 'ELEVATED' || riskLevel === 'HIGH') {
    questions.push(
      'Have there been any recent inspections, violations, or crashes we should know about?',
      'Who handles vehicle maintenance and how is it documented?',
      'Do you have written driver safety procedures?'
    );
  }

  if (missingData.includes('vehicle_schedule')) questions.push('Can you provide the current vehicle schedule?');
  if (missingData.includes('driver_schedule')) questions.push('Can you provide the current driver schedule?');
  if (missingData.includes('cargo_details')) questions.push('What commodities do you haul most often?');

  return Array.from(new Set(questions));
}

export function buildCarrierSafetyProfile(row: CarrierLike) {
  const usdotNumber = text(row.usdotNumber, row.usdot_number) || '';
  const legalName = text(row.legalName, row.legal_name, row.hq_name);
  const dbaName = text(row.dbaName, row.dba_name);
  const operatingStatus = text(row.operatingStatus, row.usdotStatus, row.usdot_status, rawText(row, 'operating_status', 'status'));
  const authorityStatus = text(row.authorityStatus, row.authority_status, row.allowedToOperate, row.allowed_to_operate, rawText(row, 'authority_status', 'allowed_to_operate'));
  const safetyRating = text(row.safetyRating, row.safety_rating, rawText(row, 'safety_rating', 'safetyRating'));
  const safetyRatingDate = dateText(row.safetyRatingDate, row.safety_rating_date, rawText(row, 'safety_rating_date', 'safetyRatingDate'));
  const powerUnits = num(row.powerUnits, row.power_units);
  const drivers = num(row.drivers);
  const mcs150Date = dateText(row.mcs150Date, row.mcs150_date);
  const mcs150Mileage = num(row.mcs150Mileage, row.mcs150_mileage);
  const mcs150MileageYear = text(row.mcs150MileageYear, row.mcs150_mileage_year);
  const cargoCarried = textArray(firstDefined(row.cargo, row.cargoCarried));

  const driverInspections = rawNum(row, 'driver_inspections', 'driverInspections');
  const vehicleInspections = rawNum(row, 'vehicle_inspections', 'vehicleInspections');
  const driverOutOfServiceRate = rawNum(row, 'driver_oos_rate', 'driverOutOfServiceRate');
  const vehicleOutOfServiceRate = rawNum(row, 'vehicle_oos_rate', 'vehicleOutOfServiceRate');
  const totalCrashes = rawNum(row, 'total_crashes', 'crashes', 'totalCrashes');
  const fatalCrashes = rawNum(row, 'fatal_crashes', 'fatalCrashes');
  const injuryCrashes = rawNum(row, 'injury_crashes', 'injuryCrashes');
  const towAwayCrashes = rawNum(row, 'tow_away_crashes', 'towAwayCrashes');

  const reasons: string[] = [];
  const missingData: string[] = [];
  let riskPoints = 0;

  const authorityCombined = `${authorityStatus ?? ''} ${operatingStatus ?? ''}`.toUpperCase();
  if (authorityCombined.includes('OUT') || authorityCombined.includes('INACTIVE') || authorityCombined.includes('NOT AUTHORIZED') || authorityCombined.includes('NO')) {
    riskPoints += 4;
    reasons.push('Authority or operating status needs producer review.');
  }

  const rating = String(safetyRating ?? '').toUpperCase();
  if (rating.includes('UNSATISFACTORY')) {
    riskPoints += 6;
    reasons.push('Unsatisfactory safety rating found in public carrier data.');
  } else if (rating.includes('CONDITIONAL')) {
    riskPoints += 4;
    reasons.push('Conditional safety rating found in public carrier data.');
  } else if (rating.includes('SATISFACTORY')) {
    reasons.push('Satisfactory safety rating found in public carrier data.');
  } else {
    missingData.push('safety_rating');
  }

  if (driverOutOfServiceRate !== null && driverOutOfServiceRate >= 20) {
    riskPoints += 2;
    reasons.push('Driver out-of-service rate appears elevated.');
  }
  if (vehicleOutOfServiceRate !== null && vehicleOutOfServiceRate >= 25) {
    riskPoints += 2;
    reasons.push('Vehicle out-of-service rate appears elevated.');
  }
  if (fatalCrashes !== null && fatalCrashes > 0) {
    riskPoints += 4;
    reasons.push('Fatal crash history requires underwriting review.');
  } else if (injuryCrashes !== null && injuryCrashes > 0) {
    riskPoints += 2;
    reasons.push('Injury crash history requires producer follow-up.');
  } else if (totalCrashes !== null && totalCrashes > 0) {
    riskPoints += 1;
    reasons.push('Crash history should be reviewed before marketing.');
  }

  const mcsAgeMonths = monthsSince(mcs150Date);
  if (mcsAgeMonths === null) {
    missingData.push('mcs150_date');
  } else if (mcsAgeMonths > 24) {
    riskPoints += 1;
    reasons.push('MCS-150 update appears stale.');
  }

  if (!powerUnits || powerUnits <= 0) missingData.push('vehicle_schedule');
  if (!drivers || drivers <= 0) missingData.push('driver_schedule');
  if (!cargoCarried.length) missingData.push('cargo_details');

  const hasKnownData = Boolean(usdotNumber || operatingStatus || authorityStatus || safetyRating || powerUnits || drivers || mcs150Date);
  const riskLevel = determineRiskLevel(riskPoints, hasKnownData);
  if (!reasons.length && riskLevel === 'LOW') reasons.push('No major public safety red flags detected from available FMCSA fields.');
  if (!reasons.length && riskLevel === 'UNKNOWN') reasons.push('Insufficient public safety data available for automated risk classification.');

  return {
    source: 'FMCSA_PUBLIC_DATA',
    pulledAt: new Date().toISOString(),
    usdotNumber,
    legalName,
    dbaName,
    operatingStatus,
    authorityStatus,
    safetyRating,
    safetyRatingDate,
    powerUnits,
    drivers,
    mcs150Date,
    mcs150Mileage,
    mcs150MileageYear,
    cargoCarried,
    inspections: {
      driverInspections,
      vehicleInspections,
      hazmatInspections: rawNum(row, 'hazmat_inspections', 'hazmatInspections'),
      iepInspections: rawNum(row, 'iep_inspections', 'iepInspections'),
      driverOutOfService: rawNum(row, 'driver_oos', 'driverOutOfService'),
      vehicleOutOfService: rawNum(row, 'vehicle_oos', 'vehicleOutOfService'),
      hazmatOutOfService: rawNum(row, 'hazmat_oos', 'hazmatOutOfService'),
      iepOutOfService: rawNum(row, 'iep_oos', 'iepOutOfService'),
      driverOutOfServiceRate,
      vehicleOutOfServiceRate,
      hazmatOutOfServiceRate: rawNum(row, 'hazmat_oos_rate', 'hazmatOutOfServiceRate'),
      nationalDriverOutOfServiceRate: rawNum(row, 'national_driver_oos_rate', 'nationalDriverOutOfServiceRate'),
      nationalVehicleOutOfServiceRate: rawNum(row, 'national_vehicle_oos_rate', 'nationalVehicleOutOfServiceRate'),
    },
    crashes: {
      totalCrashes,
      fatalCrashes,
      injuryCrashes,
      towAwayCrashes,
    },
    sms: {
      hasPublicSmsProfile: Boolean(rawText(row, 'sms_url', 'smsProfileUrl')),
      unsafeDrivingFlag: null,
      hoursOfServiceFlag: null,
      driverFitnessFlag: null,
      controlledSubstancesFlag: null,
      vehicleMaintenanceFlag: null,
      crashIndicatorPublic: false,
      hazmatCompliancePublic: false,
      notes: 'SMS/BASIC detail may be limited for property carriers; use this profile as producer preparation, not a final underwriting conclusion.',
    },
    underwritingSignals: {
      riskLevel,
      reasons,
      missingData: Array.from(new Set(missingData)),
      recommendedProducerQuestions: producerQuestions(riskLevel, missingData),
    },
    raw: rawObject(row),
  };
}

export async function upsertCarrierSafetyProfile(client: Queryable, carrierId: number, row: CarrierLike): Promise<CarrierSafetyProfile> {
  const profile = buildCarrierSafetyProfile(row);
  await client.query(
    `insert into carrier_safety_profiles (
      carrier_id, usdot_number, source, pulled_at, safety_rating, safety_rating_date,
      operating_status, authority_status, driver_oos_rate, vehicle_oos_rate,
      national_driver_oos_rate, national_vehicle_oos_rate, total_crashes,
      fatal_crashes, injury_crashes, tow_away_crashes, risk_level,
      risk_reasons_json, recommended_questions_json, missing_data_json, profile_json, raw_json
    ) values (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22
    )
    on conflict (carrier_id) do update set
      usdot_number = excluded.usdot_number,
      source = excluded.source,
      pulled_at = excluded.pulled_at,
      safety_rating = excluded.safety_rating,
      safety_rating_date = excluded.safety_rating_date,
      operating_status = excluded.operating_status,
      authority_status = excluded.authority_status,
      driver_oos_rate = excluded.driver_oos_rate,
      vehicle_oos_rate = excluded.vehicle_oos_rate,
      national_driver_oos_rate = excluded.national_driver_oos_rate,
      national_vehicle_oos_rate = excluded.national_vehicle_oos_rate,
      total_crashes = excluded.total_crashes,
      fatal_crashes = excluded.fatal_crashes,
      injury_crashes = excluded.injury_crashes,
      tow_away_crashes = excluded.tow_away_crashes,
      risk_level = excluded.risk_level,
      risk_reasons_json = excluded.risk_reasons_json,
      recommended_questions_json = excluded.recommended_questions_json,
      missing_data_json = excluded.missing_data_json,
      profile_json = excluded.profile_json,
      raw_json = excluded.raw_json,
      updated_at = now()`,
    [
      carrierId,
      profile.usdotNumber,
      profile.source,
      profile.pulledAt,
      profile.safetyRating,
      profile.safetyRatingDate,
      profile.operatingStatus,
      profile.authorityStatus,
      profile.inspections.driverOutOfServiceRate,
      profile.inspections.vehicleOutOfServiceRate,
      profile.inspections.nationalDriverOutOfServiceRate,
      profile.inspections.nationalVehicleOutOfServiceRate,
      profile.crashes.totalCrashes,
      profile.crashes.fatalCrashes,
      profile.crashes.injuryCrashes,
      profile.crashes.towAwayCrashes,
      profile.underwritingSignals.riskLevel,
      JSON.stringify(profile.underwritingSignals.reasons),
      JSON.stringify(profile.underwritingSignals.recommendedProducerQuestions),
      JSON.stringify(profile.underwritingSignals.missingData),
      JSON.stringify(profile),
      JSON.stringify(profile.raw),
    ]
  );
  return profile;
}

export async function getCarrierSafetyProfileByUsdot(usdotNumber: string): Promise<CarrierSafetyProfile | null> {
  const result = await query<{ profile_json: CarrierSafetyProfile | null }>(
    `select profile_json from carrier_safety_profiles where usdot_number = $1 order by pulled_at desc limit 1`,
    [usdotNumber]
  );
  return result.rows[0]?.profile_json ?? null;
}

export async function refreshCarrierSafetyProfiles(limit = 1000): Promise<{ refreshed: number }> {
  const result = await query<CarrierLike & { id: string }>(
    `select * from fmcsa_carriers order by last_seen_at desc limit $1`,
    [limit]
  );

  let refreshed = 0;
  const queryable: Queryable = { query: (sql: string, params?: unknown[]) => query(sql, params) };
  for (const row of result.rows) {
    await upsertCarrierSafetyProfile(queryable, Number(row.id), row);
    refreshed += 1;
  }

  return { refreshed };
}
