import { Prisma } from '@whauto/database';
import {
  DuplicateVariantCombinationError,
  InvalidSkuFormatError,
  ValidationError,
  VariantBarcodeAlreadyUsedError,
  VariantSkuAlreadyUsedError,
} from '@whauto/shared';

import { ROLE_PERMISSIONS } from '../../common/tenant/permissions';
import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import type { PrismaService } from '../../prisma/prisma.service';
import type { OrganizationAuditService } from '../organizations/organization-audit.service';
import type { CreateProductDto } from './dto/product-inputs.dto';
import {
  prepareImages,
  ProductsService,
  translateVariantUniqueError,
  validateImageUrl,
} from './products.service';

const TENANT: TenantContext = {
  userId: 'user-1',
  organizationId: 'org-1',
  membershipId: 'membership-1',
  role: 'ADMIN',
  permissions: ROLE_PERMISSIONS.ADMIN,
};

function p2002(target: string[]): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('unique', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target },
  });
}

function buildService() {
  const prisma = {
    shop: {
      findFirst: jest.fn().mockResolvedValue({ id: 'shop-1', status: 'ACTIVE', currency: 'XAF' }),
    },
    productCategory: { findFirst: jest.fn() },
    product: { findFirst: jest.fn() },
    $transaction: jest.fn(),
  };
  const auditService = { record: jest.fn().mockResolvedValue({}) };
  const service = new ProductsService(
    prisma as unknown as PrismaService,
    auditService as unknown as OrganizationAuditService,
  );
  return { service, prisma };
}

function dto(overrides: Partial<CreateProductDto>): CreateProductDto {
  return {
    name: 'Chemise classique',
    variants: [{ sku: 'CHE-001', priceMinor: 15000 }],
    ...overrides,
  } as CreateProductDto;
}

describe('validateImageUrl', () => {
  it('accepte http(s) sans credentials, refuse le reste', () => {
    expect(() => validateImageUrl('https://cdn.exemple.com/a.jpg')).not.toThrow();
    expect(() => validateImageUrl('ftp://exemple.com/a.jpg')).toThrow(ValidationError);
    expect(() => validateImageUrl('javascript:alert(1)')).toThrow(ValidationError);
    expect(() => validateImageUrl('https://user:pass@exemple.com/a.jpg')).toThrow(ValidationError);
    expect(() => validateImageUrl('pas-une-url')).toThrow(ValidationError);
  });
});

describe('prepareImages', () => {
  it('positions déterministes, première image principale par défaut', () => {
    const images = prepareImages([
      { url: 'https://x.com/1.jpg' },
      { url: 'https://x.com/2.jpg' },
    ]);
    expect(images[0]).toMatchObject({ position: 0, isPrimary: true });
    expect(images[1]).toMatchObject({ position: 1, isPrimary: false });
  });

  it('au plus une image principale', () => {
    expect(() =>
      prepareImages([
        { url: 'https://x.com/1.jpg', isPrimary: true },
        { url: 'https://x.com/2.jpg', isPrimary: true },
      ]),
    ).toThrow(ValidationError);
  });
});

describe('translateVariantUniqueError — P2002 par cible', () => {
  it('sku → VariantSkuAlreadyUsedError', () => {
    expect(() => translateVariantUniqueError(p2002(['shopId', 'sku']))).toThrow(
      VariantSkuAlreadyUsedError,
    );
  });
  it('barcode → VariantBarcodeAlreadyUsedError', () => {
    expect(() => translateVariantUniqueError(p2002(['shopId', 'barcode']))).toThrow(
      VariantBarcodeAlreadyUsedError,
    );
  });
  it('combinationKey (index partiel brut → colonnes) → DuplicateVariantCombinationError', () => {
    expect(() => translateVariantUniqueError(p2002(['productId', 'combinationKey']))).toThrow(
      DuplicateVariantCombinationError,
    );
  });
  it('autre erreur relancée telle quelle', () => {
    const error = new Error('boom');
    expect(() => translateVariantUniqueError(error)).toThrow('boom');
  });
});

