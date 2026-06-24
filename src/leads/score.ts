import type { NormalizedCarrier } from '../fmcsa/normalize.js';
import { buildRuleContext, DEFAULT_PRODUCT_RULES, GRADE_BANDS, SCORING_RULES, SCORING_VERSION } from './scoringRules.js';

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
  scoringVersion: string;
  appliedRuleIds: string[];
}

export function scoreCarrier(carrier: NormalizedCarrier): LeadScore {
  const ctx = buildRuleContext(carrier);
  const products = new Set<string>();
  const reasons: string[] = [];
  const appliedRuleIds: string[] = [];

  const totals = {
    commercialPncScore: 0,
    lifeHealthScore: 0,
    urgencyScore: 0,
    riskAdjustment: 0
  };

  for (const rule of SCORING_RULES) {
    if (!rule.applies(carrier, ctx)) continue;
    totals[rule.bucket] += rule.points;
    reasons.push(`${rule.id}: ${rule.reason} (${rule.points > 0 ? '+' : ''}${rule.points})`);
    appliedRuleIds.push(rule.id);
    for (const product of rule.products ?? []) products.add(product);
  }

  for (const rule of DEFAULT_PRODUCT_RULES) {
    if (rule.applies(carrier, ctx)) products.add(rule.product);
  }

  const leadScore = totals.commercialPncScore + totals.lifeHealthScore + totals.urgencyScore + totals.riskAdjustment;
  const leadGrade = GRADE_BANDS.find((band) => leadScore >= band.minScore)?.grade ?? 'SKIP';
  const company = carrier.dbaName || carrier.legalName || `USDOT ${carrier.usdotNumber}`;
  const outreachAngle = `${company} looks like a trucking P&C lead with ${ctx.units || 'unknown'} power units and ${ctx.drivers || 'unknown'} drivers. Lead with commercial auto, cargo/physical damage, then cross-sell owner protection, occupational accident, workers comp, key person, or benefits based on driver count.`;

  return {
    leadGrade,
    leadScore,
    commercialPncScore: totals.commercialPncScore,
    lifeHealthScore: totals.lifeHealthScore,
    urgencyScore: totals.urgencyScore,
    riskAdjustment: totals.riskAdjustment,
    recommendedProducts: [...products].sort(),
    outreachAngle,
    scoringReasons: reasons,
    scoringVersion: SCORING_VERSION,
    appliedRuleIds
  };
}
