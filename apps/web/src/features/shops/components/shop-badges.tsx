import { Star } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { messages } from '@/lib/messages';

import type { ShopStatus } from '../api';

const STATUS_VARIANT: Record<ShopStatus, 'default' | 'secondary' | 'warning' | 'muted'> = {
  DRAFT: 'secondary',
  ACTIVE: 'default',
  INACTIVE: 'warning',
  ARCHIVED: 'muted',
};

export function ShopStatusBadge({ status }: { status: ShopStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{messages.shopStatus[status]}</Badge>;
}

export function PrimaryShopBadge() {
  return (
    <Badge variant="info">
      <Star aria-hidden className="h-3 w-3" />
      Principale
    </Badge>
  );
}
