import type { StockStatus } from '@whauto/shared';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

import { STOCK_STATUS_CLASSES, STOCK_STATUS_LABELS } from '../labels';

export function StockStatusBadge({ status, className }: { status: StockStatus; className?: string }) {
  return (
    <Badge
      variant="secondary"
      className={cn('border-transparent', STOCK_STATUS_CLASSES[status], className)}
      data-testid="stock-status-badge"
      data-stock-status={status}
    >
      {STOCK_STATUS_LABELS[status]}
    </Badge>
  );
}
