import type { NormalizedCarrier } from '../fmcsa/normalize.js';

export interface LeadScore {
  leadGrade: 'A+' | 'A' | 'B' | 'C' | 'SKIP';
  leadScore: number;
  commercialPncScore: number;
  lifeHealthScore: number;
  urgencyScore: number;
  riskAdjustment: number;
  recommendedProducts: string[];
  outreachAngle: string;
  scoringReasons: string[];
}

function text(value: unknown): string {
  return String(value ?? '').toLowerCase();
}

function hasAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

function cargoText(carrier: NormalizedCarrier): string {
  return carrier.cargo.join(' ').toLowerCase();
}

function isActive(carrier: NormalizedCarrier): boolean {
  const combined = `${carrier.usdotStatus ?? ''} ${carrier.allowedToOperate ?? ''} ${carrier.authorityStatus ?? ''}`.toLowerCase();
  return hasAny(combined, ['active', 'allowed', 'authorized', 'granted']);
}

function isBadStatus(carrier: NormalizedCarrier): boolean {
  const combined = `${carrier.usdotStatus ?? ''} ${carrier.allowedToOperate ?? ''} ${carrier.authorityStatus ?? ''}`.toLowerCase();
  return hasAny(combined, ['out-of-service', 'out of service', 'inactive', 'revoked', 'not authorized', 'not allowed']);
}

function isForHireProperty(carrier: NormalizedCarrier): boolean {
  const combined = `${carrier.carrierOperation ?? ''} ${carrier.entityType ?? ''} ${carrier.raw.authority_type ?? ''} ${carrier.raw.authority ?? ''}`.toLowerCase();
  return hasAny(combined, ['for hire', 'for-hire', 'property', 'common', 'contract']) && !hasAny(combined, ['passenger only']);
}

function isBrokerOnly(carrier: NormalizedCarrier): boolean {
  const combined = `${carrier.entityType ?? ''} ${carrier.carrierOperation ?? ''} ${carrier.raw.authority_type ?? ''}`.toLowerCase();
  const units = carrier.powerUnits ?? 0;
  return hasAny(combined, ['broker']) && units === 0;
}

function hasInsuranceTrigger(carrier: NormalizedCarrier): boolean {
  const raw = JSON.stringify(carrier.insuranceOnFile).toLowerCase();
  const status = `${carrier.authorityStatus ?? ''} ${carrier.raw.insurance_status ?? ''} ${carrier.raw.insurance_required ?? ''} ${carrier.raw.bipd_required ?? ''}`.toLowerCase();
  return hasAny(`${raw} ${status}`, ['pending', 'required', 'not on file', 'no', 'n']);
}

