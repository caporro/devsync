# Environment Variables Reference

Main environment variables.

## Server

| Variable | Default | Use |
| --- | --- | --- |
| `PORT` | `4000` | HTTP port. |
| `HOST` | `127.0.0.1` | Bind host. Use `0.0.0.0` in Docker. |
| `NODE_ENV` | empty | `test` disables server startup and scheduler. |
| `DEVSYNC_WEB_DIST` | `web/dist` | Frontend build directory. |
| `DEVSYNC_SELF_HOSTED` | Docker: `true` | If true, default auth becomes password. |

## Auth

| Variable | Default | Use |
| --- | --- | --- |
| `AUTH_MODE` | local `none`, self-hosted `password` | Auth mode. |
| `DEVSYNC_AUTH_MODE` | empty | Legacy alias. |
| `AUTH_USERS` | empty | User list in `email|name|hash` format. |
| `DEVSYNC_AUTH_USERS` | empty | Legacy alias. |
| `AUTH_SESSION_SECRET` | empty | Session HMAC secret. Minimum 32 characters. |
| `DEVSYNC_AUTH_SESSION_SECRET` | empty | Legacy alias. |
| `AUTH_SESSION_SECONDS` | 7 days | Session duration. |
| `AUTH_COOKIE_SECURE` | `false` | Secure cookie flag. Use true only with HTTPS. |

## Vault and Storage

| Variable | Default | Use |
| --- | --- | --- |
| `DEVSYNC_DATA_ROOT` | `./data` | Parent directory for vaults. |
| `DEVSYNC_VAULT_NAME` | `devsync-vault` | Vault name. |
| `DEVSYNC_DATA_DIR` | empty | Legacy: direct path to `projects/`. |
| `DEVSYNC_MAX_UPLOAD_BYTES` | `52428800` | File upload limit. |
| `DEVSYNC_ACTIVITY_INLINE_MAX_CHARS` | `800` | Inline log threshold. |
| `DEVSYNC_ACTIVITY_LOG_ENTRIES_PER_FILE` | `50` | Entries per activity log segment. |
| `DEVSYNC_ACTIVITY_LOG_FILES` | `2` | Activity log segments loaded by default. |

## API and MCP

| Variable | Default | Use |
| --- | --- | --- |
| `DEVSYNC_API_TOKEN` | empty | Static bearer token for API/MCP. Prefer personal MCP tokens. |
| `DEVSYNC_RATE_LIMIT_WINDOW_MS` | `600000` | Rate limit window. |
| `DEVSYNC_LOGIN_USER_LIMIT` | `8` | Login attempts per user. |
| `DEVSYNC_LOGIN_IP_LIMIT` | `30` | Login attempts per IP. |
| `DEVSYNC_MCP_AUTH_LIMIT` | `60` | MCP auth attempts per IP. |
| `DEVSYNC_MCP_TOKEN_CREATE_LIMIT` | `10` | MCP token creations per user/IP. |

## AI Model

| Variable | Default | Use |
| --- | --- | --- |
| `DEVSYNC_AGENT_MODEL` | `openai:gpt-4.1-mini` | Model for Assistant/workflows. |
| `DEVSYNC_ASSISTANT_MODEL` | empty | Assistant model override. |
| `OPENAI_API_KEY` | empty | OpenAI/OpenAI-compatible key. |
| `OPENAI_BASE_URL` | empty | OpenAI-compatible endpoint. |
| `OPENAI_API_BASE_URL` | empty | Base URL alias. |
| `OPENAI_API_BASE` | empty | Base URL alias. |
| `ANTHROPIC_API_KEY` | empty | Anthropic. |
| `GOOGLE_API_KEY` | empty | Google GenAI. |
| `MISTRAL_API_KEY` | empty | Mistral. |
| `GROQ_API_KEY` | empty | Groq. |

## Bedrock

| Variable | Default | Use |
| --- | --- | --- |
| `BEDROCK_AWS_REGION` | empty | Bedrock region. |
| `AWS_REGION` | empty | Region fallback. |
| `AWS_DEFAULT_REGION` | empty | Region fallback. |
| `AWS_BEARER_TOKEN_BEDROCK` | empty | Bedrock API key auth. |
| `BEDROCK_AWS_ACCESS_KEY_ID` | empty | Access key. |
| `BEDROCK_AWS_SECRET_ACCESS_KEY` | empty | Secret key. |
| `BEDROCK_AWS_SESSION_TOKEN` | empty | Session token. |
| `DEVSYNC_BEDROCK_APPLICATION_INFERENCE_PROFILE` | empty | Application inference profile. |
| `BEDROCK_APPLICATION_INFERENCE_PROFILE` | empty | Profile alias. |

## Git

| Variable | Default | Use |
| --- | --- | --- |
| `DEVSYNC_VAULT_REPO_URL` | empty | Vault remote repository. |
| `DEVSYNC_GIT_USERNAME` | `oauth2` | Username for HTTP Git auth. |
| `DEVSYNC_GIT_TOKEN` | empty | Git token. |
| `DEVSYNC_GIT_COMMIT_NAME` | `Devsync` | Commit author name. |
| `DEVSYNC_GIT_COMMIT_EMAIL` | `devsync@example.invalid` | Commit author email. |
| `DEVSYNC_GIT_TIMEOUT_MS` | `120000` | Git command timeout. |
| `DEVSYNC_GIT_MAX_BUFFER` | `1048576` | Git stdout/stderr buffer. |

## SES

| Variable | Default | Use |
| --- | --- | --- |
| `DEVSYNC_SES_REGION` | empty | SES region. |
| `DEVSYNC_SES_ACCESS_KEY_ID` | empty | SES access key. |
| `DEVSYNC_SES_SECRET_ACCESS_KEY` | empty | SES secret key. |
| `DEVSYNC_SES_SESSION_TOKEN` | empty | SES session token. |
| `DEVSYNC_SES_FROM_EMAIL` | empty | Sender. |
| `DEVSYNC_SES_CONFIGURATION_SET` | empty | SES configuration set. |
| `AWS_SES_FROM_EMAIL` | empty | Sender alias. |
| `SES_FROM_EMAIL` | empty | Sender alias. |
| `AWS_SES_CONFIGURATION_SET` | empty | Configuration set alias. |

## Frontend Build

| Variable | Default | Use |
| --- | --- | --- |
| `VITE_DEVSYNC_PROJECT_STATUSES` | empty | Comma-separated custom project status list. |
