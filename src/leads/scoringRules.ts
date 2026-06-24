import type { NormalizedCarrier } from '../fmcsa/normalize.js';

export type ScoreBucket = 'commercialPncScore' | 'lifeHealthScore' | 'urgencyScore' | 'riskAdjustment';

export interface RuleContext {
  units: number;
  drivers: number;
  cargo: string;
  statusText: string;
  operationText: string;
  rawText: string;
  insuranceText: string;
  daysSinceMcs150: number | null;
}

export interface ScoringRule {
  id: string;
  bucket: ScoreBucket;
  points: number;
  reason: string;
  products?: string[];
  applies: (carrier: NormalizedCarrier, ctx: RuleContext) => boolean;
}

export interface GradeBand {
  grade: 'A+' | 'A' | 'B' | 'C' | 'SKIP';
  minScore: number;
}

export const SCORING_VERSION = 'TRUCKING_INSURANCE_V1_2026_06_24';

export const GRADE_BANDS: GradeBand[] = [
  { grade: 'A+', minScore: 110 },
  { grade: 'A', minScore: 85 },
  { grade: 'B', minScore: 60 },
  { grade: 'C', minScore: 40 },
  { grade: 'SKIP', minScore: -9999 }
];

function hasAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

export function buildRuleContext(carrier: NormalizedCarrier): RuleContext {
  const mcsDate = carrier.mcs150Date ? new Date(carrier.mcs150Date).getTime() : Number.NaN;
  const daysSinceMcs150 = Number.isNaN(mcsDate) ? null : (Date.now() - mcsDate) / 86400000;
  return {
    units: carrier.powerUnits ?? 0,
    drivers: carrier.drivers ?? 0,
    cargo: carrier.cargo.join(' ').toLowerCase(),
    statusText: `${carrier.usdotStatus ?? ''} ${carrier.allowedToOperate ?? ''} ${carrier.authorityStatus ?? ''}`.toLowerCase(),
    operationText: `${carrier.carrierOperation ?? ''} ${carrier.entityType ?? ''} ${carrier.raw.authority_type ?? ''} ${carrier.raw.authority ?? ''}`.toLowerCase(),
    rawText: JSON.stringify(carrier.raw ?? {}).toLowerCase(),
    insuranceText: JSON.stringify(carrier.insuranceOnFile ?? {}).toLowerCase()
  };
}

