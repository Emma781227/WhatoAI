import { applyDecorators, UseGuards } from '@nestjs/common';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';

/**
 * Un throttler nommé par endpoint sensible, configuré via les variables
 * AUTH_RATE_LIMIT_*_MAX / AUTH_RATE_LIMIT_*_WINDOW_SECONDS (voir auth.module.ts).
 */
export const AUTH_THROTTLER_NAMES = [
  'login',
  'register',
  'refresh',
  'reset',
  'forgot-password',
  'resend-verification',
] as const;

export type AuthThrottlerName = (typeof AUTH_THROTTLER_NAMES)[number];

/**
 * Applique uniquement le throttler nommé `name` sur la route décorée.
 * @nestjs/throttler évalue TOUS les throttlers déclarés sur chaque route
 * gardée — on désactive donc explicitement les autres via SkipThrottle.
 */
export function AuthThrottle(name: AuthThrottlerName): MethodDecorator {
  const skips = Object.fromEntries(
    AUTH_THROTTLER_NAMES.filter((other) => other !== name).map((other) => [other, true]),
  );
  return applyDecorators(UseGuards(ThrottlerGuard), SkipThrottle(skips));
}
