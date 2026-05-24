# Security Policy

## Supported Versions

Security fixes target the latest release and the `main` branch.

## Reporting a Vulnerability

Do not open a public issue for exploitable vulnerabilities, secrets, tokens, or private data exposure.

Use GitHub private vulnerability reporting if it is enabled for the repository. If it is not enabled, contact the maintainer through the published repository before sharing exploit details.

Include:

- affected version or commit;
- deployment mode and relevant config;
- clear reproduction steps;
- impact and affected data;
- whether the issue is already public.

## Security Expectations

- Do not commit real vault data, tokens, `.env` files, API keys, logs, or private customer files.
- Keep `AUTH_MODE=password` for public/self-hosted deployments.
- Use HTTPS and `AUTH_COOKIE_SECURE=true` in production.
- Keep dependency audit checks passing before release.
