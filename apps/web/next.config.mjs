/**
 * The browser only ever talks to this origin. `/api/*` is proxied to the NestJS service
 * (on Render: over the private network), so session cookies stay first-party and no CORS
 * is needed. API_INTERNAL_URL must be set at build time (Render provides it from the API service).
 */
const rawApi = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
// Render's fromService hostport gives "host:port" without a scheme.
const apiUrl = /^https?:\/\//.test(rawApi) ? rawApi : `http://${rawApi}`;

const prod = process.env.NODE_ENV === 'production';
/**
 * Content-Security-Policy: scripts only from this origin (Next.js needs inline bootstrap scripts),
 * no plugins, no framing, API calls and live updates to this origin only. Email bodies render in a
 * sandboxed iframe without scripts; remote images in them (https) load only when the user allows.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${prod ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src 'self'${prod ? '' : ' ws:'}`,
  "frame-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

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
          { key: 'Content-Security-Policy', value: csp },
          ...(prod ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }] : []),
        ],
      },
    ];
  },
};

export default nextConfig;