describe('ProductsService.createFull — validations AVANT transaction', () => {
  it('SERVICE/DIGITAL : trackInventory=true explicitement refusé', async () => {
    const { service } = buildService();
    await expect(
      service.createFull(
        TENANT,
        'shop-1',
        dto({
          productType: 'SERVICE',
          variants: [{ sku: 'SVC-1', priceMinor: 5000, trackInventory: true }],
        }),
        {},
      ),
    ).rejects.toThrow(ValidationError);
  });

  it('SERVICE : stock initial refusé (trackInventory forcé à false)', async () => {
    const { service } = buildService();
    await expect(
      service.createFull(
        TENANT,
        'shop-1',
        dto({
          productType: 'DIGITAL',
          variants: [{ sku: 'DIG-1', priceMinor: 5000, initialQuantity: 3 }],
        }),
        {},
      ),
    ).rejects.toThrow(ValidationError);
  });

  it('SKU invalide refusé (format strict)', async () => {
    const { service } = buildService();
    await expect(
      service.createFull(
        TENANT,
        'shop-1',
        dto({ variants: [{ sku: 'SKU AVEC ESPACES', priceMinor: 100 }] }),
        {},
      ),
    ).rejects.toThrow(InvalidSkuFormatError);
  });

  it('SKU insensible à la casse : sku-001 et SKU-001 = doublon dans la même requête', async () => {
    const { service } = buildService();
    await expect(
      service.createFull(
        TENANT,
        'shop-1',
        dto({
          options: [{ name: 'Taille', values: ['S', 'M'] }],
          variants: [
            {
              sku: 'sku-001',
              priceMinor: 100,
              optionSelections: [{ optionName: 'Taille', value: 'S' }],
            },
            {
              sku: 'SKU-001',
              priceMinor: 100,
              optionSelections: [{ optionName: 'Taille', value: 'M' }],
            },
          ],
        }),
        {},
      ),
    ).rejects.toThrow(VariantSkuAlreadyUsedError);
  });

  it('deux variantes avec la même combinaison refusées (clé canonique, ordre indifférent)', async () => {
    const { service } = buildService();
    await expect(
      service.createFull(
        TENANT,
        'shop-1',
        dto({
          options: [
            { name: 'Taille', values: ['M'] },
            { name: 'Couleur', values: ['Rouge'] },
          ],
          variants: [
            {
              sku: 'A-1',
              priceMinor: 100,
              optionSelections: [
                { optionName: 'Taille', value: 'M' },
                { optionName: 'Couleur', value: 'Rouge' },
              ],
            },
            {
              sku: 'A-2',
              priceMinor: 100,
              optionSelections: [
                { optionName: 'Couleur', value: 'ROUGE' },
                { optionName: 'Taille', value: 'm' },
              ],
            },
          ],
        }),
        {},
      ),
    ).rejects.toThrow(DuplicateVariantCombinationError);
  });

  it('compareAtPriceMinor <= priceMinor refusé', async () => {
    const { service } = buildService();
    await expect(
      service.createFull(
        TENANT,
        'shop-1',
        dto({ variants: [{ sku: 'A-1', priceMinor: 100, compareAtPriceMinor: 100 }] }),
        {},
      ),
    ).rejects.toThrow(ValidationError);
  });

  it('plusieurs variantes par défaut refusées', async () => {
    const { service } = buildService();
    await expect(
      service.createFull(
        TENANT,
        'shop-1',
        dto({
          options: [{ name: 'Taille', values: ['S', 'M'] }],
          variants: [
            {
              sku: 'A-1',
              priceMinor: 100,
              isDefault: true,
              optionSelections: [{ optionName: 'Taille', value: 'S' }],
            },
            {
              sku: 'A-2',
              priceMinor: 100,
              isDefault: true,
              optionSelections: [{ optionName: 'Taille', value: 'M' }],
            },
          ],
        }),
        {},
      ),
    ).rejects.toThrow(ValidationError);
  });

  it('sélection incomplète (une valeur par option requise) refusée', async () => {
    const { service } = buildService();
    await expect(
      service.createFull(
        TENANT,
        'shop-1',
        dto({
          options: [
            { name: 'Taille', values: ['M'] },
            { name: 'Couleur', values: ['Rouge'] },
          ],
          variants: [
            {
              sku: 'A-1',
              priceMinor: 100,
              optionSelections: [{ optionName: 'Taille', value: 'M' }],
            },
          ],
        }),
        {},
      ),
    ).rejects.toThrow(ValidationError);
  });
});
