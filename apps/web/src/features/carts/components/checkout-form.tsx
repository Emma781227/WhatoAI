'use client';

import { CheckCircle2 } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useOrganization } from '@/features/organizations/organization-provider';
import { PERMISSIONS } from '@/lib/permissions/constants';
import { usePermissions } from '@/lib/permissions/use-permissions';

import { cartsApi, type Cart, type FulfillmentType, type PaymentPreference } from '../api';

const PAYMENT_LABELS: Record<PaymentPreference, string> = {
  CASH_ON_DELIVERY: 'Paiement à la livraison',
  MOBILE_MONEY: 'Mobile Money',
  CARD: 'Carte bancaire',
  PAY_IN_STORE: 'Paiement en boutique',
  UNDECIDED: 'À décider',
};

/**
 * Formulaire de checkout (collecte + confirmation). Prérempli depuis le
 * Contact côté serveur ; chaque enregistrement est une action SIGNIFICATIVE
 * (renouvellement contrôlé des réservations). La confirmation est atomique
 * côté serveur — versions vérifiées, 409 → rechargement.
 */
export function CheckoutForm({
  cart,
  conversationId,
  onMutate,
}: {
  cart: Cart;
  conversationId: string;
  onMutate: (fn: () => Promise<Cart>) => void;
}) {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const { can } = usePermissions();
  const checkout = cart.checkout!;
  const confirmed = checkout.status === 'CONFIRMED';

  const [customerName, setCustomerName] = useState(checkout.customerName ?? '');
  const [customerPhone, setCustomerPhone] = useState(checkout.customerPhone);
  const [fulfillmentType, setFulfillmentType] = useState<FulfillmentType | ''>(
    checkout.fulfillmentType ?? '',
  );
  const [city, setCity] = useState(checkout.city ?? '');
  const [addressLine1, setAddressLine1] = useState(checkout.addressLine1 ?? '');
  const [landmark, setLandmark] = useState(checkout.landmark ?? '');
  const [countryCode, setCountryCode] = useState(checkout.countryCode ?? 'CM');
  const [deliveryInstructions, setDeliveryInstructions] = useState(
    checkout.deliveryInstructions ?? '',
  );
  const [paymentPreference, setPaymentPreference] = useState<PaymentPreference>(
    checkout.paymentPreference,
  );

  if (confirmed) {
    const snapshot = checkout.confirmationSnapshot as { totalMinor?: number } | null;
    return (
      <div className="space-y-2 rounded-lg border border-primary bg-primary-subtle p-3" data-testid="checkout-confirmed">
        <p className="flex items-center gap-2 text-sm font-medium text-primary">
          <CheckCircle2 aria-hidden className="h-4 w-4" />
          Checkout confirmé — prêt pour la commande
        </p>
        <p className="text-xs text-muted-foreground">
          {checkout.fulfillmentType === 'DELIVERY' ? 'Livraison' : 'Retrait'} ·{' '}
          {PAYMENT_LABELS[checkout.paymentPreference]} · {checkout.customerName} ·{' '}
          {checkout.customerPhone}
        </p>
        <p className="text-xs text-muted-foreground">
          Le récapitulatif immuable a été enregistré{snapshot ? ' (snapshot prêt pour la commande)' : ''}.
          Panier et checkout ne sont plus modifiables — créez la commande depuis l’onglet
          « Commandes ».
        </p>
      </div>
    );
  }

  const save = () =>
    onMutate(() =>
      cartsApi.updateCheckout(organizationId, conversationId, {
        expectedVersion: checkout.version,
        customerName: customerName.trim() === '' ? null : customerName.trim(),
        customerPhone: customerPhone.trim(),
        fulfillmentType: fulfillmentType === '' ? undefined : fulfillmentType,
        city: city.trim() === '' ? null : city.trim(),
        addressLine1: addressLine1.trim() === '' ? null : addressLine1.trim(),
        landmark: landmark.trim() === '' ? null : landmark.trim(),
        countryCode: countryCode.trim() === '' ? null : countryCode.trim().toUpperCase(),
        deliveryInstructions:
          deliveryInstructions.trim() === '' ? null : deliveryInstructions.trim(),
        paymentPreference,
      }),
    );

  return (
    <div className="space-y-3" data-testid="checkout-form">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Checkout</p>
        <Badge variant={checkout.status === 'READY_FOR_CONFIRMATION' ? 'default' : 'outline'}>
          {checkout.status === 'READY_FOR_CONFIRMATION' ? 'Prêt à confirmer' : 'Infos à compléter'}
        </Badge>
      </div>

      <div className="space-y-2">
        <div className="space-y-1">
          <Label htmlFor="co-name">Nom du client</Label>
          <Input id="co-name" value={customerName} onChange={(e) => setCustomerName(e.target.value)} maxLength={100} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="co-phone">Téléphone</Label>
          <Input id="co-phone" value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} maxLength={20} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="co-fulfillment">Mode</Label>
          <Select
            value={fulfillmentType}
            onValueChange={(value) => setFulfillmentType(value as FulfillmentType)}
          >
            <SelectTrigger id="co-fulfillment" data-testid="fulfillment-select">
              <SelectValue placeholder="Livraison ou retrait ?" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="DELIVERY">Livraison</SelectItem>
              <SelectItem value="PICKUP">Retrait en boutique</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {fulfillmentType === 'DELIVERY' ? (
          <>
            <div className="space-y-1">
              <Label htmlFor="co-city">Ville</Label>
              <Input id="co-city" value={city} onChange={(e) => setCity(e.target.value)} maxLength={100} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="co-address">Adresse</Label>
              <Input id="co-address" value={addressLine1} onChange={(e) => setAddressLine1(e.target.value)} maxLength={300} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="co-landmark">Repère (alternative à l’adresse)</Label>
              <Input id="co-landmark" value={landmark} onChange={(e) => setLandmark(e.target.value)} maxLength={300} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="co-country">Pays (code)</Label>
              <Input id="co-country" value={countryCode} onChange={(e) => setCountryCode(e.target.value)} maxLength={2} className="w-20 uppercase" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="co-instructions">Instructions de livraison</Label>
              <Textarea
                id="co-instructions"
                value={deliveryInstructions}
                onChange={(e) => setDeliveryInstructions(e.target.value)}
                maxLength={1000}
                rows={2}
              />
            </div>
          </>
        ) : null}

        <div className="space-y-1">
          <Label htmlFor="co-payment">Préférence de paiement</Label>
          <Select
            value={paymentPreference}
            onValueChange={(value) => setPaymentPreference(value as PaymentPreference)}
          >
            <SelectTrigger id="co-payment" data-testid="payment-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(PAYMENT_LABELS) as PaymentPreference[]).map((preference) => (
                <SelectItem key={preference} value={preference}>
                  {PAYMENT_LABELS[preference]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={save} data-testid="checkout-save">
          Enregistrer les informations
        </Button>
        {can(PERMISSIONS.CHECKOUT_CONFIRM) ? (
          <Button
            type="button"
            size="sm"
            disabled={checkout.status !== 'READY_FOR_CONFIRMATION'}
            onClick={() =>
              onMutate(() =>
                cartsApi.confirmCheckout(organizationId, conversationId, {
                  expectedVersion: checkout.version,
                  clientMutationId: crypto.randomUUID(),
                }),
              )
            }
            data-testid="checkout-confirm"
          >
            Confirmer
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-destructive"
          onClick={() => onMutate(() => cartsApi.cancelCheckout(organizationId, conversationId))}
          data-testid="checkout-cancel"
        >
          Annuler le checkout
        </Button>
      </div>
    </div>
  );
}
