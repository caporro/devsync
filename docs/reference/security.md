# Security notes

## API authentication

API authentication uses Fastify's resolved route (`request.routeOptions.url`) for both protected API routes and the public route allowlist. Checking the raw URL prefix is unsafe: `/%61pi/users` resolves to `/api/users` and must require the same authentication.

Regression tests cover encoded reads and writes, password sessions, invalid sessions, bearer/API header tokens, and public health/login endpoints. API responses return public user fields, never password hashes.

When responding to the Wiz finding, deploy the application fix and have the infrastructure owner apply the recommended temporary WAF controls. A `401` from the plain `/api/users` URL alone does not verify remediation; encoded variants must also be rejected without credentials. Re-run the Wiz validation after updating the running image.

## Browser requests and local development

API and HTTP MCP requests validate `Origin` before body parsing or authentication. Same-origin requests and the configured `DEVSYNC_PUBLIC_URL` are accepted; additional trusted origins can be listed in `DEVSYNC_ALLOWED_ORIGINS`. Opaque (`null`), malformed and untrusted origins receive `403`. Requests without an Origin remain available to CLI/MCP clients; cross-site browser fetch metadata is rejected. This also protects login and multipart uploads. Authentication is still required where configured.

With `AUTH_MODE=none`, Host must be a loopback hostname/address, the explicit bind host, or the hostname configured by `DEVSYNC_PUBLIC_URL`. Wildcard bind addresses do not trust arbitrary hostnames. The public health endpoint is exempt from this hostname restriction for Docker probes. This blocks DNS rebinding against anonymous local APIs. Vite preserves the original Host when proxying API/MCP calls so normal development requests stay same-origin.

Behind an HTTPS reverse proxy, preserve the public Host and set `DEVSYNC_PUBLIC_URL`. An HTTPS Origin with the same authority is accepted when Fastify receives HTTP from the proxy. Arbitrary forwarded headers do not grant trust. These checks follow the [MCP HTTP transport security requirement](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#security-warning).

The development Compose publishes ports 4000 and 5173 on `127.0.0.1` only. Its anonymous default is for private local development. Containers have writable source mounts and run as root to install into Docker dependency volumes; they are development tools, not the production sandbox. Keep public/shared deployments on password authentication and HTTPS with secure cookies.

## Filesystem and document search

Directory creation validates every ancestor before creating descendants. Symlinks are rejected before a nested write can create folders outside the vault. Document indexing also rejects symlinks, parameterizes SQL values, and converts search terms to quoted plain words joined with AND rather than accepting raw FTS syntax. Five-character document IDs are references, not access credentials; document and search APIs use the existing authentication policy.

Regression tests use isolated temporary vaults for traversal, nested symlink writes, cross-origin uploads, DNS rebinding, session authentication, protected document/search routes, immutable attribution, and document revision conflicts. They do not probe writes against the user's real vault.

## Dependency updates

Both lockfiles pin the resolved dependency graph. `npm audit --audit-level=moderate` remains blocking in CI, including development dependencies; no advisories are ignored.

Upstream `braces@3.0.3` has no patched release for [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm). Both packages therefore override `braces` with the exact MIT-licensed fork [`@dieub/braces-depth-guard@3.0.3-pn.3`](https://github.com/dieub/braces-depth-guard). This is a third-party fork, not an official upstream release. Its published JavaScript was compared with upstream: it adds limits to parsing and AST traversal while preserving the existing API. The lockfiles retain its real package identity and registry integrity.

The fork caps nesting at 100 and keeps the 10,000-character input bound. Backend regression tests exercise deeply nested inputs through the installed agent dependency and verify normal glob matching. Revisit this replacement when upstream offers a suitable fix; do not switch to the fork's `latest` tag, which points to an older release.

Frontend overrides keep `nanoid` 3 on its patched release line, upgrade older ESM consumers from 4/5 to patched 5, and update older KaTeX consumers without downgrading newer ones.

The November 2026 review updated the backend graph for `@fastify/static`, `body-parser`, `fast-uri`, `glob`, `minimatch` and `zod` advisories. The frontend no longer installs the `shadcn` CLI just to import its CSS: the exact stylesheet is kept in `web/src/styles/shadcn.css` with its MIT license. The frontend override for affected `minimatch` releases updates ESLint's transitive dependency; lint and build checks verify compatibility. Re-run both audits after dependency changes: a clean audit describes the registry's known advisories at that time, not a general security guarantee.

## Container validation

The Docker workflow runs backend tests in the production AMD64 image as its non-root user, with `NODE_ENV=test` and network access disabled. The tests use temporary storage and Fastify injection, without opening a listening server. Both AMD64 and ARM64 are then built; ARM64 runtime tests are not run by this workflow.

Images are published only on version tags after the checks pass. Docker Hub publishing and the deployment of a running service are separate operations.
