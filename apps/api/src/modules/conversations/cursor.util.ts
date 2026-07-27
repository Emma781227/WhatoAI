import { ValidationError } from '@whauto/shared';

/**
 * Curseur keyset (timestamp + id) encodé base64url — les listes temps réel
 * bougent en permanence, un offset y produirait des doublons/trous.
 */
export interface CursorPayload {
  /** Timestamp ISO de la ligne pivot. */
  t: string;
  /** Départage des timestamps identiques. */
  id: string;
}

export function encodeCursor(timestamp: Date, id: string): string {
  const payload: CursorPayload = { t: timestamp.toISOString(), id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorPayload {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorPayload;
    if (typeof parsed.t !== 'string' || typeof parsed.id !== 'string' || Number.isNaN(Date.parse(parsed.t))) {
      throw new Error('malformed');
    }
    return parsed;
  } catch {
    throw new ValidationError('Invalid pagination cursor.');
  }
}
