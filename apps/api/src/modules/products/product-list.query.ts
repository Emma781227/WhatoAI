import { Prisma } from '@whauto/database';

import type { ListProductsQueryDto } from './dto/product-inputs.dto';

/**
 * Requête de liste produits en SQL (CTE) : les agrégats variantes (fourchette
 * de prix, stock disponible, stockStatus) sont calculés PAR PostgreSQL, et les
 * filtres stockStatus comme le tri par prix s'appliquent AVANT la pagination
 * (exigence validée — jamais de filtrage de la page déjà chargée en mémoire).
 *
 * Le CASE de rang DOIT rester aligné sur computeVariantStockStatus /
 * aggregateProductStockStatus de @whauto/shared (meilleure disponibilité :
 * IN_STOCK(4) > LOW_STOCK(3) > BACKORDERED(2) > OUT_OF_STOCK(1)) — vérifié
 * par les e2e de filtrage multi-pages.
 */

export interface ProductListSqlRow {
  id: string;
  min_price: number | null;
  max_price: number | null;
  variant_count: bigint;
  total_available: bigint | null;
  stock_status: string;
}

function buildWhere(
  organizationId: string,
  shopId: string,
  query: ListProductsQueryDto,
): Prisma.Sql {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`p."organizationId" = ${organizationId}`,
    Prisma.sql`p."shopId" = ${shopId}`,
  ];

  if (query.status !== undefined) {
    conditions.push(Prisma.sql`p."status" = ${query.status}::"ProductStatus"`);
  } else if (query.includeArchived !== true) {
    conditions.push(Prisma.sql`p."status" <> 'ARCHIVED'`);
  }
  if (query.categoryId !== undefined) {
    conditions.push(Prisma.sql`p."categoryId" = ${query.categoryId}`);
  }
  if (query.featured === true) {
    conditions.push(Prisma.sql`p."featured" = true`);
  }
  if (query.search !== undefined && query.search.trim() !== '') {
    const like = `%${query.search.trim()}%`;
    conditions.push(
      Prisma.sql`(p."name" ILIKE ${like} OR p."slug" ILIKE ${like} OR EXISTS (
        SELECT 1 FROM "product_variants" sv
        WHERE sv."productId" = p."id" AND sv."status" <> 'ARCHIVED' AND sv."sku" ILIKE ${like}
      ))`,
    );
  }

  return Prisma.join(conditions, ' AND ');
}

const AGGREGATES_CTE = Prisma.sql`
  SELECT
    v."productId",
    MIN(v."priceMinor") FILTER (WHERE v."status" <> 'ARCHIVED') AS min_price,
    MAX(v."priceMinor") FILTER (WHERE v."status" <> 'ARCHIVED') AS max_price,
    COUNT(*) FILTER (WHERE v."status" <> 'ARCHIVED') AS variant_count,
    SUM(COALESCE(i."quantityOnHand", 0) - COALESCE(i."quantityReserved", 0))
      FILTER (WHERE v."status" <> 'ARCHIVED' AND v."trackInventory") AS total_available,
    MAX(CASE
      WHEN v."status" = 'ARCHIVED' OR NOT v."trackInventory" THEN NULL
      WHEN COALESCE(i."quantityOnHand", 0) - COALESCE(i."quantityReserved", 0) > COALESCE(i."lowStockThreshold", 0) THEN 4
      WHEN COALESCE(i."quantityOnHand", 0) - COALESCE(i."quantityReserved", 0) > 0 THEN 3
      WHEN v."allowBackorder" THEN 2
      ELSE 1
    END) AS best_rank
  FROM "product_variants" v
  LEFT JOIN "inventory_items" i ON i."variantId" = v."id"
  GROUP BY v."productId"
`;

const STOCK_STATUS_EXPR = Prisma.sql`
  CASE
    WHEN vd.best_rank IS NULL THEN 'NOT_TRACKED'
    WHEN vd.best_rank = 4 THEN 'IN_STOCK'
    WHEN vd.best_rank = 3 THEN 'LOW_STOCK'
    WHEN vd.best_rank = 2 THEN 'BACKORDERED'
    ELSE 'OUT_OF_STOCK'
  END
`;

function orderBy(query: ListProductsQueryDto): Prisma.Sql {
  const dir = query.sortDir === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  switch (query.sortBy) {
    case 'name':
      return Prisma.sql`q."name" ${dir}, q."id" ${dir}`;
    case 'updatedAt':
      return Prisma.sql`q."updatedAt" ${dir}, q."id" ${dir}`;
    case 'price':
      // NULLS LAST dans les deux sens : les produits sans variante vivante en fin.
      return Prisma.sql`q.min_price ${dir} NULLS LAST, q."id" ${dir}`;
    case 'createdAt':
    default:
      return Prisma.sql`q."createdAt" ${dir}, q."id" ${dir}`;
  }
}

export function buildProductListQuery(
  organizationId: string,
  shopId: string,
  query: ListProductsQueryDto,
): { pageSql: Prisma.Sql; countSql: Prisma.Sql } {
  const where = buildWhere(organizationId, shopId, query);
  const stockFilter =
    query.stockStatus !== undefined
      ? Prisma.sql`WHERE q.stock_status = ${query.stockStatus}`
      : Prisma.empty;

  const base = Prisma.sql`
    WITH variant_data AS (${AGGREGATES_CTE}),
    q AS (
      SELECT
        p."id", p."name", p."createdAt", p."updatedAt",
        vd.min_price, vd.max_price,
        COALESCE(vd.variant_count, 0) AS variant_count,
        vd.total_available,
        (${STOCK_STATUS_EXPR}) AS stock_status
      FROM "products" p
      LEFT JOIN variant_data vd ON vd."productId" = p."id"
      WHERE ${where}
    )
  `;

  const pageSql = Prisma.sql`
    ${base}
    SELECT q."id", q.min_price, q.max_price, q.variant_count, q.total_available, q.stock_status
    FROM q
    ${stockFilter}
    ORDER BY ${orderBy(query)}
    LIMIT ${query.limit} OFFSET ${query.skip}
  `;

  const countSql = Prisma.sql`
    ${base}
    SELECT COUNT(*)::bigint AS total FROM q ${stockFilter}
  `;

  return { pageSql, countSql };
}
