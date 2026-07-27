import type { OrderFulfillmentStatus, OrderPaymentStatus, OrderStatus } from './api';

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  CONFIRMED: 'Confirmée',
  PROCESSING: 'En préparation',
  READY: 'Prête',
  SHIPPED: 'Expédiée',
  DELIVERED: 'Livrée',
  CANCELLED: 'Annulée',
};

export const PAYMENT_STATUS_LABELS: Record<OrderPaymentStatus, string> = {
  UNPAID: 'Non payé',
  PENDING: 'Paiement en attente',
  PAID: 'Payé',
  FAILED: 'Paiement échoué',
  REFUNDED: 'Remboursé',
  PARTIALLY_REFUNDED: 'Partiellement remboursé',
};

export const FULFILLMENT_STATUS_LABELS: Record<OrderFulfillmentStatus, string> = {
  PENDING: 'À préparer',
  PREPARING: 'Préparation',
  READY_FOR_PICKUP: 'Prêt au retrait',
  READY_FOR_SHIPMENT: 'Prêt à expédier',
  IN_TRANSIT: 'En livraison',
  DELIVERED: 'Livré',
  CANCELLED: 'Annulé',
  NOT_REQUIRED: 'Sans livraison',
};

export const FULFILLMENT_TYPE_LABELS: Record<'DELIVERY' | 'PICKUP', string> = {
  DELIVERY: 'Livraison',
  PICKUP: 'Retrait',
};

export const PAYMENT_PREFERENCE_LABELS: Record<string, string> = {
  CASH_ON_DELIVERY: 'Paiement à la livraison',
  MOBILE_MONEY: 'Mobile Money',
  CARD: 'Carte bancaire',
  PAY_IN_STORE: 'Paiement en boutique',
  UNDECIDED: 'À décider',
};

/**
 * Transitions proposables par l'UI (miroir de ORDER_STATUS_TRANSITIONS de
 * @whauto/shared — le serveur reste l'autorité). CANCELLED passe par le flux
 * d'annulation dédié, jamais par le menu de statut.
 */
export function nextStatuses(
  status: OrderStatus,
  fulfillmentType: 'DELIVERY' | 'PICKUP',
): OrderStatus[] {
  switch (status) {
    case 'CONFIRMED':
      return ['PROCESSING'];
    case 'PROCESSING':
      return ['READY'];
    case 'READY':
      return fulfillmentType === 'PICKUP' ? ['DELIVERED'] : ['SHIPPED'];
    case 'SHIPPED':
      return ['DELIVERED'];
    default:
      return [];
  }
}

export function isCancellable(status: OrderStatus): boolean {
  return status === 'CONFIRMED' || status === 'PROCESSING' || status === 'READY';
}
