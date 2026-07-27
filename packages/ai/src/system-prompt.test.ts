import { describe, expect, it } from 'vitest';

import { AI_SYSTEM_PROMPT_VERSION, buildAiSystemPrompt } from './system-prompt';

describe('buildAiSystemPrompt', () => {
  it('expose une version stable et non vide', () => {
    expect(AI_SYSTEM_PROMPT_VERSION).toBeTruthy();
    expect(typeof AI_SYSTEM_PROMPT_VERSION).toBe('string');
  });

  it('déterministe : mêmes entrées → même sortie', () => {
    const context = { shopName: 'Boutique Test', currency: 'XAF' };
    expect(buildAiSystemPrompt(context)).toBe(buildAiSystemPrompt(context));
  });

  it('impose toutes les règles absolues', () => {
    const prompt = buildAiSystemPrompt({ shopName: 'Ma Boutique' });
    expect(prompt).toContain('Ma Boutique');
    expect(prompt.toLowerCase()).toContain('langue du client');
    expect(prompt.toLowerCase()).toContain('bref');
    expect(prompt).toMatch(/invente JAMAIS/i);
    expect(prompt.toLowerCase()).toContain('outils');
    expect(prompt.toLowerCase()).toContain('paiement');
    expect(prompt.toLowerCase()).toContain('lecture seule');
    expect(prompt.toLowerCase()).toContain('transfert');
    expect(prompt).toMatch(/SUGGEST_REPLY|structure imposée/i);
  });

  it('n’expose jamais de secret et reste bref', () => {
    const prompt = buildAiSystemPrompt({ shopName: 'X', businessRules: 'Pas de retour après 7 jours.' });
    expect(prompt).not.toMatch(/api[_-]?key|token|secret/i);
    expect(prompt).toContain('Pas de retour après 7 jours.');
  });

  it('adapte la consigne de langue quand une préférence est connue', () => {
    expect(buildAiSystemPrompt({ shopName: 'X', preferredLanguage: 'fr' })).toContain('fr');
  });

  it('omet proprement les champs de contexte absents', () => {
    const prompt = buildAiSystemPrompt({ shopName: 'X' });
    expect(prompt).toContain('(aucune information supplémentaire)');
  });
});