export const SCORING_RULES: ScoringRule[] = [
  {
    id: 'STATUS_ACTIVE_AUTHORIZED',
    bucket: 'commercialPncScore',
    points: 25,
    reason: 'Active/authorized status signal',
    applies: (_carrier, ctx) => hasAny(ctx.statusText, ['active', 'allowed', 'authorized', 'granted'])
  },
  {
    id: 'OPERATION_FOR_HIRE_PROPERTY',
    bucket: 'commercialPncScore',
    points: 25,
    reason: 'For-hire/property carrier signal',
    products: ['Commercial Auto', 'Motor Truck Cargo'],
    applies: (_carrier, ctx) => hasAny(ctx.operationText, ['for hire', 'for-hire', 'property', 'common', 'contract']) && !hasAny(ctx.operationText, ['passenger only'])
  },
  {
    id: 'CONTACT_PHONE_PRESENT',
    bucket: 'commercialPncScore',
    points: 10,
    reason: 'Phone number available',
    applies: (carrier) => Boolean(carrier.phone)
  },
  {
    id: 'ADDRESS_CITY_STATE_PRESENT',
    bucket: 'commercialPncScore',
    points: 10,
    reason: 'Physical address available',
    applies: (carrier) => Boolean(carrier.physicalState && carrier.physicalCity)
  },
  {
    id: 'POWER_UNITS_6_TO_25',
    bucket: 'commercialPncScore',
    points: 30,
    reason: '6-25 power units: strong commercial P&C premium potential',
    applies: (_carrier, ctx) => ctx.units >= 6 && ctx.units <= 25
  },
  {
    id: 'POWER_UNITS_3_TO_5',
    bucket: 'commercialPncScore',
    points: 20,
    reason: '3-5 power units: good small-fleet opportunity',
    applies: (_carrier, ctx) => ctx.units >= 3 && ctx.units <= 5
  },
  {
    id: 'POWER_UNITS_1_TO_2',
    bucket: 'commercialPncScore',
    points: 12,
    reason: '1-2 power units: owner-operator opportunity',
    applies: (_carrier, ctx) => ctx.units >= 1 && ctx.units <= 2
  },
  {
    id: 'POWER_UNITS_ZERO',
    bucket: 'riskAdjustment',
    points: -20,
    reason: 'No power units found',
    applies: (_carrier, ctx) => ctx.units === 0
  },
  {
    id: 'DRIVERS_6_PLUS',
    bucket: 'lifeHealthScore',
    points: 25,
    reason: '6+ drivers: workers comp/benefits/key person opportunity',
    products: ['Workers Comp', 'Group Health / Benefits', 'Key Person Life'],
    applies: (_carrier, ctx) => ctx.drivers >= 6
  },
  {
    id: 'DRIVERS_3_TO_5',
    bucket: 'lifeHealthScore',
    points: 18,
    reason: '3+ drivers: small employer cross-sell opportunity',
    products: ['Workers Comp', 'Key Person Life'],
    applies: (_carrier, ctx) => ctx.drivers >= 3 && ctx.drivers <= 5
  },
  {
    id: 'DRIVERS_1_TO_2',
    bucket: 'lifeHealthScore',
    points: 12,
    reason: 'Owner-operator or small operator cross-sell opportunity',
    products: ['Occupational Accident', 'Owner Life Insurance'],
    applies: (_carrier, ctx) => ctx.drivers >= 1 && ctx.drivers <= 2
  },
  {
    id: 'CARGO_TEMPERATURE_SENSITIVE',
    bucket: 'commercialPncScore',
    points: 15,
    reason: 'Temperature-sensitive freight signal',
    products: ['Reefer Breakdown / Spoilage'],
    applies: (_carrier, ctx) => hasAny(ctx.cargo, ['refrigerated', 'fresh produce', 'meat'])
  },
  {
    id: 'CARGO_SPECIALTY_HIGHER_PREMIUM',
    bucket: 'commercialPncScore',
    points: 15,
    reason: 'Higher-premium cargo or specialty trucking signal',
    products: ['Physical Damage', 'Umbrella / Excess'],
    applies: (_carrier, ctx) => hasAny(ctx.cargo, ['motor vehicles', 'machinery', 'building materials', 'intermodal', 'household goods'])
  },
  {
    id: 'CARGO_GENERAL_FREIGHT_DRY_BULK',
    bucket: 'commercialPncScore',
    points: 8,
    reason: 'General freight or dry bulk signal',
    products: ['General Liability'],
    applies: (_carrier, ctx) => hasAny(ctx.cargo, ['general freight', 'dry bulk'])
  },
  {
    id: 'DOCKET_NUMBER_PRESENT',
    bucket: 'urgencyScore',
    points: 10,
    reason: 'Docket/MC number available',
    applies: (carrier) => Boolean(carrier.docketNumber)
  },
  {
    id: 'INSURANCE_OR_AUTHORITY_TRIGGER',
    bucket: 'urgencyScore',
    points: 20,
    reason: 'Insurance/authority trigger detected',
    products: ['Commercial Auto'],
    applies: (_carrier, ctx) => hasAny(`${ctx.insuranceText} ${ctx.statusText} ${ctx.rawText}`, ['pending', 'required', 'not on file'])
  },
  {
    id: 'MCS150_RECENT_120_DAYS',
    bucket: 'urgencyScore',
    points: 12,
    reason: 'Recent MCS-150 date',
    applies: (_carrier, ctx) => ctx.daysSinceMcs150 !== null && ctx.daysSinceMcs150 <= 120
  },
  {
    id: 'BAD_STATUS_SIGNAL',
    bucket: 'riskAdjustment',
    points: -45,
    reason: 'Inactive/revoked/not authorized/out-of-service status signal',
    applies: (_carrier, ctx) => hasAny(ctx.statusText, ['out-of-service', 'out of service', 'inactive', 'revoked', 'not authorized', 'not allowed'])
  },
  {
    id: 'BROKER_ONLY_NO_TRUCKS',
    bucket: 'riskAdjustment',
    points: -30,
    reason: 'Broker-only/no truck signal',
    applies: (_carrier, ctx) => hasAny(ctx.operationText, ['broker']) && ctx.units === 0
  }
];

export const DEFAULT_PRODUCT_RULES = [
  { id: 'DEFAULT_COMMERCIAL_AUTO', product: 'Commercial Auto', applies: (_carrier: NormalizedCarrier, _ctx: RuleContext) => true },
  { id: 'DEFAULT_PHYSICAL_DAMAGE', product: 'Physical Damage', applies: (_carrier: NormalizedCarrier, ctx: RuleContext) => ctx.units > 0 },
  { id: 'DEFAULT_UMBRELLA_EXCESS', product: 'Umbrella / Excess', applies: (_carrier: NormalizedCarrier, ctx: RuleContext) => ctx.units > 1 },
  { id: 'DEFAULT_OCC_ACC', product: 'Occupational Accident', applies: (_carrier: NormalizedCarrier, ctx: RuleContext) => ctx.drivers > 0 },
  { id: 'DEFAULT_KEY_PERSON', product: 'Key Person Life', applies: (_carrier: NormalizedCarrier, ctx: RuleContext) => ctx.units >= 3 || ctx.drivers >= 3 }
];

export function publicScoringRules() {
  return {
    version: SCORING_VERSION,
    gradeBands: GRADE_BANDS,
    rules: SCORING_RULES.map((rule) => ({
      id: rule.id,
      bucket: rule.bucket,
      points: rule.points,
      reason: rule.reason,
      products: rule.products ?? []
    })),
    defaultProductRules: DEFAULT_PRODUCT_RULES.map((rule) => ({ id: rule.id, product: rule.product }))
  };
}
