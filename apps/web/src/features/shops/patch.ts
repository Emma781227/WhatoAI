import type { CreateShopInput, UpdateShopInput } from './api';
import { BUSINESS_TYPE_NONE, type ShopFormValues } from './schemas';

/** Champs optionnels backend : une valeur vide devient `null` (effacement). */
const CLEARABLE_FIELDS = [
  'description',
  'businessType',
  'logoUrl',
  'coverUrl',
  'websiteUrl',
  'supportEmail',
  'supportPhone',
  'addressLine1',
  'addressLine2',
  'city',
  'region',
  'postalCode',
  'returnPolicy',
  'deliveryPolicy',
  'orderInstructions',
] as const;

/** Champs requis backend : jamais null ; une valeur vide = champ non envoyé. */
const REQUIRED_FIELDS = ['name', 'slug', 'countryCode', 'timezone', 'currency', 'locale'] as const;

type DirtyFields = Partial<Record<keyof ShopFormValues, unknown>>;

function isDirty(dirtyFields: DirtyFields, field: keyof ShopFormValues): boolean {
  return Boolean(dirtyFields[field]);
}

/**
 * Convention PATCH backend : `undefined` = champ inchangé (absent du body),
 * `null` = effacement d'un champ optionnel. Seuls les champs modifiés
 * (dirtyFields de react-hook-form) sont envoyés — jamais organizationId,
 * status, isPrimary, archivedAt ni createdByUserId.
 */
export function buildShopPatch(dirtyFields: DirtyFields, values: ShopFormValues): UpdateShopInput {
  const patch: UpdateShopInput = {};

  for (const field of REQUIRED_FIELDS) {
    if (!isDirty(dirtyFields, field)) {
      continue;
    }
    const value = values[field]?.trim() ?? '';
    if (value !== '') {
      patch[field] = field === 'countryCode' || field === 'currency' ? value.toUpperCase() : value;
    }
  }

  for (const field of CLEARABLE_FIELDS) {
    if (!isDirty(dirtyFields, field)) {
      continue;
    }
    if (field === 'businessType') {
      patch.businessType =
        values.businessType === BUSINESS_TYPE_NONE
          ? null
          : (values.businessType as UpdateShopInput['businessType']);
      continue;
    }
    const value = values[field]?.trim() ?? '';
    patch[field] = value === '' ? null : value;
  }

  return patch;
}

/** Corps de création : uniquement les champs acceptés par POST /shops, sans valeurs vides. */
export function buildShopCreateInput(values: ShopFormValues): CreateShopInput {
  const input: CreateShopInput = {
    name: values.name.trim(),
    countryCode: values.countryCode.toUpperCase(),
  };
  if (values.slug && values.slug.trim() !== '') {
    input.slug = values.slug.trim();
  }
  if (values.description && values.description.trim() !== '') {
    input.description = values.description.trim();
  }
  if (values.businessType !== BUSINESS_TYPE_NONE) {
    input.businessType = values.businessType as CreateShopInput['businessType'];
  }
  if (values.timezone.trim() !== '') {
    input.timezone = values.timezone.trim();
  }
  if (values.currency.trim() !== '') {
    input.currency = values.currency.toUpperCase();
  }
  if (values.locale.trim() !== '') {
    input.locale = values.locale.trim();
  }
  return input;
}

/** Valeurs de formulaire depuis une Shop existante (null → chaîne vide). */
export function shopToFormValues(shop: {
  name: string;
  slug: string;
  description: string | null;
  businessType: string | null;
  countryCode: string;
  timezone: string;
  currency: string;
  locale: string;
  supportEmail: string | null;
  supportPhone: string | null;
  websiteUrl: string | null;
  logoUrl: string | null;
  coverUrl: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  returnPolicy: string | null;
  deliveryPolicy: string | null;
  orderInstructions: string | null;
}): ShopFormValues {
  return {
    name: shop.name,
    slug: shop.slug,
    description: shop.description ?? '',
    businessType: (shop.businessType ?? BUSINESS_TYPE_NONE) as ShopFormValues['businessType'],
    countryCode: shop.countryCode,
    timezone: shop.timezone,
    currency: shop.currency,
    locale: shop.locale,
    supportEmail: shop.supportEmail ?? '',
    supportPhone: shop.supportPhone ?? '',
    websiteUrl: shop.websiteUrl ?? '',
    logoUrl: shop.logoUrl ?? '',
    coverUrl: shop.coverUrl ?? '',
    addressLine1: shop.addressLine1 ?? '',
    addressLine2: shop.addressLine2 ?? '',
    city: shop.city ?? '',
    region: shop.region ?? '',
    postalCode: shop.postalCode ?? '',
    returnPolicy: shop.returnPolicy ?? '',
    deliveryPolicy: shop.deliveryPolicy ?? '',
    orderInstructions: shop.orderInstructions ?? '',
  };
}