export function scoreCarrier(carrier: NormalizedCarrier): LeadScore {
  let commercialPncScore = 0;
  let lifeHealthScore = 0;
  let urgencyScore = 0;
  let riskAdjustment = 0;
  const reasons: string[] = [];
  const products = new Set<string>();
  const units = carrier.powerUnits ?? 0;
  const drivers = carrier.drivers ?? 0;
  const cargo = cargoText(carrier);

  if (isActive(carrier)) {
    commercialPncScore += 25;
    reasons.push('Active/authorized status signal');
  }
  if (isForHireProperty(carrier)) {
    commercialPncScore += 25;
    reasons.push('For-hire/property carrier signal');
    products.add('Commercial Auto');
    products.add('Motor Truck Cargo');
  }
  if (carrier.phone) {
    commercialPncScore += 10;
    reasons.push('Phone number available');
  }
  if (carrier.physicalState && carrier.physicalCity) {
    commercialPncScore += 10;
    reasons.push('Physical address available');
  }

  if (units >= 6 && units <= 25) {
    commercialPncScore += 30;
    reasons.push('6-25 power units: strong commercial P&C premium potential');
  } else if (units >= 3 && units <= 5) {
    commercialPncScore += 20;
    reasons.push('3-5 power units: good small-fleet opportunity');
  } else if (units >= 1 && units <= 2) {
    commercialPncScore += 12;
    reasons.push('1-2 power units: owner-operator opportunity');
  } else if (units === 0) {
    riskAdjustment -= 20;
    reasons.push('No power units found');
  }

  if (drivers >= 6) {
    lifeHealthScore += 25;
    products.add('Workers Comp');
    products.add('Group Health / Benefits');
    products.add('Key Person Life');
    reasons.push('6+ drivers: workers comp/benefits/key person opportunity');
  } else if (drivers >= 3) {
    lifeHealthScore += 18;
    products.add('Workers Comp');
    products.add('Key Person Life');
    reasons.push('3+ drivers: small employer cross-sell opportunity');
  } else if (drivers >= 1) {
    lifeHealthScore += 12;
    products.add('Occupational Accident');
    products.add('Owner Life Insurance');
    reasons.push('Owner-operator or small operator cross-sell opportunity');
  }

  if (hasAny(cargo, ['refrigerated', 'fresh produce', 'meat'])) {
    commercialPncScore += 15;
    products.add('Reefer Breakdown / Spoilage');
    reasons.push('Temperature-sensitive freight signal');
  }
  if (hasAny(cargo, ['motor vehicles', 'machinery', 'building materials', 'intermodal', 'household goods'])) {
    commercialPncScore += 15;
    products.add('Physical Damage');
    products.add('Umbrella / Excess');
    reasons.push('Higher-premium cargo or specialty trucking signal');
  }
  if (hasAny(cargo, ['general freight', 'dry bulk'])) {
    commercialPncScore += 8;
    products.add('General Liability');
    reasons.push('General freight or dry bulk signal');
  }

  if (carrier.docketNumber) {
    urgencyScore += 10;
    reasons.push('Docket/MC number available');
  }
  if (hasInsuranceTrigger(carrier)) {
    urgencyScore += 20;
    products.add('Commercial Auto');
    reasons.push('Insurance/authority trigger detected');
  }
  if (carrier.mcs150Date) {
    const daysOld = (Date.now() - new Date(carrier.mcs150Date).getTime()) / 86400000;
    if (daysOld <= 120) {
      urgencyScore += 12;
      reasons.push('Recent MCS-150 date');
    }
  }

  if (isBadStatus(carrier)) {
    riskAdjustment -= 45;
    reasons.push('Inactive/revoked/not authorized/out-of-service status signal');
  }
  if (isBrokerOnly(carrier)) {
    riskAdjustment -= 30;
    reasons.push('Broker-only/no truck signal');
  }

  products.add('Commercial Auto');
  if (units > 0) products.add('Physical Damage');
  if (units > 1) products.add('Umbrella / Excess');
  if (drivers > 0) products.add('Occupational Accident');
  if (units >= 3 || drivers >= 3) products.add('Key Person Life');

  const leadScore = commercialPncScore + lifeHealthScore + urgencyScore + riskAdjustment;
  let leadGrade: LeadScore['leadGrade'] = 'SKIP';
  if (leadScore >= 110) leadGrade = 'A+';
  else if (leadScore >= 85) leadGrade = 'A';
  else if (leadScore >= 60) leadGrade = 'B';
  else if (leadScore >= 40) leadGrade = 'C';

  const company = carrier.dbaName || carrier.legalName || `USDOT ${carrier.usdotNumber}`;
  const outreachAngle = `${company} looks like a trucking P&C lead with ${units || 'unknown'} power units and ${drivers || 'unknown'} drivers. Lead with commercial auto, cargo/physical damage, then cross-sell owner protection, occupational accident, workers comp, key person, or benefits based on driver count.`;

  return {
    leadGrade,
    leadScore,
    commercialPncScore,
    lifeHealthScore,
    urgencyScore,
    riskAdjustment,
    recommendedProducts: [...products],
    outreachAngle,
    scoringReasons: reasons
  };
}
