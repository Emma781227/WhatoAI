import { Prisma } from '@whauto/database';
import {
  InvalidShopStatusTransitionError,
  ShopActivationRequirementsError,
  ShopArchivedError,
  ShopNotFoundError,
  ShopSlugAlreadyUsedError,
  ValidationError,
} from '@whauto/shared';

import { ROLE_PERMISSIONS } from '../../common/tenant/permissions';
import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import type { PrismaService } from '../../prisma/prisma.service';
import type { OrganizationAuditService } from '../organizations/organization-audit.service';
import { ShopsService } from './shops.service';

const TENANT: TenantContext = {
  userId: 'user-1',
  organizationId: 'org-1',
  membershipId: 'membership-1',
  role: 'OWNER',
  permissions: ROLE_PERMISSIONS.OWNER,
};

const SHOP = {
  id: 'shop-1',
  organizationId: 'org-1',
  name: 'Boutique Centre',
  slug: 'boutique-centre',
  description: null,
  status: 'DRAFT' as const,
  isPrimary: true,
  businessType: null,
  logoUrl: null,
  coverUrl: null,
  websiteUrl: null,
  supportEmail: null,
  supportPhone: null,
  addressLine1: null,
  addressLine2: null,
  city: null,
  region: null,
  postalCode: null,
  latitude: null,
  longitude: null,
  countryCode: 'CM',
  timezone: 'Africa/Douala',
  currency: 'XAF',
  locale: 'fr',
  returnPolicy: null,
  deliveryPolicy: null,
  orderInstructions: null,
  createdAt: new Date('2026-07-01T00:00:00Z'),
  updatedAt: new Date('2026-07-01T00:00:00Z'),
  archivedAt: null,
};

function slugConflict(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['organizationId', 'slug'] },
  });
}

function primaryConflict(): Prisma.PrismaClientKnownRequestError {
  // Forme réelle observée avec l'index partiel brut (vérifiée sur Prisma 6.19) :
  // la cible est la colonne de l'index, pas son nom.
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['organizationId'] },
  });
}

