import type { NormalizedCarrier } from '../fmcsa/normalize.js';

export type ScoreBucket = 'commercialPncScore' | 'lifeHealthScore' | 'urgencyScore' | 'riskAdjustment';

export interface RuleContext {
  units: number;
  drivers: number;
  state: string;
  cargo: string;
  statusText: string;
  operationText: string;
  companyText: string;
  rawText: string;
  insuranceText: string;
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

export const SCORING_VERSION = 'COMMERCIAL_PNC_V1_2026_06_25B';

export const GRADE_BANDS: GradeBand[] = [
  { grade: 'A+', minScore: 120 },
  { grade: 'A', minScore: 90 },
  { grade: 'B', minScore: 60 },
  { grade: 'C', minScore: 40 },
  { grade: 'SKIP', minScore: -9999 }
];

const US_STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'IA', 'ID', 'IL', 'IN', 'KS', 'KY',
  'LA', 'MA', 'MD', 'ME', 'MI', 'MN', 'MO', 'MS', 'MT', 'NC', 'ND', 'NE', 'NH', 'NJ', 'NM', 'NV', 'NY',
  'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VA', 'VT', 'WA', 'WI', 'WV', 'WY', 'DC'
]);

const WAVE_1_STATES = new Set(['TX', 'FL', 'GA', 'NC', 'AZ', 'TN']);
const WAVE_2_STATES = new Set(['OH', 'PA', 'NJ', 'IL', 'MI', 'SC']);
const WAVE_3_STATES = new Set(['CA', 'NY', 'MA', 'WA', 'CO', 'VA']);

function hasAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

export function buildRuleContext(carrier: NormalizedCarrier): RuleContext {
  return {
    units: carrier.powerUnits ?? 0,
    drivers: carrier.drivers ?? 0,
    state: (carrier.physicalState ?? carrier.mailingState ?? '').toUpperCase(),
    cargo: carrier.cargo.join(' ').toLowerCase(),
    statusText: `${carrier.usdotStatus ?? ''} ${carrier.allowedToOperate ?? ''} ${carrier.authorityStatus ?? ''}`.toLowerCase(),
    operationText: `${carrier.carrierOperation ?? ''} ${carrier.entityType ?? ''} ${carrier.raw.authority_type ?? ''} ${carrier.raw.authority ?? ''}`.toLowerCase(),
    companyText: `${carrier.legalName ?? ''} ${carrier.dbaName ?? ''}`.toLowerCase(),
    rawText: JSON.stringify(carrier.raw ?? {}).toLowerCase(),
    insuranceText: JSON.stringify(carrier.insuranceOnFile ?? {}).toLowerCase()
  };
}

export const SCORING_RULES: ScoringRule[] = [
  {
    id: 'STATE_PRIORITY_WAVE_1',
    bucket: 'commercialPncScore',
    points: 12,
    reason: 'Wave 1 commercial P&C target state',
    applies: (_carrier, ctx) => WAVE_1_STATES.has(ctx.state)
  },
  {
    id: 'STATE_PRIORITY_WAVE_2',
    bucket: 'commercialPncScore',
    points: 6,
    reason: 'Wave 2 commercial P&C target state',
    applies: (_carrier, ctx) => WAVE_2_STATES.has(ctx.state)
  },
  {
    id: 'STATE_PRIORITY_WAVE_3',
    bucket: 'commercialPncScore',
    points: 3,
    reason: 'Wave 3 commercial P&C target state',
    applies: (_carrier, ctx) => WAVE_3_STATES.has(ctx.state)
  },
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
    id: 'CONTACT_EMAIL_PRESENT',
    bucket: 'commercialPncScore',
    points: 5,
    reason: 'Company email available',
    applies: (carrier) => Boolean(carrier.email)
  },
  {
    id: 'FULL_PHYSICAL_ADDRESS_PRESENT',
    bucket: 'commercialPncScore',
    points: 12,
    reason: 'Full physical base address available',
    applies: (carrier) => Boolean(carrier.physicalStreet && carrier.physicalCity && carrier.physicalState && carrier.physicalZip)
  },
  {
    id: 'ADDRESS_CITY_STATE_PRESENT',
    bucket: 'commercialPncScore',
    points: 6,
    reason: 'Physical city/state available',
    applies: (carrier) => Boolean(carrier.physicalState && carrier.physicalCity && !carrier.physicalStreet)
  },
  {
    id: 'POWER_UNITS_26_TO_99',
    bucket: 'commercialPncScore',
    points: 40,
    reason: '26-99 power units: larger fleet with stronger commercial auto and umbrella premium potential',
    products: ['Commercial Auto', 'Umbrella / Excess', 'Workers Comp'],
    applies: (_carrier, ctx) => ctx.units >= 26 && ctx.units <= 99
  },
  {
    id: 'POWER_UNITS_100_PLUS',
    bucket: 'commercialPncScore',
    points: 35,
    reason: '100+ power units: enterprise fleet opportunity requiring separate appetite/market review',
    products: ['Commercial Auto', 'Umbrella / Excess', 'Workers Comp'],
    applies: (_carrier, ctx) => ctx.units >= 100
  },
  {
    id: 'POWER_UNITS_6_TO_25',
    bucket: 'commercialPncScore',
    points: 30,
    reason: '6-25 power units: strong commercial auto premium potential',
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
    id: 'MCS150_DATE_PRESENT',
    bucket: 'urgencyScore',
    points: 8,
    reason: 'MCS-150 date available',
    applies: (carrier) => Boolean(carrier.mcs150Date)
  },
  {
    id: 'NON_US_REGISTRY_OR_BASE',
    bucket: 'riskAdjustment',
    points: -65,
    reason: 'Non-U.S. base/state should be excluded from first U.S. commercial P&C campaign',
    applies: (_carrier, ctx) => Boolean(ctx.state) && !US_STATES.has(ctx.state)
  },
  {
    id: 'LIVERY_PASSENGER_SEPARATE_CAMPAIGN',
    bucket: 'riskAdjustment',
    points: -35,
    reason: 'Passenger/livery account should be handled in a separate commercial auto campaign',
    products: ['Livery / Commercial Auto'],
    applies: (_carrier, ctx) => hasAny(`${ctx.companyText} ${ctx.operationText}`, ['limo', 'limousine', 'passenger', 'taxi', 'bus', 'shuttle', 'chauffeur'])
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
  { id: 'DEFAULT_WORKERS_COMP', product: 'Workers Comp', applies: (_carrier: NormalizedCarrier, ctx: RuleContext) => ctx.drivers >= 3 },
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
