import { describe, expect, it } from 'vitest';

import {
  AI_CREDIT_PRICING_VERSION,
  computeAiRunCredits,
  MAX_CREDITS_PER_AI_RUN,
} from './pricing';

describe('computeAiRunCredits — grille v1', () => {
  it('SUGGEST_REPLY sans outil = 1 crédit', () => {
    expect(computeAiRunCredits({ outcome: 'SUGGEST_REPLY', successfulToolCalls: 0 })).toEqual({
      creditsRequired: 1,
      pricingVersion: 'v1',
      reasonCode: 'SUGGEST_REPLY_NO_TOOL',
    });
  });

  it('SUGGEST_REPLY avec 1 outil = 2 crédits', () => {
    expect(computeAiRunCredits({ outcome: 'SUGGEST_REPLY', successfulToolCalls: 1 })).toMatchObject({
      creditsRequired: 2,
      reasonCode: 'SUGGEST_REPLY_ONE_TOOL',
    });
  });

  it('SUGGEST_REPLY avec 2 outils = 3 crédits', () => {
    expect(computeAiRunCredits({ outcome: 'SUGGEST_REPLY', successfulToolCalls: 2 }).creditsRequired).toBe(3);
  });

  it('plafonné à MAX_CREDITS_PER_AI_RUN même avec beaucoup d’outils', () => {
    const r = computeAiRunCredits({ outcome: 'SUGGEST_REPLY', successfulToolCalls: 10 });
    expect(r.creditsRequired).toBe(MAX_CREDITS_PER_AI_RUN);
    expect(r.reasonCode).toBe('SUGGEST_REPLY_MULTI_TOOL');
  });

  it('successfulToolCalls négatif/fractionnaire traité comme 0/plancher', () => {
    expect(computeAiRunCredits({ outcome: 'SUGGEST_REPLY', successfulToolCalls: -5 }).creditsRequired).toBe(1);
    expect(computeAiRunCredits({ outcome: 'SUGGEST_REPLY', successfulToolCalls: 1.9 }).creditsRequired).toBe(2);
  });

  it.each([
    ['HANDOFF', 'NOT_BILLABLE_HANDOFF'],
    ['NO_REPLY', 'NOT_BILLABLE_NO_REPLY'],
    ['FAILED', 'NOT_BILLABLE_FAILED'],
    ['SUPERSEDED', 'NOT_BILLABLE_SUPERSEDED'],
    ['SKIPPED', 'NOT_BILLABLE_SKIPPED'],
  ] as const)('%s n’est PAS facturé (0 crédit)', (outcome, reason) => {
    const r = computeAiRunCredits({ outcome, successfulToolCalls: 3 });
    expect(r.creditsRequired).toBe(0);
    expect(r.reasonCode).toBe(reason);
  });

  it('la version de tarification est exposée', () => {
    expect(AI_CREDIT_PRICING_VERSION).toBe('v1');
    expect(computeAiRunCredits({ outcome: 'SUGGEST_REPLY', successfulToolCalls: 0 }).pricingVersion).toBe('v1');
  });
});
