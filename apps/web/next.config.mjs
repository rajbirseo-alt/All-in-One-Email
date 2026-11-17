/**
 * The browser only ever talks to this origin. `/api/*` is proxied to the NestJS service
 * (on Render: over the private network), so session cookies stay first-party and no CORS
 * is needed. API_INTERNAL_URL must be set at build time (Render provides it from the API service).
 */
const rawApi = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
// Render's fromService hostport gives "host:port" without a scheme.
const apiUrl = /^https?:\/\//.test(rawApi) ? rawApi : `http://${rawApi}`;

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@crm/shared'],
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl.replace(/\/$/, '')}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
