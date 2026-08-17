# With-NestJs | API

## Getting Started

First, run the development server:

```bash
pnpm run dev
# Also works with NPM, YARN, BUN, ...
```

By default, your server will run at [localhost:3000](http://localhost:3000). You can use your favorite API platform like [Insomnia](https://insomnia.rest/) or [Postman](https://www.postman.com/) to test your APIs

You can start editing the demo **APIs** by modifying [linksService](./src/links/links.service.ts) provider.

### Important Note 🚧

If you plan to `build` or `test` the app. Please make sure to build the `packages/*` first.

## Deployment: trusted proxy & client IP

Better Auth's rate limiter (per-IP brute-force throttles on `/sign-in/email`,
`/sign-up/email`, `/forget-password`, `/request-password-reset`) keys on the
resolved client IP. The auth controller always stamps Express `req.ip` into an
internal, server-set header and keys the limiter solely on that value, so the
limiter never reads a client-controllable header (`x-forwarded-for`,
`cf-connecting-ip`) directly. `req.ip` is resolved by Express `trust proxy`,
which honours the configured hop count — eliminating both the leftmost-XFF and
the spoofable-`cf-connecting-ip` bypasses.

- **`TRUST_PROXY`** (unset by default): Express `trust proxy` value — `true`/`1`
  for the first hop, an integer for N hops, or an address/preset (e.g.
  `loopback`, a CIDR list). It MUST match the real number of trusted reverse
  proxies in front of the API so `req.ip` resolves to the genuine client and not
  an attacker-appended `x-forwarded-for` entry.
- When `TRUST_PROXY` is **unset**, `req.ip` is the non-spoofable peer address, so
  a bare/exposed deployment cannot inherit any bypass.

**Operational requirements:**

- Set `TRUST_PROXY` to the exact hop count of trusted proxies. Too high lets a
  client prepend a forged `x-forwarded-for` entry that Express then trusts.
- Behind **Cloudflare**, set `TRUST_PROXY` to the hop count so `req.ip` resolves
  from the `x-forwarded-for` chain Cloudflare appends. The app does not read
  `cf-connecting-ip`; do not rely on it for rate-limit keying.

## API Documentation

This app uses ts-rest + `@ts-rest/open-api` to generate OpenAPI docs from the shared API contract.

### Generate docs without starting the server

```bash
pnpm docs:generate
```

This command runs `src/scripts/generate-openapi.ts` and writes:

- `openapi/public.json`

### Runtime docs routes

When the API server is running, interactive docs are available at:

- Swagger UI: `http://localhost:3000/api/swagger`
- ReDoc: `http://localhost:3000/api/redoc`

Runtime route registration is handled by `src/common/docs-setup.ts`, keeping `src/main.ts` focused on app bootstrap.

## Learn More

Learn more about `NestJs` with following resources:

- [Official Documentation](https://docs.nestjs.com) - A progressive Node.js framework for building efficient, reliable and scalable server-side applications.
- [Official NestJS Courses](https://courses.nestjs.com) - Learn everything you need to master NestJS and tackle modern backend applications at any scale.
- [GitHub Repo](https://github.com/nestjs/nest)
