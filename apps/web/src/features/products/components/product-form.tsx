'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Star, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
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
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { categoriesApi, categoryKeys } from '@/features/categories/api';
import { useOrganization } from '@/features/organizations/organization-provider';
import { useActiveShop } from '@/features/shops/shop-provider';
import { getErrorMessage } from '@/lib/api/api-error';

import { productKeys, productsApi, type CreateProductInput, type ProductType } from '../api';
import { PRODUCT_TYPE_LABELS } from '../labels';
import { parseMajorToMinor } from '../money';
import {
  generateVariantCombinations,
  reconcileVariantDrafts,
  type OptionDraft,
} from '../variant-combinations';

interface VariantDraft {
  combinationKey: string;
  label: string;
  selections: Array<{ optionName: string; value: string }>;
  enabled: boolean;
  sku: string;
  priceMajor: string;
  compareAtMajor: string;
  initialQuantity: string;
  lowStockThreshold: string;
  trackInventory: boolean;
  allowBackorder: boolean;
}

function emptyDraft(
  key: string,
  label: string,
  selections: VariantDraft['selections'],
  physical: boolean,
): VariantDraft {
  return {
    combinationKey: key,
    label,
    selections,
    enabled: true,
    sku: '',
    priceMajor: '',
    compareAtMajor: '',
    initialQuantity: '0',
    lowStockThreshold: '5',
    trackInventory: physical,
    allowBackorder: false,
  };
}

interface ImageDraft {
  url: string;
  altText: string;
  isPrimary: boolean;
}

/**
 * Formulaire de création produit — 3 sections progressives (informations,
 * déclinaisons, prix & stock). Création = UN SEUL POST transactionnel
 * (produit + options + variantes + images + stock initial). Les saisies de
 * variantes SURVIVENT aux changements d'options tant que la combinaison
 * existe (clé canonique) ; toute disparition est signalée explicitement.
 */
