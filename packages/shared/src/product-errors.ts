import { DomainError } from './errors';

/** 404 : catégorie inexistante OU d'une autre organisation/Shop (anti-énumération). */
export class CategoryNotFoundError extends DomainError {
  constructor() {
    super('Category not found.', 'CATEGORY_NOT_FOUND', 404);
    this.name = 'CategoryNotFoundError';
  }
}

export class CategorySlugAlreadyUsedError extends DomainError {
  constructor() {
    super('This category slug is already in use within the shop.', 'CATEGORY_SLUG_ALREADY_USED', 409);
    this.name = 'CategorySlugAlreadyUsedError';
  }
}

export class CategoryNameAlreadyUsedError extends DomainError {
  constructor() {
    super(
      'A category with this name already exists in the shop (case-insensitive).',
      'CATEGORY_NAME_ALREADY_USED',
      409,
    );
    this.name = 'CategoryNameAlreadyUsedError';
  }
}

export class CategoryArchivedError extends DomainError {
  constructor() {
    super('This category is archived and can no longer be used.', 'CATEGORY_ARCHIVED', 409);
    this.name = 'CategoryArchivedError';
  }
}

export class ProductNotFoundError extends DomainError {
  constructor() {
    super('Product not found.', 'PRODUCT_NOT_FOUND', 404);
    this.name = 'ProductNotFoundError';
  }
}

export class ProductSlugAlreadyUsedError extends DomainError {
  constructor() {
    super('This product slug is already in use within the shop.', 'PRODUCT_SLUG_ALREADY_USED', 409);
    this.name = 'ProductSlugAlreadyUsedError';
  }
}

export class ProductArchivedError extends DomainError {
  constructor() {
    super('This product is archived and can no longer be modified.', 'PRODUCT_ARCHIVED', 409);
    this.name = 'ProductArchivedError';
  }
}

export class InvalidProductStatusTransitionError extends DomainError {
  constructor(from: string, to: string) {
    super(
      `Invalid product status transition: ${from} -> ${to}.`,
      'INVALID_PRODUCT_STATUS_TRANSITION',
      409,
    );
    this.name = 'InvalidProductStatusTransitionError';
  }
}

export class ProductActivationRequirementsError extends DomainError {
  constructor(reasons: string[]) {
    super(
      `The product cannot be activated: ${reasons.join('; ')}.`,
      'PRODUCT_ACTIVATION_REQUIREMENTS',
      422,
    );
    this.name = 'ProductActivationRequirementsError';
  }
}

export class VariantNotFoundError extends DomainError {
  constructor() {
    super('Variant not found.', 'VARIANT_NOT_FOUND', 404);
    this.name = 'VariantNotFoundError';
  }
}

export class VariantSkuAlreadyUsedError extends DomainError {
  constructor() {
    super(
      'This SKU is already in use within the shop (case-insensitive).',
      'VARIANT_SKU_ALREADY_USED',
      409,
    );
    this.name = 'VariantSkuAlreadyUsedError';
  }
}

export class VariantBarcodeAlreadyUsedError extends DomainError {
  constructor() {
    super('This barcode is already in use within the shop.', 'VARIANT_BARCODE_ALREADY_USED', 409);
    this.name = 'VariantBarcodeAlreadyUsedError';
  }
}

export class InvalidSkuFormatError extends DomainError {
  constructor() {
    super(
      'Invalid SKU: 1-50 characters, letters/digits and . _ / -, must start alphanumeric.',
      'INVALID_SKU_FORMAT',
      400,
    );
    this.name = 'InvalidSkuFormatError';
  }
}

export class DuplicateVariantCombinationError extends DomainError {
  constructor() {
    super(
      'A variant with the same option combination already exists for this product.',
      'DUPLICATE_VARIANT_COMBINATION',
      409,
    );
    this.name = 'DuplicateVariantCombinationError';
  }
}

/**
 * La dernière variante ACTIVE d'un produit ACTIVE ne peut être ni désactivée
 * ni archivée : désactiver d'abord le produit, ou activer une autre variante.
 */
export class CannotArchiveLastActiveVariantError extends DomainError {
  constructor() {
    super(
      'Cannot deactivate or archive the last active variant of an active product.',
      'CANNOT_ARCHIVE_LAST_ACTIVE_VARIANT',
      409,
    );
    this.name = 'CannotArchiveLastActiveVariantError';
  }
}

export class VariantArchivedError extends DomainError {
  constructor() {
    super('This variant is archived and can no longer be modified.', 'VARIANT_ARCHIVED', 409);
    this.name = 'VariantArchivedError';
  }
}

/** Option/valeur encore utilisée par des variantes non archivées : suppression refusée. */
export class OptionInUseError extends DomainError {
  constructor() {
    super(
      'This option or value is used by non-archived variants. Archive those variants explicitly first.',
      'OPTION_IN_USE',
      409,
    );
    this.name = 'OptionInUseError';
  }
}

/** Stock non suivi (trackInventory=false, ou SERVICE/DIGITAL) : opération sans objet. */
export class InventoryNotTrackedError extends DomainError {
  constructor() {
    super('Inventory is not tracked for this variant.', 'INVENTORY_NOT_TRACKED', 409);
    this.name = 'InventoryNotTrackedError';
  }
}

export class InsufficientStockError extends DomainError {
  constructor() {
    super(
      'Insufficient stock: quantity on hand can never become negative.',
      'INSUFFICIENT_STOCK',
      409,
    );
    this.name = 'InsufficientStockError';
  }
}

export class InvalidInventoryAdjustmentError extends DomainError {
  constructor(reason: string) {
    super(`Invalid inventory adjustment: ${reason}`, 'INVALID_INVENTORY_ADJUSTMENT', 400);
    this.name = 'InvalidInventoryAdjustmentError';
  }
}

/** Verrou optimiste : le stock a changé entre la lecture et l'écriture — relire puis réessayer. */
export class InventoryConcurrencyError extends DomainError {
  constructor() {
    super(
      'The inventory was modified concurrently. Reload the current quantity and retry.',
      'INVENTORY_CONCURRENCY',
      409,
    );
    this.name = 'InventoryConcurrencyError';
  }
}
