import { defineConfig, devices } from '@playwright/test';

/**
 * E2E navigateur contre la VRAIE API (apps/api, préalablement buildée) et la
 * vraie base de dev. L'API est lancée avec l'ENVIRONNEMENT DE TEST uniquement
 * (Redis DB 1, limites de rate limit hautes, devLinks exposés) — les valeurs
 * de production ne sont jamais modifiées. Données préfixées par run.
 *
 * Le front e2e tourne sur le port 3001 (dédié aux tests — le 3000 peut être
 * occupé par un autre dev server sur la machine) et reuseExistingServer est
 * désactivé : on échoue explicitement plutôt que de tester une autre app.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3001',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @whauto/api start',
      cwd: '../..',
      url: 'http://localhost:4000/api/health',
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: 'development',
        AUTH_EXPOSE_TEST_TOKENS: 'true',
        REDIS_URL: 'redis://localhost:6379/1',
        CORS_ORIGIN: 'http://localhost:3001',
        // Module conversationnel : endpoints de simulation + retries rapides.
        // Le worker (sans port HTTP, donc hors webServer) est lancé par la
        // spec whatsapp-inbox elle-même (voir e2e/whatsapp-inbox.spec.ts).
        ENABLE_MOCK_WHATSAPP_ENDPOINTS: 'true',
        WHATSAPP_JOB_ATTEMPTS: '2',
        WHATSAPP_JOB_BACKOFF_MS: '300',
        AUTH_RATE_LIMIT_LOGIN_MAX: '1000',
        AUTH_RATE_LIMIT_REGISTER_MAX: '1000',
        AUTH_RATE_LIMIT_REFRESH_MAX: '1000',
        AUTH_RATE_LIMIT_RESET_MAX: '1000',
        AUTH_RATE_LIMIT_FORGOT_PASSWORD_MAX: '1000',
        AUTH_RATE_LIMIT_RESEND_VERIFICATION_MAX: '1000',
      },
    },
    {
      // Build de PRODUCTION (`pnpm --filter @whauto/web build` requis avant) :
      // le mode dev rebuild en continu (watcher) et avorte les navigations RSC
      // pendant les tests — e2e non fiables en dev.
      command: 'pnpm --filter @whauto/web exec next start -p 3001',
      cwd: '../..',
      url: 'http://localhost:3001',
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