export function ProductForm() {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const { activeShop } = useActiveShop();
  const router = useRouter();
  const queryClient = useQueryClient();
  const currency = activeShop?.currency ?? 'XAF';
  const shopId = activeShop?.id ?? '';

  // Section 1 — informations.
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [shortDescription, setShortDescription] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState<string>('NONE');
  const [productType, setProductType] = useState<ProductType>('PHYSICAL');
  const [images, setImages] = useState<ImageDraft[]>([]);
  const [imageUrlInput, setImageUrlInput] = useState('');

  // Section 2 — déclinaisons.
  const [hasOptions, setHasOptions] = useState(false);
  const [options, setOptions] = useState<Array<{ name: string; valuesText: string }>>([
    { name: '', valuesText: '' },
  ]);

  // Section 3 — variantes (prix & stock).
  const [drafts, setDrafts] = useState<VariantDraft[]>([
    emptyDraft('DEFAULT', 'Produit', [], true),
  ]);
  const [dirty, setDirty] = useState(false);

  const categoriesQuery = useQuery({
    queryKey: categoryKeys.list(organizationId, shopId, { limit: 100, status: 'ACTIVE' }),
    queryFn: () => categoriesApi.list(organizationId, shopId, { limit: 100, status: 'ACTIVE' }),
    enabled: activeShop !== null,
  });

  // Garde "modifications non enregistrées" (navigation navigateur).
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

  const physical = productType === 'PHYSICAL';

  const optionDrafts: OptionDraft[] = useMemo(
    () =>
      options.map((option) => ({
        name: option.name,
        values: option.valuesText.split(',').map((value) => value.trim()),
      })),
    [options],
  );

  /** Regénère les combinaisons en PRÉSERVANT les saisies existantes (par clé). */
  const regenerateCombinations = (nextOptions: OptionDraft[], nextHasOptions: boolean) => {
    setDirty(true);
    if (!nextHasOptions) {
      setDrafts((current) => {
        const existing = current.find((draft) => draft.combinationKey === 'DEFAULT');
        return [existing ?? emptyDraft('DEFAULT', 'Produit', [], physical)];
      });
      return;
    }
    const combinations = generateVariantCombinations(nextOptions);
    setDrafts((current) => {
      const { kept, removed } = reconcileVariantDrafts(
        current.filter((draft) => draft.combinationKey !== 'DEFAULT'),
        combinations,
      );
      const removedWithData = removed.filter(
        (draft) => draft.sku !== '' || draft.priceMajor !== '',
      );
      if (removedWithData.length > 0) {
        // Jamais de suppression silencieuse : les saisies perdues sont signalées.
        toast.warning(
          `${removedWithData.length} variante(s) saisie(s) ont disparu avec ce changement d'options : ${removedWithData
            .map((draft) => draft.label)
            .join(', ')}.`,
        );
      }
      const byKey = new Map(kept.map((draft) => [draft.combinationKey, draft]));
      return combinations.map(
        (combination) =>
          byKey.get(combination.key) ??
          emptyDraft(combination.key, combination.label, combination.selections, physical),
      );
    });
  };

  const createMutation = useMutation({
    mutationFn: (input: CreateProductInput) => productsApi.create(organizationId, shopId, input),
    onSuccess: (product) => {
      setDirty(false);
      toast.success('Produit créé (brouillon).');
      void queryClient.invalidateQueries({ queryKey: productKeys.all(organizationId, shopId) });
      router.push(`/products/${product.id}`);
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const submit = () => {
    const enabledDrafts = drafts.filter((draft) => draft.enabled);
    if (enabledDrafts.length === 0) {
      toast.error('Sélectionnez au moins une variante.');
      return;
    }
    const variants: CreateProductInput['variants'] = [];
    for (const draft of enabledDrafts) {
      const priceMinor = parseMajorToMinor(draft.priceMajor, currency);
      if (draft.sku.trim() === '' || priceMinor === null) {
        toast.error(`SKU et prix requis pour « ${draft.label} ».`);
        return;
      }
      const compareAt =
        draft.compareAtMajor.trim() === '' ? undefined : parseMajorToMinor(draft.compareAtMajor, currency);
      if (compareAt === null) {
        toast.error(`Prix barré invalide pour « ${draft.label} ».`);
        return;
      }
      variants.push({
        sku: draft.sku.trim(),
        priceMinor,
        compareAtPriceMinor: compareAt,
        trackInventory: physical ? draft.trackInventory : false,
        allowBackorder: draft.allowBackorder,
        optionSelections: draft.selections.length > 0 ? draft.selections : undefined,
        initialQuantity:
          physical && draft.trackInventory ? Number(draft.initialQuantity) || 0 : undefined,
        lowStockThreshold:
          physical && draft.trackInventory ? Number(draft.lowStockThreshold) || 5 : undefined,
      });
    }

    createMutation.mutate({
      name: name.trim(),
      slug: slug.trim() === '' ? undefined : slug.trim(),
      shortDescription: shortDescription.trim() === '' ? undefined : shortDescription.trim(),
      description: description.trim() === '' ? undefined : description.trim(),
      categoryId: categoryId === 'NONE' ? undefined : categoryId,
      productType,
      options: hasOptions
        ? optionDrafts
            .filter((option) => option.name.trim() !== '')
            .map((option) => ({
              name: option.name,
              values: option.values.filter((value) => value !== ''),
            }))
        : undefined,
      variants,
      images:
        images.length > 0
          ? images.map((image) => ({
              url: image.url,
              altText: image.altText === '' ? undefined : image.altText,
              isPrimary: image.isPrimary,
            }))
          : undefined,
    });
  };

  if (!activeShop) {
    return null;
  }

  const markDirty = () => setDirty(true);

  return (
    <form
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onChange={markDirty}
    >
      {/* ------------------------------------------------ Section 1 : infos */}
      <Card>
        <CardHeader>
          <CardTitle>1. Informations</CardTitle>
          <CardDescription>
            Devise héritée de la boutique : {currency}. Le produit naît en brouillon.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="product-name">Nom</Label>
            <Input
              id="product-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              minLength={2}
              maxLength={150}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="product-slug">Slug (généré si vide)</Label>
            <Input
              id="product-slug"
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              maxLength={50}
              placeholder="chemise-classique"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="product-category">Catégorie</Label>
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger id="product-category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="NONE">Aucune</SelectItem>
                {(categoriesQuery.data?.items ?? []).map((category) => (
                  <SelectItem key={category.id} value={category.id}>
                    {category.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="product-type">Type</Label>
            <Select
              value={productType}
              onValueChange={(value) => {
                setProductType(value as ProductType);
                markDirty();
              }}
            >
              <SelectTrigger id="product-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(PRODUCT_TYPE_LABELS) as ProductType[]).map((type) => (
                  <SelectItem key={type} value={type}>
                    {PRODUCT_TYPE_LABELS[type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!physical ? (
              <p className="text-xs text-muted-foreground">
                Les produits {PRODUCT_TYPE_LABELS[productType].toLowerCase()}s ne suivent pas de stock.
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="product-short">Description courte</Label>
            <Input
              id="product-short"
              value={shortDescription}
              onChange={(event) => setShortDescription(event.target.value)}
              maxLength={300}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="product-description">Description</Label>
            <Textarea
              id="product-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={5000}
              rows={4}
            />
          </div>

          {/* Images par URL (aucun upload dans cette phase). */}
          <div className="space-y-2 sm:col-span-2">
            <Label>Images (URLs)</Label>
            <div className="flex gap-2">
              <Input
                type="url"
                value={imageUrlInput}
                onChange={(event) => setImageUrlInput(event.target.value)}
                placeholder="https://exemple.com/image.jpg"
                aria-label="URL de l’image"
              />
              <Button
                type="button"
                variant="outline"
                disabled={imageUrlInput.trim() === '' || images.length >= 10}
                onClick={() => {
                  setImages((current) => [
                    ...current,
                    { url: imageUrlInput.trim(), altText: '', isPrimary: current.length === 0 },
                  ]);
                  setImageUrlInput('');
                  markDirty();
                }}
              >
                <Plus aria-hidden />
                Ajouter
              </Button>
            </div>
            {images.length > 0 ? (
              <ul className="space-y-2">
                {images.map((image, index) => (
                  <li key={`${image.url}-${index}`} className="flex items-center gap-2">
                    {/* eslint-disable-next-line @next/next/no-img-element -- URLs externes arbitraires */}
                    <img
                      src={image.url}
                      alt={image.altText}
                      className="h-12 w-12 rounded-md border border-border object-cover"
                    />
                    <Input
                      value={image.altText}
                      onChange={(event) =>
                        setImages((current) =>
                          current.map((candidate, candidateIndex) =>
                            candidateIndex === index
                              ? { ...candidate, altText: event.target.value }
                              : candidate,
                          ),
                        )
                      }
                      placeholder="Texte alternatif"
                      className="flex-1"
                      aria-label={`Texte alternatif image ${index + 1}`}
                    />
                    <Button
                      type="button"
                      variant={image.isPrimary ? 'default' : 'outline'}
                      size="icon"
                      aria-label={image.isPrimary ? 'Image principale' : 'Définir comme principale'}
                      onClick={() =>
                        setImages((current) =>
                          current.map((candidate, candidateIndex) => ({
                            ...candidate,
                            isPrimary: candidateIndex === index,
                          })),
                        )
                      }
                    >
                      <Star aria-hidden className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Retirer l’image"
                      onClick={() =>
                        setImages((current) => {
                          const next = current.filter((_, candidateIndex) => candidateIndex !== index);
                          if (next.length > 0 && !next.some((candidate) => candidate.isPrimary)) {
                            next[0] = { ...next[0], isPrimary: true };
                          }
                          return next;
                        })
                      }
                    >
                      <Trash2 aria-hidden className="h-4 w-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {/* ------------------------------------------- Section 2 : déclinaisons */}
      <Card>
        <CardHeader>
          <CardTitle>2. Déclinaisons</CardTitle>
          <CardDescription>
            Taille, couleur, volume… Les combinaisons sont générées automatiquement ; vos saisies
            sont conservées tant que la combinaison existe.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <Switch
              id="has-options"
              checked={hasOptions}
              onCheckedChange={(checked) => {
                setHasOptions(checked);
                regenerateCombinations(optionDrafts, checked);
              }}
            />
            <Label htmlFor="has-options">Ce produit a des déclinaisons</Label>
          </div>

          {hasOptions ? (
            <div className="space-y-3">
              {options.map((option, index) => (
                <div key={index} className="flex flex-wrap items-end gap-2">
                  <div className="space-y-1.5">
                    <Label htmlFor={`option-name-${index}`}>Option {index + 1}</Label>
                    <Input
                      id={`option-name-${index}`}
                      value={option.name}
                      onChange={(event) => {
                        const next = options.map((candidate, candidateIndex) =>
                          candidateIndex === index
                            ? { ...candidate, name: event.target.value }
                            : candidate,
                        );
                        setOptions(next);
                      }}
                      onBlur={() => regenerateCombinations(optionDrafts, true)}
                      placeholder="Taille"
                      className="w-40"
                    />
                  </div>
                  <div className="flex-1 space-y-1.5">
                    <Label htmlFor={`option-values-${index}`}>Valeurs (séparées par des virgules)</Label>
                    <Input
                      id={`option-values-${index}`}
                      value={option.valuesText}
                      onChange={(event) => {
                        const next = options.map((candidate, candidateIndex) =>
                          candidateIndex === index
                            ? { ...candidate, valuesText: event.target.value }
                            : candidate,
                        );
                        setOptions(next);
                      }}
                      onBlur={() => regenerateCombinations(optionDrafts, true)}
                      placeholder="S, M, L"
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Retirer l’option ${index + 1}`}
                    disabled={options.length <= 1}
                    onClick={() => {
                      const next = options.filter((_, candidateIndex) => candidateIndex !== index);
                      setOptions(next);
                      regenerateCombinations(
                        next.map((candidate) => ({
                          name: candidate.name,
                          values: candidate.valuesText.split(',').map((value) => value.trim()),
                        })),
                        true,
                      );
                    }}
                  >
                    <Trash2 aria-hidden className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={options.length >= 5}
                onClick={() => setOptions((current) => [...current, { name: '', valuesText: '' }])}
              >
                <Plus aria-hidden />
                Ajouter une option
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Produit simple : une seule offre vendable (la variante par défaut reste invisible).
            </p>
          )}
        </CardContent>
      </Card>

      {/* ------------------------------------------- Section 3 : prix & stock */}
      <Card>
        <CardHeader>
          <CardTitle>3. Prix &amp; stock</CardTitle>
          <CardDescription>
            Prix en {currency}. {physical ? 'Stock initial et seuil d’alerte par variante.' : 'Pas de stock pour ce type de produit.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {drafts.map((draft, index) => (
            <div
              key={draft.combinationKey}
              className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-3"
              data-testid="variant-draft-row"
            >
              {hasOptions ? (
                <div className="flex w-full items-center gap-2">
                  <input
                    type="checkbox"
                    id={`enabled-${index}`}
                    checked={draft.enabled}
                    onChange={(event) =>
                      setDrafts((current) =>
                        current.map((candidate) =>
                          candidate.combinationKey === draft.combinationKey
                            ? { ...candidate, enabled: event.target.checked }
                            : candidate,
                        ),
                      )
                    }
                    className="h-4 w-4 accent-primary"
                  />
                  <Label htmlFor={`enabled-${index}`} className="font-medium">
                    {draft.label}
                  </Label>
                  {!draft.enabled ? <Badge variant="outline">non créée</Badge> : null}
                </div>
              ) : null}
              <div className="space-y-1.5">
                <Label htmlFor={`sku-${index}`}>SKU</Label>
                <Input
                  id={`sku-${index}`}
                  value={draft.sku}
                  onChange={(event) =>
                    setDrafts((current) =>
                      current.map((candidate) =>
                        candidate.combinationKey === draft.combinationKey
                          ? { ...candidate, sku: event.target.value }
                          : candidate,
                      ),
                    )
                  }
                  disabled={!draft.enabled}
                  placeholder="TEE-M-ROUGE"
                  className="w-40 uppercase"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`price-${index}`}>Prix ({currency})</Label>
                <Input
                  id={`price-${index}`}
                  value={draft.priceMajor}
                  onChange={(event) =>
                    setDrafts((current) =>
                      current.map((candidate) =>
                        candidate.combinationKey === draft.combinationKey
                          ? { ...candidate, priceMajor: event.target.value }
                          : candidate,
                      ),
                    )
                  }
                  disabled={!draft.enabled}
                  inputMode="decimal"
                  placeholder="15000"
                  className="w-28"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`compare-${index}`}>Prix barré</Label>
                <Input
                  id={`compare-${index}`}
                  value={draft.compareAtMajor}
                  onChange={(event) =>
                    setDrafts((current) =>
                      current.map((candidate) =>
                        candidate.combinationKey === draft.combinationKey
                          ? { ...candidate, compareAtMajor: event.target.value }
                          : candidate,
                      ),
                    )
                  }
                  disabled={!draft.enabled}
                  inputMode="decimal"
                  className="w-28"
                />
              </div>
              {physical ? (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor={`stock-${index}`}>Stock initial</Label>
                    <Input
                      id={`stock-${index}`}
                      value={draft.initialQuantity}
                      onChange={(event) =>
                        setDrafts((current) =>
                          current.map((candidate) =>
                            candidate.combinationKey === draft.combinationKey
                              ? { ...candidate, initialQuantity: event.target.value }
                              : candidate,
                          ),
                        )
                      }
                      disabled={!draft.enabled || !draft.trackInventory}
                      inputMode="numeric"
                      className="w-24"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`threshold-${index}`}>Seuil faible</Label>
                    <Input
                      id={`threshold-${index}`}
                      value={draft.lowStockThreshold}
                      onChange={(event) =>
                        setDrafts((current) =>
                          current.map((candidate) =>
                            candidate.combinationKey === draft.combinationKey
                              ? { ...candidate, lowStockThreshold: event.target.value }
                              : candidate,
                          ),
                        )
                      }
                      disabled={!draft.enabled || !draft.trackInventory}
                      inputMode="numeric"
                      className="w-24"
                    />
                  </div>
                </>
              ) : null}
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => router.push('/products')}>
          Annuler
        </Button>
        <Button type="submit" disabled={createMutation.isPending || name.trim().length < 2}>
          Créer le produit
        </Button>
      </div>
    </form>
  );
}
