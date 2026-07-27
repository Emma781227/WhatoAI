import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@whauto/shared', '@whauto/config'],
  // Épingle la racine du monorepo explicitement : évite que Next.js déduise le
  // mauvais workspace root si un autre lockfile existe plus haut sur la machine.
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
};

export default nextConfig;
