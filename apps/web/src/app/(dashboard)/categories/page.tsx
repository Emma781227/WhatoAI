'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Pencil, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { EmptyState } from '@/components/feedback/empty-state';
import { ErrorState } from '@/components/feedback/error-state';
import { Badge } from '@/components/ui/badge';
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
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { categoriesApi, categoryKeys, type Category } from '@/features/categories/api';
import { useOrganization } from '@/features/organizations/organization-provider';
import { useActiveShop } from '@/features/shops/shop-provider';
import { getErrorMessage } from '@/lib/api/api-error';
import { PERMISSIONS } from '@/lib/permissions/constants';
import { Can, usePermissions } from '@/lib/permissions/use-permissions';

const STATUS_LABELS: Record<Category['status'], string> = {
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  ARCHIVED: 'Archivée',
};

function CategoryDialog({
  category,
  onClose,
  organizationId,
  shopId,
}: {
  category: Category | null; // null = création
  onClose: () => void;
  organizationId: string;
  shopId: string;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(category?.name ?? '');
  const [description, setDescription] = useState(category?.description ?? '');
  const [imageUrl, setImageUrl] = useState(category?.imageUrl ?? '');

  const mutation = useMutation({
    mutationFn: () => {
      if (category === null) {
        return categoriesApi.create(organizationId, shopId, {
          name: name.trim(),
          description: description.trim() === '' ? undefined : description.trim(),
          imageUrl: imageUrl.trim() === '' ? undefined : imageUrl.trim(),
        });
      }
      return categoriesApi.update(organizationId, shopId, category.id, {
        name: name.trim(),
        description: description.trim() === '' ? null : description.trim(),
        imageUrl: imageUrl.trim() === '' ? null : imageUrl.trim(),
      });
    },
    onSuccess: () => {
      toast.success(category === null ? 'Catégorie créée.' : 'Catégorie mise à jour.');
      void queryClient.invalidateQueries({ queryKey: categoryKeys.all(organizationId, shopId) });
      onClose();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{category === null ? 'Nouvelle catégorie' : 'Modifier la catégorie'}</DialogTitle>
          <DialogDescription>
            Les catégories organisent le catalogue de la boutique active.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="category-name">Nom</Label>
            <Input
              id="category-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              minLength={2}
              maxLength={100}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="category-description">Description</Label>
            <Textarea
              id="category-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={1000}
              rows={3}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="category-image">Image (URL https)</Label>
            <Input
              id="category-image"
              type="url"
              value={imageUrl}
              onChange={(event) => setImageUrl(event.target.value)}
              placeholder="https://…"
              maxLength={2000}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Annuler
            </Button>
            <Button type="submit" disabled={mutation.isPending || name.trim().length < 2}>
              {category === null ? 'Créer' : 'Enregistrer'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function CategoriesPage() {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const { activeShop } = useActiveShop();
  const { can } = usePermissions();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Category | null>(null);
  const [creating, setCreating] = useState(false);

  const shopId = activeShop?.id ?? '';
  const params = { search: search.trim() === '' ? undefined : search.trim(), page, limit: 20 };
  const query = useQuery({
    queryKey: categoryKeys.list(organizationId, shopId, params),
    queryFn: () => categoriesApi.list(organizationId, shopId, params),
    enabled: activeShop !== null,
  });

  const archiveMutation = useMutation({
    mutationFn: (categoryId: string) => categoriesApi.archive(organizationId, shopId, categoryId),
    onSuccess: () => {
      toast.success('Catégorie archivée — les produits existants la conservent (historique).');
      void queryClient.invalidateQueries({ queryKey: categoryKeys.all(organizationId, shopId) });
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  if (!activeShop) {
    return (
      <EmptyState
        title="Aucune boutique"
        description="Créez une boutique pour organiser son catalogue."
      />
    );
  }

  const categories = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / 20));

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Link href="/products" className="hover:text-foreground hover:underline">
              Produits
            </Link>
            <span>/</span>
            <span className="text-foreground">Catégories</span>
          </div>
          <h1 className="font-heading text-xl font-bold">Catégories</h1>
          <p className="text-sm text-muted-foreground">
            Boutique {activeShop.name} — {total} catégorie(s)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative w-56">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              placeholder="Rechercher…"
              className="pl-8"
              aria-label="Rechercher une catégorie"
            />
          </div>
          <Can permission={PERMISSIONS.CATEGORIES_CREATE}>
            <Button type="button" onClick={() => setCreating(true)}>
              <Plus aria-hidden />
              Nouvelle catégorie
            </Button>
          </Can>
        </div>
      </div>

      {query.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : categories.length === 0 ? (
        <EmptyState
          title="Aucune catégorie"
          description="Créez votre première catégorie pour organiser vos produits."
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nom</TableHead>
                <TableHead>Slug</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {categories.map((category) => (
                <TableRow key={category.id}>
                  <TableCell className="font-medium">{category.name}</TableCell>
                  <TableCell className="text-muted-foreground">{category.slug}</TableCell>
                  <TableCell>
                    <Badge variant={category.status === 'ACTIVE' ? 'secondary' : 'outline'}>
                      {STATUS_LABELS[category.status]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      {can(PERMISSIONS.CATEGORIES_UPDATE) && category.status !== 'ARCHIVED' ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => setEditing(category)}
                          aria-label={`Modifier ${category.name}`}
                        >
                          <Pencil aria-hidden className="h-4 w-4" />
                        </Button>
                      ) : null}
                      {can(PERMISSIONS.CATEGORIES_ARCHIVE) && category.status !== 'ARCHIVED' ? (
                        <ConfirmDialog
                          trigger={
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={`Archiver ${category.name}`}
                            >
                              <Archive aria-hidden className="h-4 w-4" />
                            </Button>
                          }
                          title={`Archiver « ${category.name} » ?`}
                          description="Action définitive. Les produits liés conservent cette catégorie dans leur historique ; elle ne sera plus proposée dans les formulaires."
                          confirmLabel="Archiver"
                          destructive
                          onConfirm={() => archiveMutation.mutate(category.id)}
                        />
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {totalPages > 1 ? (
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((value) => value - 1)}
              >
                Précédent
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {page} / {totalPages}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((value) => value + 1)}
              >
                Suivant
              </Button>
            </div>
          ) : null}
        </>
      )}

      {creating ? (
        <CategoryDialog
          category={null}
          onClose={() => setCreating(false)}
          organizationId={organizationId}
          shopId={shopId}
        />
      ) : null}
      {editing ? (
        <CategoryDialog
          category={editing}
          onClose={() => setEditing(null)}
          organizationId={organizationId}
          shopId={shopId}
        />
      ) : null}
    </div>
  );
}