function buildMocks() {
  const prisma = {
    shop: {
      create: jest.fn().mockResolvedValue(SHOP),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      findUniqueOrThrow: jest.fn().mockResolvedValue(SHOP),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue({ id: 'promoted' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    organization: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        timezone: 'Africa/Douala',
        defaultCurrency: 'XAF',
        defaultLocale: 'fr',
      }),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(async (arg: unknown) =>
    Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => Promise<unknown>)(prisma),
  );

  const auditService = {
    record: jest.fn().mockResolvedValue({}),
    recordSafe: jest.fn().mockResolvedValue(undefined),
  };

  const service = new ShopsService(
    prisma as unknown as PrismaService,
    auditService as unknown as OrganizationAuditService,
  );
  return { service, prisma, auditService };
}

describe('ShopsService', () => {
  describe('create', () => {
    it('première Shop : isPrimary=true, héritage des paramètres régionaux, audit SHOP_CREATED transactionnel', async () => {
      const { service, prisma, auditService } = buildMocks();

      await service.create(TENANT, { name: 'Boutique Centre', countryCode: 'cm' }, {});

      const data = prisma.shop.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        organizationId: 'org-1',
        slug: 'boutique-centre',
        isPrimary: true,
        countryCode: 'CM', // normalisé en majuscules
        timezone: 'Africa/Douala', // hérité de l'organisation
        currency: 'XAF',
        locale: 'fr',
        createdByUserId: 'user-1',
      });
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'SHOP_CREATED' }),
        prisma,
      );
    });

    it('deuxième Shop : une principale existe déjà → isPrimary=false', async () => {
      const { service, prisma } = buildMocks();
      prisma.shop.findFirst.mockResolvedValue({ id: 'existing-primary' });

      await service.create(TENANT, { name: 'Annexe', countryCode: 'CM' }, {});
      expect(prisma.shop.create.mock.calls[0][0].data.isPrimary).toBe(false);
    });

    it('les valeurs fournies priment sur l’héritage — countryCode jamais déduit de la devise', async () => {
      const { service, prisma } = buildMocks();

      await service.create(
        TENANT,
        { name: 'Paris Store', countryCode: 'FR', currency: 'EUR', timezone: 'Europe/Paris', locale: 'fr' },
        {},
      );
      const data = prisma.shop.create.mock.calls[0][0].data;
      expect(data.countryCode).toBe('FR');
      expect(data.currency).toBe('EUR');
      expect(data.timezone).toBe('Europe/Paris');
    });

    it('collision de slug fourni → 409, JAMAIS de retry isPrimary=false', async () => {
      const { service, prisma } = buildMocks();
      prisma.shop.create.mockRejectedValue(slugConflict());

      await expect(
        service.create(TENANT, { name: 'X', slug: 'pris', countryCode: 'CM' }, {}),
      ).rejects.toThrow(ShopSlugAlreadyUsedError);
      // Un seul essai : la collision de slug n'est pas interprétée comme collision de principale.
      expect(prisma.shop.create).toHaveBeenCalledTimes(1);
    });

    it('collision de slug généré → retry suffixé, isPrimary inchangé', async () => {
      const { service, prisma } = buildMocks();
      prisma.shop.create.mockRejectedValueOnce(slugConflict()).mockResolvedValue(SHOP);

      await service.create(TENANT, { name: 'Boutique Centre', countryCode: 'CM' }, {});

      expect(prisma.shop.create).toHaveBeenCalledTimes(2);
      expect(prisma.shop.create.mock.calls[1][0].data.slug).toBe('boutique-centre-2');
      expect(prisma.shop.create.mock.calls[1][0].data.isPrimary).toBe(true);
    });

    it('collision de l’index primaire (deux premières Shops simultanées) → retry unique isPrimary=false, même slug', async () => {
      const { service, prisma } = buildMocks();
      prisma.shop.create.mockRejectedValueOnce(primaryConflict()).mockResolvedValue(SHOP);

      await service.create(TENANT, { name: 'Boutique Centre', countryCode: 'CM' }, {});

      expect(prisma.shop.create).toHaveBeenCalledTimes(2);
      expect(prisma.shop.create.mock.calls[1][0].data.isPrimary).toBe(false);
      expect(prisma.shop.create.mock.calls[1][0].data.slug).toBe('boutique-centre');
    });

    it('P2002 non identifié : relancé tel quel, aucune fuite en DomainError trompeuse', async () => {
      const { service, prisma } = buildMocks();
      prisma.shop.findFirst.mockResolvedValue({ id: 'existing-primary' }); // isPrimary=false
      const unknown = new Prisma.PrismaClientKnownRequestError('boom', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: 'something_else' },
      });
      prisma.shop.create.mockRejectedValue(unknown);

      // isPrimary=false → pas de conflit primaire possible → l'erreur remonte brute
      // (500 générique NestJS, sans message Prisma côté client).
      await expect(
        service.create(TENANT, { name: 'Autre Boutique', countryCode: 'CM' }, {}),
      ).rejects.toBe(unknown);
    });

    it('slug fourni invalide → ValidationError sans écriture', async () => {
      const { service, prisma } = buildMocks();
      await expect(
        service.create(TENANT, { name: 'X Y', slug: 'Bad Slug!', countryCode: 'CM' }, {}),
      ).rejects.toThrow(ValidationError);
      expect(prisma.shop.create).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('toujours scoppée organizationId, ARCHIVED exclues par défaut, recherche insensible à la casse', async () => {
      const { service, prisma } = buildMocks();

      await service.list(TENANT, {
        page: 1,
        limit: 20,
        skip: 0,
        search: 'BOUTIQUE',
        sortBy: 'name',
        sortOrder: 'desc',
      });

      const where = prisma.shop.findMany.mock.calls[0][0].where;
      expect(where.organizationId).toBe('org-1');
      expect(where.status).toEqual({ not: 'ARCHIVED' });
      expect(where.OR).toEqual([
        { name: { contains: 'BOUTIQUE', mode: 'insensitive' } },
        { slug: { contains: 'BOUTIQUE', mode: 'insensitive' } },
      ]);
      expect(prisma.shop.findMany.mock.calls[0][0].orderBy).toEqual({ name: 'desc' });
    });

    it('includeArchived=true lève l’exclusion ; un statut explicite prime', async () => {
      const { service, prisma } = buildMocks();

      await service.list(TENANT, {
        page: 1,
        limit: 20,
        skip: 0,
        includeArchived: true,
        sortBy: 'createdAt',
        sortOrder: 'asc',
      });
      expect(prisma.shop.findMany.mock.calls[0][0].where.status).toBeUndefined();

      await service.list(TENANT, {
        page: 1,
        limit: 20,
        skip: 0,
        status: 'ARCHIVED',
        sortBy: 'createdAt',
        sortOrder: 'asc',
      });
      expect(prisma.shop.findMany.mock.calls[1][0].where.status).toBe('ARCHIVED');
    });
  });

  describe('getForTenant', () => {
    it('Shop étrangère ou inexistante → 404 (filtre id + organizationId)', async () => {
      const { service, prisma } = buildMocks();
      prisma.shop.findFirst.mockResolvedValue(null);

      await expect(service.getForTenant(TENANT, 'foreign-shop')).rejects.toThrow(
        ShopNotFoundError,
      );
      expect(prisma.shop.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'foreign-shop', organizationId: 'org-1' },
        }),
      );
    });
  });

  describe('update', () => {
    it('Shop archivée → ShopArchivedError sans écriture', async () => {
      const { service, prisma } = buildMocks();
      prisma.shop.findFirst.mockResolvedValue({ ...SHOP, status: 'ARCHIVED' });

      await expect(service.update(TENANT, 'shop-1', { name: 'Nouveau' }, {})).rejects.toThrow(
        ShopArchivedError,
      );
      expect(prisma.shop.updateMany).not.toHaveBeenCalled();
    });

    it('audit SHOP_UPDATED dans la MÊME transaction — un échec d’audit annule la modification', async () => {
      const { service, prisma, auditService } = buildMocks();
      prisma.shop.findFirst.mockResolvedValue(SHOP);
      auditService.record.mockRejectedValue(new Error('audit db down'));

      await expect(
        service.update(TENANT, 'shop-1', { slug: 'nouveau-slug' }, {}),
      ).rejects.toThrow('audit db down');
      // record appelé avec le client transactionnel : le rollback emporte l'update.
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'SHOP_UPDATED' }),
        prisma,
      );
    });

    it('convention PATCH : null efface, undefined ignore ; metadata = noms de champs seulement', async () => {
      const { service, prisma, auditService } = buildMocks();
      prisma.shop.findFirst.mockResolvedValue(SHOP);

      await service.update(
        TENANT,
        'shop-1',
        { description: null, returnPolicy: 'Retours sous 7 jours', currency: 'eur' },
        {},
      );

      const data = prisma.shop.updateMany.mock.calls[0][0].data;
      expect(data.description).toBeNull();
      expect(data.returnPolicy).toBe('Retours sous 7 jours');
      expect(data.currency).toBe('EUR');
      expect(data.name).toBeUndefined();

      const metadata = auditService.record.mock.calls[0][0].metadata;
      expect(metadata.fields.sort()).toEqual(['currency', 'description', 'returnPolicy']);
      // Jamais le contenu des politiques dans l'audit.
      expect(JSON.stringify(metadata)).not.toContain('Retours sous 7 jours');
    });

    it('collision de slug → 409', async () => {
      const { service, prisma } = buildMocks();
      prisma.shop.findFirst.mockResolvedValue(SHOP);
      prisma.shop.updateMany.mockRejectedValue(slugConflict());

      await expect(service.update(TENANT, 'shop-1', { slug: 'pris' }, {})).rejects.toThrow(
        ShopSlugAlreadyUsedError,
      );
    });

    it('aucun champ → ValidationError', async () => {
      const { service, prisma } = buildMocks();
      prisma.shop.findFirst.mockResolvedValue(SHOP);
      await expect(service.update(TENANT, 'shop-1', {}, {})).rejects.toThrow(ValidationError);
    });
  });

  describe('transitions de statut', () => {
    it.each([
      ['DRAFT', 'activate', 'SHOP_ACTIVATED'],
      ['INACTIVE', 'activate', 'SHOP_ACTIVATED'],
      ['ACTIVE', 'deactivate', 'SHOP_DEACTIVATED'],
    ] as const)('%s → %s : updateMany conditionnel + audit transactionnel', async (from, method, event) => {
      const { service, prisma, auditService } = buildMocks();
      prisma.shop.findFirst.mockResolvedValue({ ...SHOP, status: from });

      await service[method](TENANT, 'shop-1', {});

      expect(prisma.shop.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: from }) }),
      );
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: event }),
        prisma,
      );
    });

    it.each([
      ['ACTIVE', 'activate'],
      ['ARCHIVED', 'activate'],
      ['DRAFT', 'deactivate'],
      ['INACTIVE', 'deactivate'],
      ['ARCHIVED', 'deactivate'],
    ] as const)('transition invalide %s → %s refusée', async (from, method) => {
      const { service, prisma } = buildMocks();
      prisma.shop.findFirst.mockResolvedValue({ ...SHOP, status: from });
      await expect(service[method](TENANT, 'shop-1', {})).rejects.toThrow(
        InvalidShopStatusTransitionError,
      );
    });

    it('activation incomplète → ShopActivationRequirementsError listant les champs manquants', async () => {
      const { service, prisma } = buildMocks();
      prisma.shop.findFirst.mockResolvedValue({ ...SHOP, currency: '', locale: '  ' });

      await expect(service.activate(TENANT, 'shop-1', {})).rejects.toThrow(
        ShopActivationRequirementsError,
      );
      await expect(service.activate(TENANT, 'shop-1', {})).rejects.toThrow(/currency, locale/);
    });

    it('transition concurrente (count=0) → erreur propre', async () => {
      const { service, prisma } = buildMocks();
      prisma.shop.findFirst.mockResolvedValue({ ...SHOP, status: 'DRAFT' });
      prisma.shop.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.activate(TENANT, 'shop-1', {})).rejects.toThrow(
        InvalidShopStatusTransitionError,
      );
    });
  });

  describe('setPrimary', () => {
    it('idempotent si déjà principale (aucune écriture)', async () => {
      const { service, prisma } = buildMocks();
      prisma.shop.findFirst.mockResolvedValue({ ...SHOP, isPrimary: true });

      const result = await service.setPrimary(TENANT, 'shop-1', {});
      expect(result.isPrimary).toBe(true);
      expect(prisma.shop.updateMany).not.toHaveBeenCalled();
    });

    it('démote l’ancienne, promeut la cible conditionnellement, audite dans la transaction', async () => {
      const { service, prisma, auditService } = buildMocks();
      prisma.shop.findFirst.mockResolvedValue({ ...SHOP, isPrimary: false, status: 'ACTIVE' });

      await service.setPrimary(TENANT, 'shop-1', {});

      expect(prisma.shop.updateMany).toHaveBeenNthCalledWith(1, {
        where: { organizationId: 'org-1', isPrimary: true },
        data: { isPrimary: false },
      });
      expect(prisma.shop.updateMany).toHaveBeenNthCalledWith(2, {
        where: { id: 'shop-1', organizationId: 'org-1', status: { not: 'ARCHIVED' } },
        data: { isPrimary: true },
      });
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'SHOP_SET_PRIMARY' }),
        prisma,
      );
    });

    it('course avec un set-primary concurrent : retries ciblés, puis erreur métier propre (jamais de fuite Prisma)', async () => {
      const { service, prisma } = buildMocks();
      prisma.shop.findFirst.mockResolvedValue({ ...SHOP, isPrimary: false, status: 'ACTIVE' });
      prisma.$transaction.mockRejectedValue(primaryConflict());

      const promise = service.setPrimary(TENANT, 'shop-1', {});
      await expect(promise).rejects.toMatchObject({ code: 'CONFLICT', httpStatus: 409 });
      await expect(promise).rejects.not.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect(prisma.$transaction).toHaveBeenCalledTimes(3); // essai + 2 retries ciblés
    });

    it('conflit d’écriture transactionnel (P2034) : retry ciblé puis succès', async () => {
      const { service, prisma } = buildMocks();
      prisma.shop.findFirst.mockResolvedValue({ ...SHOP, isPrimary: false, status: 'ACTIVE' });
      const writeConflict = new Prisma.PrismaClientKnownRequestError('write conflict', {
        code: 'P2034',
        clientVersion: 'test',
      });
      const original = prisma.$transaction.getMockImplementation()!;
      prisma.$transaction.mockRejectedValueOnce(writeConflict).mockImplementation(original);

      const result = await service.setPrimary(TENANT, 'shop-1', {});
      expect(result).toBeDefined();
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    });

    it('Shop archivée → refus', async () => {
      const { service, prisma } = buildMocks();
      prisma.shop.findFirst.mockResolvedValue({ ...SHOP, status: 'ARCHIVED', isPrimary: false });
      await expect(service.setPrimary(TENANT, 'shop-1', {})).rejects.toThrow(ShopArchivedError);
    });
  });

  describe('archive', () => {
    it('archivage d’une principale : promotion déterministe ACTIVE > INACTIVE > DRAFT (createdAt, id)', async () => {
      const { service, prisma, auditService } = buildMocks();
      prisma.shop.findFirst
        .mockResolvedValueOnce({ ...SHOP, isPrimary: true, status: 'ACTIVE' }) // getForTenant
        .mockResolvedValueOnce(null) // candidat ACTIVE : aucun
        .mockResolvedValueOnce({ id: 'oldest-inactive' }); // candidat INACTIVE

      await service.archive(TENANT, 'shop-1', {});

      expect(prisma.shop.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'ARCHIVED', isPrimary: false }),
        }),
      );
      // Recherche des candidats dans l'ordre des statuts, tri createdAt puis id.
      expect(prisma.shop.findFirst.mock.calls[1][0].where.status).toBe('ACTIVE');
      expect(prisma.shop.findFirst.mock.calls[2][0].where.status).toBe('INACTIVE');
      expect(prisma.shop.findFirst.mock.calls[2][0].orderBy).toEqual([
        { createdAt: 'asc' },
        { id: 'asc' },
      ]);
      expect(prisma.shop.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'oldest-inactive' }, data: { isPrimary: true } }),
      );
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'SHOP_ARCHIVED',
          metadata: expect.objectContaining({ wasPrimary: true, promotedShopId: 'oldest-inactive' }),
        }),
        prisma,
      );
    });

    it('aucune autre Shop : l’organisation reste sans principale', async () => {
      const { service, prisma } = buildMocks();
      prisma.shop.findFirst
        .mockResolvedValueOnce({ ...SHOP, isPrimary: true, status: 'ACTIVE' })
        .mockResolvedValue(null); // aucun candidat, quel que soit le statut

      await service.archive(TENANT, 'shop-1', {});
      expect(prisma.shop.update).not.toHaveBeenCalled();
    });

    it('Shop non principale : aucune promotion recherchée', async () => {
      const { service, prisma } = buildMocks();
      prisma.shop.findFirst.mockResolvedValueOnce({ ...SHOP, isPrimary: false, status: 'ACTIVE' });

      await service.archive(TENANT, 'shop-1', {});
      expect(prisma.shop.findFirst).toHaveBeenCalledTimes(1);
    });

    it('déjà archivée → InvalidShopStatusTransitionError', async () => {
      const { service, prisma } = buildMocks();
      prisma.shop.findFirst.mockResolvedValue({ ...SHOP, status: 'ARCHIVED' });
      await expect(service.archive(TENANT, 'shop-1', {})).rejects.toThrow(
        InvalidShopStatusTransitionError,
      );
    });
  });
});
