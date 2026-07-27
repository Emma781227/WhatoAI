import { z } from 'zod';

const optionalString = (max: number, message?: string) =>
  z.string().trim().max(max, message).optional().or(z.literal(''));

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Sentinelle du Select « aucun type » (Radix n'accepte pas la valeur vide). */
export const BUSINESS_TYPE_NONE = 'NONE';

export const BUSINESS_TYPES = [
  'RETAIL',
  'FASHION',
  'BEAUTY',
  'FOOD',
  'RESTAURANT',
  'ELECTRONICS',
  'SERVICES',
  'HEALTH',
  'EDUCATION',
  'TRAVEL',
  'OTHER',
] as const;

export const BUSINESS_TYPE_LABELS: Record<string, string> = {
  RETAIL: 'Commerce de détail',
  FASHION: 'Mode',
  BEAUTY: 'Beauté & cosmétiques',
  FOOD: 'Alimentation',
  RESTAURANT: 'Restaurant',
  ELECTRONICS: 'Électronique',
  SERVICES: 'Services',
  HEALTH: 'Santé',
  EDUCATION: 'Éducation',
  TRAVEL: 'Voyage',
  OTHER: 'Autre',
};

export const shopFormSchema = z.object({
  name: z.string().trim().min(2, 'Au moins 2 caractères').max(100, 'Au plus 100 caractères'),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(SLUG_PATTERN, 'Minuscules, chiffres et tirets simples uniquement')
    .min(2)
    .max(50)
    .optional()
    .or(z.literal('')),
  description: optionalString(500, 'Au plus 500 caractères'),
  businessType: z.enum([BUSINESS_TYPE_NONE, ...BUSINESS_TYPES]),
  countryCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, 'Code pays ISO à 2 lettres (ex. CM)'),
  timezone: z.string().trim().min(1, 'Fuseau horaire requis'),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'Code devise ISO 4217 (3 lettres)'),
  locale: z.string().trim().min(2, 'Locale requise').max(10),
  supportEmail: z.string().trim().email('Adresse email invalide').optional().or(z.literal('')),
  supportPhone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ().-]{6,20}$/, 'Numéro de téléphone invalide')
    .optional()
    .or(z.literal('')),
  websiteUrl: z.string().trim().url('URL invalide').optional().or(z.literal('')),
  logoUrl: z.string().trim().url('URL invalide').optional().or(z.literal('')),
  coverUrl: z.string().trim().url('URL invalide').optional().or(z.literal('')),
  addressLine1: optionalString(200),
  addressLine2: optionalString(200),
  city: optionalString(100),
  region: optionalString(100),
  postalCode: optionalString(20),
  returnPolicy: optionalString(2000, 'Au plus 2000 caractères'),
  deliveryPolicy: optionalString(2000, 'Au plus 2000 caractères'),
  orderInstructions: optionalString(2000, 'Au plus 2000 caractères'),
});

export type ShopFormValues = z.infer<typeof shopFormSchema>;

export const SHOP_FORM_DEFAULTS: ShopFormValues = {
  name: '',
  slug: '',
  description: '',
  businessType: BUSINESS_TYPE_NONE,
  countryCode: 'CM',
  timezone: 'Africa/Douala',
  currency: 'XAF',
  locale: 'fr',
  supportEmail: '',
  supportPhone: '',
  websiteUrl: '',
  logoUrl: '',
  coverUrl: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  region: '',
  postalCode: '',
  returnPolicy: '',
  deliveryPolicy: '',
  orderInstructions: '',
};
