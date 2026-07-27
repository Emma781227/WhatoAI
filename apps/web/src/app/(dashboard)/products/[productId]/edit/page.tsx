'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { ErrorState } from '@/components/feedback/error-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { categoriesApi, categoryKeys } from '@/features/categories/api';
import { useOrganization } from '@/features/organizations/organization-provider';
import { productKeys, productsApi, type ProductDetail, type UpdateVariantInput } from '@/features/products/api';
import { formatMinorAmount, minorToMajorInput, parseMajorToMinor } from '@/features/products/money';
import { useActiveShop } from '@/features/shops/shop-provider';
import { getErrorMessage } from '@/lib/api/api-error';

/**
 * Édition : champs scalaires du produit (PATCH) + prix/SKU par variante
 * (PATCH unitaire, décision validée — jamais de remplacement global).
 * La structure des combinaisons se gère depuis le détail (archiver/ajouter).
 */
function EditForm({ product }: { product: ProductDetail }) {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const { activeShop } = useActiveShop();
  const shopId = activeShop?.id ?? '';
  const router = useRouter();
  const queryClient = useQueryClient();

  const [name, setName] = useState(product.name);
  const [shortDescription, setShortDescription] = useState(product.shortDescription ?? '');
  const [description, setDescription] = useState(product.description ?? '');
  const [categoryId, setCategoryId] = useState(product.categoryId ?? 'NONE');
  const [variantEdits, setVariantEdits] = useState<
    Record<string, { sku: string; priceMajor: string }>
  >(() =>
    Object.fromEntries(
      product.variants
        .filter((variant) => variant.status !== 'ARCHIVED')
        .map((variant) => [
          variant.id,
          { sku: variant.sku, priceMajor: minorToMajorInput(variant.priceMinor, product.currency) },
        ]),
    ),
  );
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) {
      return;
    }
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const categoriesQuery = useQuery({
    queryKey: categoryKeys.list(organizationId, shopId, { limit: 100, status: 'ACTIVE' }),
    queryFn: () => categoriesApi.list(organizationId, shopId, { limit: 100, status: 'ACTIVE' }),
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      await productsApi.update(organizationId, shopId, product.id, {
        name: name.trim(),
        shortDescription: shortDescription.trim() === '' ? null : shortDescription.trim(),
        description: description.trim() === '' ? null : description.trim(),
        categoryId: categoryId === 'NONE' ? null : categoryId,
      });
      // Variantes : PATCH unitaires, uniquement les lignes réellement modifiées.
      for (const variant of product.variants) {
        const edit = variantEdits[variant.id];
        if (!edit) {
          continue;
        }
        const priceMinor = parseMajorToMinor(edit.priceMajor, product.currency);
        if (priceMinor === null) {
          throw new Error(`Prix invalide pour ${variant.sku}`);
        }
        const changes: UpdateVariantInput = {};
        if (edit.sku.trim().toUpperCase() !== variant.sku) {
          changes.sku = edit.sku.trim();
        }
        if (priceMinor !== variant.priceMinor) {
          changes.priceMinor = priceMinor;
        }
        if (Object.keys(changes).length > 0) {
          await productsApi.updateVariant(organizationId, shopId, product.id, variant.id, changes);
        }
      }
    },
    onSuccess: () => {
      setDirty(false);
      toast.success('Produit mis à jour.');
      void queryClient.invalidateQueries({ queryKey: productKeys.all(organizationId, shopId) });
      router.push(`/products/${product.id}`);
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  return (
    <form
      className="space-y-6"
      onChange={() => setDirty(true)}
      onSubmit={(event) => {
        event.preventDefault();
        saveMutation.mutate();
      }}
    >
      <Card>
        <CardHeader>
          <CardTitle>Informations</CardTitle>
          <CardDescription>Devise immuable : {product.currency}.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="edit-name">Nom</Label>
            <Input
              id="edit-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              minLength={2}
              maxLength={150}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-category">Catégorie</Label>
            <Select
              value={categoryId}
              onValueChange={(value) => {
                setCategoryId(value);
                setDirty(true);
              }}
            >
              <SelectTrigger id="edit-category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="NONE">Aucune</SelectItem>
                {product.category?.status === 'ARCHIVED' && product.categoryId ? (
                  <SelectItem value={product.categoryId}>
                    {product.category.name} (archivée)
                  </SelectItem>
                ) : null}
                {(categoriesQuery.data?.items ?? []).map((category) => (
                  <SelectItem key={category.id} value={category.id}>
                    {category.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="edit-short">Description courte</Label>
            <Input
              id="edit-short"
              value={shortDescription}
              onChange={(event) => setShortDescription(event.target.value)}
              maxLength={300}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="edit-description">Description</Label>
            <Textarea
              id="edit-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={5000}
              rows={4}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Prix &amp; SKU des variantes</CardTitle>
          <CardDescription>
            La structure des déclinaisons se gère depuis la fiche produit (ajouter/archiver une
            variante) — jamais de recréation des variantes existantes.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {product.variants
            .filter((variant) => variant.status !== 'ARCHIVED')
            .map((variant) => (
              <div key={variant.id} className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-3">
                <span className="w-full text-sm font-medium sm:w-40">
                  {variant.name ?? 'Par défaut'}
                  <span className="block text-xs font-normal text-muted-foreground">
                    Actuel : {formatMinorAmount(variant.priceMinor, product.currency)}
                  </span>
                </span>
                <div className="space-y-1.5">
                  <Label htmlFor={`edit-sku-${variant.id}`}>SKU</Label>
                  <Input
                    id={`edit-sku-${variant.id}`}
                    value={variantEdits[variant.id]?.sku ?? ''}
                    onChange={(event) =>
                      setVariantEdits((current) => ({
                        ...current,
                        [variant.id]: { ...current[variant.id], sku: event.target.value },
                      }))
                    }
                    className="w-44 uppercase"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`edit-price-${variant.id}`}>Prix ({product.currency})</Label>
                  <Input
                    id={`edit-price-${variant.id}`}
                    value={variantEdits[variant.id]?.priceMajor ?? ''}
                    onChange={(event) =>
                      setVariantEdits((current) => ({
                        ...current,
                        [variant.id]: { ...current[variant.id], priceMajor: event.target.value },
                      }))
                    }
                    inputMode="decimal"
                    className="w-32"
                  />
                </div>
              </div>
            ))}
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" asChild>
          <Link href={`/products/${product.id}`}>Annuler</Link>
        </Button>
        <Button type="submit" disabled={saveMutation.isPending || name.trim().length < 2}>
          Enregistrer
        </Button>
      </div>
    </form>
  );
}

export default function EditProductPage() {
  const params = useParams<{ productId: string }>();
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const { activeShop } = useActiveShop();
  const shopId = activeShop?.id ?? '';

  const query = useQuery({
    queryKey: productKeys.detail(organizationId, shopId, params.productId),
    queryFn: () => productsApi.get(organizationId, shopId, params.productId),
    enabled: activeShop !== null,
  });

  if (query.isPending) {
    return <Skeleton className="m-6 h-64 w-full" />;
  }
  if (query.isError) {
    return (
      <div className="p-6">
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link href="/products" className="hover:text-foreground hover:underline">
            Produits
          </Link>
          <span>/</span>
          <Link href={`/products/${query.data.id}`} className="hover:text-foreground hover:underline">
            {query.data.name}
          </Link>
          <span>/</span>
          <span className="text-foreground">Modifier</span>
        </div>
        <h1 className="font-heading text-xl font-bold">Modifier le produit</h1>
      </div>
      <EditForm product={query.data} />
    </div>
  );
}
