# Security notes

## API authentication

API authentication uses Fastify's resolved route (`request.routeOptions.url`) for both protected API routes and the public route allowlist. Checking the raw URL prefix is unsafe: `/%61pi/users` resolves to `/api/users` and must require the same authentication.

Regression tests cover encoded reads and writes, password sessions, invalid sessions, bearer/API header tokens, and public health/login endpoints. API responses return public user fields, never password hashes.

When responding to the Wiz finding, deploy the application fix and have the infrastructure owner apply the recommended temporary WAF controls. A `401` from the plain `/api/users` URL alone does not verify remediation; encoded variants must also be rejected without credentials. Re-run the Wiz validation after updating the running image.

## Dependency updates

Both lockfiles pin the resolved dependency graph. `npm audit --audit-level=moderate` remains blocking in CI, including development dependencies; no advisories are ignored.

Upstream `braces@3.0.3` has no patched release for [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm). Both packages therefore override `braces` with the exact MIT-licensed fork [`@dieub/braces-depth-guard@3.0.3-pn.3`](https://github.com/dieub/braces-depth-guard). This is a third-party fork, not an official upstream release. Its published JavaScript was compared with upstream: it adds limits to parsing and AST traversal while preserving the existing API. The lockfiles retain its real package identity and registry integrity.

The fork caps nesting at 100 and keeps the 10,000-character input bound. Backend regression tests exercise deeply nested inputs through the installed agent dependency and verify normal glob matching. Revisit this replacement when upstream offers a suitable fix; do not switch to the fork's `latest` tag, which points to an older release.

Frontend overrides keep `nanoid` 3 on its patched release line, upgrade older ESM consumers from 4/5 to patched 5, and update older KaTeX consumers without downgrading newer ones.

## Container validation

The Docker workflow runs backend tests in the production AMD64 image as its non-root user, with `NODE_ENV=test` and network access disabled. The tests use temporary storage and Fastify injection, without opening a listening server. Both AMD64 and ARM64 are then built; ARM64 runtime tests are not run by this workflow.

Images are published only on version tags after the checks pass. Docker Hub publishing and the deployment of a running service are separate operations.
