import { closePool, initSchema, query } from '../db.js';
import { upsertCarrierSafetyProfile, type CarrierSafetyProfile } from './profile.js';
import { fetchCarrierInsuranceProfile } from './insurance.js';

type CarrierRow = Record<string, unknown> & {
  id: string;
  usdot_number: string;
  safety_raw?: Record<string, unknown> | null;
};

type InsuranceResult = {
  usdotNumber: string;
  ok: boolean;
  status?: string;
  currentCarrier?: string | null;
  currentPolicyNumber?: string | null;
  currentFormType?: string | null;
  profile?: CarrierSafetyProfile;
  error?: string;
};

function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const cleaned = String(value).trim();
  return cleaned || null;
}

function rawObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function docketPrefix(row: CarrierRow): string | null {
  return text(row.docket1prefix) || text(row.docket_prefix) || text(row.mc_mx_ff_prefix) || 'MC';
}

function docketNumber(row: CarrierRow): string | null {
  return text(row.docket1) || text(row.docket_number) || text(row.mc_mx_ff_number);
}

async function carriersForInsuranceRefresh(limit: number, usdotNumbers: string[]): Promise<CarrierRow[]> {
  if (usdotNumbers.length) {
    const result = await query<CarrierRow>(
      `select c.*, sp.raw_json as safety_raw
         from fmcsa_carriers c
         left join carrier_safety_profiles sp on sp.carrier_id = c.id
        where c.usdot_number = any($1::text[])
        order by c.last_seen_at desc`,
      [usdotNumbers]
    );
    return result.rows;
  }

  const result = await query<CarrierRow>(
    `select c.*, sp.raw_json as safety_raw
       from fmcsa_carriers c
       left join carrier_safety_profiles sp on sp.carrier_id = c.id
      where sp.raw_json is null
         or sp.raw_json->'insurance' is null
      order by case when sp.id is null then 0 else 1 end, c.last_seen_at desc
      limit $1`,
    [limit]
  );
  return result.rows;
}

export async function refreshCarrierInsuranceProfiles(options: { limit?: number; usdotNumbers?: string[] } = {}): Promise<{ ok: true; requested: number; refreshed: number; failed: number; results: InsuranceResult[] }> {
  const limit = Math.min(Math.max(Number(options.limit ?? 25) || 25, 1), 250);
  const usdotNumbers = (options.usdotNumbers || []).map((value) => String(value).replace(/\D/g, '')).filter(Boolean);
  const carriers = await carriersForInsuranceRefresh(limit, usdotNumbers);
  const results: InsuranceResult[] = [];

  for (const carrier of carriers) {
    const usdotNumber = String(carrier.usdot_number || '').trim();
    try {
      const insurance = await fetchCarrierInsuranceProfile({
        usdotNumber,
        docketNumber: docketNumber(carrier),
        docketPrefix: docketPrefix(carrier),
      });
      const mergedRaw = {
        ...rawObject(carrier.safety_raw),
        insurance,
        insurance_checked_at: new Date().toISOString(),
      };
      const profile = await upsertCarrierSafetyProfile({ query }, Number(carrier.id), { ...carrier, raw: mergedRaw });
      results.push({
        usdotNumber,
        ok: insurance.status === 'FOUND',
        status: insurance.status,
        currentCarrier: insurance.currentCarrier,
        currentPolicyNumber: insurance.currentPolicyNumber,
        currentFormType: insurance.currentFormType,
        profile,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const mergedRaw = {
        ...rawObject(carrier.safety_raw),
        insurance: {
          source: 'FMCSA_LI_PUBLIC',
          pulledAt: new Date().toISOString(),
          status: 'ERROR',
          usdotNumber,
          docketNumber: docketNumber(carrier),
          docketPrefix: docketPrefix(carrier),
          currentCarrier: null,
          currentPolicyNumber: null,
          currentFormType: null,
          effectiveDate: null,
          cancellationDate: null,
          filings: [],
          notes: [errorMessage],
        },
        insurance_checked_at: new Date().toISOString(),
      };
      await upsertCarrierSafetyProfile({ query }, Number(carrier.id), { ...carrier, raw: mergedRaw });
      results.push({ usdotNumber, ok: false, status: 'ERROR', error: errorMessage });
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

async function main() {
  await initSchema();
  const limitArg = process.argv[2] ? Number.parseInt(process.argv[2], 10) : 25;
  const usdotNumbers = process.argv.slice(3).map((item) => item.trim()).filter(Boolean);
  const result = await refreshCarrierInsuranceProfiles({
    limit: Number.isFinite(limitArg) ? limitArg : 25,
    usdotNumbers,
  });
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
