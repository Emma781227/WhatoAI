import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Index uniques partiels créés en SQL brut dans les migrations (inexprimables
 * dans schema.prisma). S'ils manquent — typiquement après un `prisma db push`
 * qui ne rejoue pas les migrations — les garanties d'unicité concurrentes
 * (une invitation PENDING par org+email, un seul OWNER ACTIVE) disparaissent
 * silencieusement. Le seed échoue donc dans ce cas.
 */
const REQUIRED_PARTIAL_INDEXES = [
  'organization_invitations_one_pending_per_org_email',
  'memberships_one_active_owner_per_org',
  'shops_one_primary_per_org',
  'whatsapp_channels_one_active_per_shop',
  'conversations_one_active_per_contact_channel',
  'product_categories_unique_name_ci_per_shop',
  'product_variants_one_default_per_product',
  'product_variants_unique_combination_per_product',
  'product_images_one_primary_per_product',
  'carts_one_open_per_conversation',
  'stock_reservations_one_active_per_cart_item',
  'shops_order_number_prefix_ci_per_org',
];

async function assertPartialIndexes(): Promise<void> {
  const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
    SELECT indexname FROM pg_indexes WHERE indexname = ANY(${REQUIRED_PARTIAL_INDEXES})
  `;
  const found = new Set(rows.map((row) => row.indexname));
  const missing = REQUIRED_PARTIAL_INDEXES.filter((name) => !found.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Index uniques partiels absents : ${missing.join(', ')}. ` +
        'Rejouer les migrations (pnpm db:migrate) — ne pas utiliser prisma db push (voir CLAUDE.md).',
    );
  }
  console.log('Index uniques partiels présents ✔');
}

async function main() {
  const [users, organizations, memberships, invitations, shops] = await Promise.all([
    prisma.user.count(),
    prisma.organization.count(),
    prisma.membership.count(),
    prisma.organizationInvitation.count(),
    prisma.shop.count(),
  ]);
  console.log(
    `Base joignable — users: ${users}, organizations: ${organizations}, memberships: ${memberships}, invitations: ${invitations}, shops: ${shops}`,
  );
  await assertPartialIndexes();
}

main()
  .catch((error: unknown) => {
    console.error('Échec du seed :', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
