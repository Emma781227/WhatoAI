'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

interface ComposerInsertValue {
  /** Valeur + nonce : chaque insertion est appliquée une seule fois par le Composer. */
  insertText: { value: string; nonce: number } | null;
  /** PRÉREMPLIT le composer — l'envoi reste toujours l'action explicite de l'agent. */
  insert: (text: string) => void;
}

const ComposerInsertContext = createContext<ComposerInsertValue | null>(null);

/**
 * Canal d'insertion vers le composer, partagé entre le fil (sélecteur
 * produit) et le panneau droit (résumé panier) — évite tout couplage direct
 * entre panneaux.
 */
export function ComposerInsertProvider({ children }: { children: ReactNode }) {
  const [insertText, setInsertText] = useState<{ value: string; nonce: number } | null>(null);
  const insert = useCallback((text: string) => {
    setInsertText((current) => ({ value: text, nonce: (current?.nonce ?? 0) + 1 }));
  }, []);
  const value = useMemo(() => ({ insertText, insert }), [insertText, insert]);
  return <ComposerInsertContext.Provider value={value}>{children}</ComposerInsertContext.Provider>;
}

export function useComposerInsert(): ComposerInsertValue {
  const context = useContext(ComposerInsertContext);
  if (!context) {
    throw new Error('useComposerInsert doit être utilisé sous ComposerInsertProvider');
  }
  return context;
}
