import type { PaymentStatus } from './types';

/**
 * Mapping des statuts OFFICIELS Genius Pay (`data.status`) vers le statut
 * normalisé Whauto. Source : documentation `pay.genius.ci/docs/api`.
 * Un statut inconnu est traité comme `PENDING` — JAMAIS `PAID` par défaut :
 * seul un `completed` explicite peut déclencher un crédit.
 */
export function mapGeniusPayStatus(raw: string): PaymentStatus {
  switch (raw) {
    case 'pending':
      return 'PENDING';
    case 'processing':
      return 'PROCESSING';
    case 'completed':
      return 'PAID';
    case 'failed':
      return 'FAILED';
    case 'cancelled':
      return 'CANCELLED';
    case 'refunded':
      return 'REFUNDED';
    case 'expired':
      return 'EXPIRED';
    default:
      return 'PENDING';
  }
}
