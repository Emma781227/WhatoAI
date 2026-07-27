import { Injectable } from '@nestjs/common';
import { Prisma } from '@whauto/database';
import {
  deriveOrderNumberPrefixCandidate,
  formatOrderNumber,
  OrderNumberGenerationError,
} from '@whauto/shared';

/**
 * Numéros de commande — décisions validées (ajustements 1 et 2) :
 * - préfixe STABLE stocké sur Shop (`orderNumberPrefix`), généré UNE fois
 *   (candidat dérivé du slug puis unicifié par suffixe numérique), unique
 *   insensible à la casse par organisation (index fonctionnel SQL) ; un
 *   changement de slug ne le modifie jamais ;
 * - séquence par (Shop, année) via UPSERT atomique
 *   `INSERT … ON CONFLICT DO UPDATE SET lastValue = lastValue + 1 RETURNING`
 *   DANS la transaction de conversion : un rollback annule l'incrément
 *   (compteur transactionnel — pas une séquence nextval, aucun trou lié au
 *   rollback) ; deux conversions concurrentes sérialisent sur la ligne.
 */
@Injectable()
export class OrderSequenceService {
  /**
   * Préfixe stable de la Shop : lit, sinon génère et PERSISTE (dans la
   * transaction appelante). L'index CI par org tranche les collisions de
   * candidats : on retente avec suffixe numérique (FASHION → FASHION2 …).
   */
  async ensurePrefix(
    tx: Prisma.TransactionClient,
    shop: { id: string; organizationId: string; slug: string; orderNumberPrefix: string | null },
  ): Promise<string> {
    if (shop.orderNumberPrefix !== null) {
      return shop.orderNumberPrefix;
    }
    const candidate = deriveOrderNumberPrefixCandidate(shop.slug);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const prefix = attempt === 0 ? candidate : `${candidate}${attempt + 1}`;
      // SAVEPOINT indispensable : une violation de contrainte (P2002) AVORTE
      // toute la transaction PostgreSQL — sans savepoint, la requête suivante
      // (même un simple SELECT) échouerait avec "current transaction is
      // aborted" au lieu d'un P2002 exploitable. Écriture conditionnelle :
      // ne pose le préfixe que s'il est toujours absent (deux conversions
      // concurrentes → une seule gagne, l'autre relit).
      await tx.$executeRaw`SAVEPOINT order_prefix_attempt`;
      try {
        const updated = await tx.shop.updateMany({
          where: { id: shop.id, orderNumberPrefix: null },
          data: { orderNumberPrefix: prefix },
        });
        await tx.$executeRaw`RELEASE SAVEPOINT order_prefix_attempt`;
        if (updated.count === 0) {
          const current = await tx.shop.findUniqueOrThrow({
            where: { id: shop.id },
            select: { orderNumberPrefix: true },
          });
          if (current.orderNumberPrefix !== null) {
            return current.orderNumberPrefix;
          }
          continue;
        }
        return prefix;
      } catch (error) {
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT order_prefix_attempt`;
        // Collision de l'index CI par organisation : candidat pris par une
        // autre Shop — suffixe suivant.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new OrderNumberGenerationError();
  }

  /** Prochain numéro — UPSERT atomique sur (shopId, year), dans la transaction. */
  async nextOrderNumber(
    tx: Prisma.TransactionClient,
    input: { shopId: string; organizationId: string; prefix: string; now?: Date },
  ): Promise<string> {
    const year = (input.now ?? new Date()).getFullYear();
    const rows = await tx.$queryRaw<Array<{ lastValue: number }>>`
      INSERT INTO "order_sequences" ("id", "organizationId", "shopId", "year", "lastValue", "updatedAt")
      VALUES (${`oseq_${input.shopId}_${year}`}, ${input.organizationId}, ${input.shopId}, ${year}, 1, NOW())
      ON CONFLICT ("shopId", "year")
      DO UPDATE SET "lastValue" = "order_sequences"."lastValue" + 1, "updatedAt" = NOW()
      RETURNING "lastValue"
    `;
    const lastValue = rows[0]?.lastValue;
    if (lastValue === undefined || lastValue < 1) {
      throw new OrderNumberGenerationError();
    }
    return formatOrderNumber(input.prefix, year, lastValue);
  }
}
