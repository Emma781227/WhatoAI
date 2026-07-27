import { describe, expect, it } from 'vitest';

import { buildShopCreateInput, buildShopPatch, shopToFormValues } from './patch';
import { BUSINESS_TYPE_NONE, SHOP_FORM_DEFAULTS, type ShopFormValues } from './schemas';

function values(overrides: Partial<ShopFormValues> = {}): ShopFormValues {
  return { ...SHOP_FORM_DEFAULTS, ...overrides };
}

describe('buildShopPatch — convention undefined/null', () => {
  it('champ non touché → absent du body (undefined)', () => {
    const patch = buildShopPatch({ name: true }, values({ name: 'Nouveau Nom', description: 'ignorée' }));
    expect(patch).toEqual({ name: 'Nouveau Nom' });
    expect('description' in patch).toBe(false);
  });

  it('champ optionnel vidé → null (effacement)', () => {
    const patch = buildShopPatch(
      { description: true, supportEmail: true },
      values({ description: '', supportEmail: '' }),
    );
    expect(patch.description).toBeNull();
    expect(patch.supportEmail).toBeNull();
  });

  it('champ optionnel rempli → valeur', () => {
    const patch = buildShopPatch({ returnPolicy: true }, values({ returnPolicy: 'Retours sous 7 jours' }));
    expect(patch.returnPolicy).toBe('Retours sous 7 jours');
  });

  it('businessType : sentinelle NONE → null, valeur → enum', () => {
    expect(buildShopPatch({ businessType: true }, values({ businessType: BUSINESS_TYPE_NONE }))).toEqual({
      businessType: null,
    });
    expect(buildShopPatch({ businessType: true }, values({ businessType: 'RESTAURANT' }))).toEqual({
      businessType: 'RESTAURANT',
    });
  });

  it('champs requis : jamais null — vidé = non envoyé ; normalisation majuscules', () => {
    const patch = buildShopPatch(
      { slug: true, currency: true, countryCode: true },
      values({ slug: '', currency: 'eur', countryCode: 'fr' }),
    );
    expect('slug' in patch).toBe(false);
    expect(patch.currency).toBe('EUR');
    expect(patch.countryCode).toBe('FR');
  });

  it('ne contient JAMAIS organizationId, status, isPrimary, archivedAt, createdByUserId', () => {
    // Tous les champs marqués dirty : le patch complet ne doit contenir aucun champ interdit.
    const allDirty = Object.fromEntries(Object.keys(SHOP_FORM_DEFAULTS).map((key) => [key, true]));
    const patch = buildShopPatch(allDirty, values({ name: 'X Y', description: 'desc' }));
    for (const forbidden of ['organizationId', 'status', 'isPrimary', 'archivedAt', 'createdByUserId']) {
      expect(forbidden in patch).toBe(false);
    }
  });

  it('aucun champ dirty → patch vide', () => {
    expect(buildShopPatch({}, values())).toEqual({});
  });
});

describe('buildShopCreateInput', () => {
  it('inclut uniquement les champs acceptés par POST /shops, sans valeurs vides', () => {
    const input = buildShopCreateInput(
      values({ name: ' Boutique Akwa ', countryCode: 'cm', slug: '', description: '' }),
    );
    expect(input).toEqual({
      name: 'Boutique Akwa',
      countryCode: 'CM',
      timezone: 'Africa/Douala',
      currency: 'XAF',
      locale: 'fr',
    });
  });

  it('slug et businessType inclus quand fournis', () => {
    const input = buildShopCreateInput(values({ slug: 'ma-boutique', businessType: 'FOOD' }));
    expect(input.slug).toBe('ma-boutique');
    expect(input.businessType).toBe('FOOD');
  });
});

describe('shopToFormValues', () => {
  it('null → chaîne vide / sentinelle NONE (aller-retour stable)', () => {
    const formValues = shopToFormValues({
      name: 'Shop',
      slug: 'shop',
      description: null,
      businessType: null,
      countryCode: 'CM',
      timezone: 'Africa/Douala',
      currency: 'XAF',
      locale: 'fr',
      supportEmail: null,
      supportPhone: null,
      websiteUrl: null,
      logoUrl: null,
      coverUrl: null,
      addressLine1: null,
      addressLine2: null,
      city: null,
      region: null,
      postalCode: null,
      returnPolicy: null,
      deliveryPolicy: null,
      orderInstructions: null,
    });
    expect(formValues.description).toBe('');
    expect(formValues.businessType).toBe(BUSINESS_TYPE_NONE);
    // Aller-retour : rien de dirty → patch vide.
    expect(buildShopPatch({}, formValues)).toEqual({});
  });
});
