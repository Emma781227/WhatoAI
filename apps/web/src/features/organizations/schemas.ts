import { z } from 'zod';

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const organizationFormSchema = z.object({
  name: z.string().trim().min(2, 'Au moins 2 caractères').max(100, 'Au plus 100 caractères'),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(SLUG_PATTERN, 'Minuscules, chiffres et tirets simples uniquement')
    .min(2)
    .max(50)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  timezone: z.string().trim().min(1, 'Fuseau horaire requis'),
  defaultCurrency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'Code devise ISO 4217 (3 lettres)'),
  defaultLocale: z.string().trim().min(2, 'Locale requise').max(10),
});

export type OrganizationFormValues = z.infer<typeof organizationFormSchema>;

export const ORGANIZATION_FORM_DEFAULTS: OrganizationFormValues = {
  name: '',
  slug: undefined,
  timezone: 'Africa/Douala',
  defaultCurrency: 'XAF',
  defaultLocale: 'fr',
};
