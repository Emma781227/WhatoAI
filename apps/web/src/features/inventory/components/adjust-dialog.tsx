'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { productKeys } from '@/features/products/api';
import { ApiError, getErrorMessage } from '@/lib/api/api-error';

import { inventoryApi, inventoryKeys, type AdjustInput, type InventoryRow } from '../api';

type AdjustType = 'RESTOCK' | 'DAMAGE' | 'ADJUSTMENT';

const TYPE_LABELS: Record<AdjustType, string> = {
  RESTOCK: 'Réapprovisionnement',
  DAMAGE: 'Casse / perte',
  ADJUSTMENT: 'Correction d’inventaire',
};

/**
 * Dialog d'ajustement avec APERÇU avant/après et gestion explicite du conflit
 * de concurrence (409 INVENTORY_CONCURRENCY) : le stock est rechargé et
 * l'utilisateur doit reconfirmer sur la valeur fraîche — jamais d'écrasement.
 */
export function AdjustInventoryDialog({
  row,
  shopId,
  onClose,
}: {
  row: InventoryRow;
  shopId: string;
  onClose: () => void;
}) {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const queryClient = useQueryClient();

  const [type, setType] = useState<AdjustType>('RESTOCK');
  const [quantity, setQuantity] = useState('');
  const [target, setTarget] = useState(String(row.quantityOnHand));
  const [reason, setReason] = useState('');
  const [conflict, setConflict] = useState(false);

  const numericQuantity = Number(quantity) || 0;
  const numericTarget = Number(target);
  const preview =
    type === 'RESTOCK'
      ? { before: row.quantityOnHand, after: row.quantityOnHand + numericQuantity }
      : type === 'DAMAGE'
        ? { before: row.quantityOnHand, after: row.quantityOnHand - numericQuantity }
        : { before: row.quantityOnHand, after: Number.isNaN(numericTarget) ? row.quantityOnHand : numericTarget };

  const invalid =
    (type !== 'ADJUSTMENT' && numericQuantity <= 0) ||
    (type === 'ADJUSTMENT' && (Number.isNaN(numericTarget) || numericTarget < 0)) ||
    ((type === 'ADJUSTMENT' || type === 'DAMAGE') && reason.trim().length < 3) ||
    preview.after < 0;

  const mutation = useMutation({
    mutationFn: () => {
      const input: AdjustInput =
        type === 'RESTOCK'
          ? { type, quantity: numericQuantity, restockReason: reason.trim() || undefined }
          : type === 'DAMAGE'
            ? { type, quantity: numericQuantity, reason: reason.trim() }
            : {
                type,
                newQuantityOnHand: numericTarget,
                expectedVersion: row.version,
                reason: reason.trim(),
              };
      return inventoryApi.adjust(organizationId, shopId, row.variantId, input);
    },
    onSuccess: (response) => {
      toast.success(
        `Stock ajusté : ${response.movement.quantityBefore} → ${response.movement.quantityAfter}.`,
      );
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.all(organizationId, shopId) });
      void queryClient.invalidateQueries({ queryKey: productKeys.all(organizationId, shopId) });
      onClose();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'INVENTORY_CONCURRENCY') {
        // Conflit : recharger les données fraîches, l'utilisateur reconfirme.
        setConflict(true);
        void queryClient.invalidateQueries({ queryKey: inventoryKeys.all(organizationId, shopId) });
        return;
      }
      toast.error(getErrorMessage(error));
    },
  });

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ajuster le stock</DialogTitle>
          <DialogDescription>
            {row.productName}
            {row.variantName ? ` — ${row.variantName}` : ''} · {row.sku}
          </DialogDescription>
        </DialogHeader>

        {conflict ? (
          <Alert variant="destructive" data-testid="concurrency-alert">
            <AlertDescription>
              Le stock a été modifié entre-temps par quelqu’un d’autre. Fermez ce dialogue, vérifiez
              la valeur actuelle et recommencez.
            </AlertDescription>
          </Alert>
        ) : null}

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!invalid && !conflict) {
              mutation.mutate();
            }
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="adjust-type">Type</Label>
            <Select value={type} onValueChange={(value) => setType(value as AdjustType)}>
              <SelectTrigger id="adjust-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(TYPE_LABELS) as AdjustType[]).map((candidate) => (
                  <SelectItem key={candidate} value={candidate}>
                    {TYPE_LABELS[candidate]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {type === 'ADJUSTMENT' ? (
            <div className="space-y-1.5">
              <Label htmlFor="adjust-target">Nouvelle quantité en stock</Label>
              <Input
                id="adjust-target"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                inputMode="numeric"
              />
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="adjust-quantity">
                Quantité {type === 'RESTOCK' ? 'ajoutée' : 'retirée'}
              </Label>
              <Input
                id="adjust-quantity"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                inputMode="numeric"
                placeholder="10"
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="adjust-reason">
              Raison {type === 'RESTOCK' ? '(facultative)' : '(obligatoire)'}
            </Label>
            <Textarea
              id="adjust-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={500}
              rows={2}
              placeholder={type === 'DAMAGE' ? 'Colis endommagé à la réception…' : ''}
            />
          </div>

          <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm" data-testid="adjust-preview">
            Aperçu : <span className="font-medium">{preview.before}</span> →{' '}
            <span className={`font-medium ${preview.after < 0 ? 'text-destructive' : ''}`}>
              {Number.isNaN(preview.after) ? '—' : preview.after}
            </span>
            {preview.after < 0 ? ' (impossible : le stock ne peut pas être négatif)' : ''}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {conflict ? 'Fermer' : 'Annuler'}
            </Button>
            <Button type="submit" disabled={invalid || conflict || mutation.isPending}>
              Confirmer l’ajustement
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
