'use client';

import Link from 'next/link';

import { ProductForm } from '@/features/products/components/product-form';

export default function NewProductPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link href="/products" className="hover:text-foreground hover:underline">
            Produits
          </Link>
          <span>/</span>
          <span className="text-foreground">Nouveau</span>
        </div>
        <h1 className="font-heading text-xl font-bold">Nouveau produit</h1>
      </div>
      <ProductForm />
    </div>
  );
}
