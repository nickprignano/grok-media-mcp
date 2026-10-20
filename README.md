# grok-media-mcp

A remote [MCP](https://modelcontextprotocol.io) server that lets Claude make images, short videos and speech with
xAI's Grok media models, with hard spend caps and a short list of things it refuses to make. It runs on one
Cloudflare Worker and only lets its owner in: you host your own copy with your own xAI key.

Claude stays the model you talk to. When a chat needs media, Claude calls these tools, looks at the preview, and
hands you the file.

## Tools

| Tool | What it does | Cost (xAI list price, 2026-10-19) |
|---|---|---|
| `make_image` | 1-4 images from a prompt, with small previews Claude can look at | $0.04 per image, $0.05 at `high` |
| `edit_image` | Edit or combine 1-5 images given by file id | Same |
| `make_video` | Start a 1-15 s video (480p or 720p); returns a job id | $0.02, $0.05 or $0.08 per second |
| `video_status` | Pending, done (with link), failed or expired | Free |
| `make_speech` | Read text aloud with one of xAI's built-in voices | $15 per million characters |
| `transcribe` | Transcribe an uploaded audio file | $0.10 per hour |
| `media_budget` | Armed or not, spend today, this month and this session, caps | Free |
| `list_media` | Recent files with fresh links | Free |

No chat, search, code execution or generic file upload: only media.

## How it keeps you safe

**Only you get in.** claude.ai connects with OAuth. The Worker is the authorization server, Cloudflare Access is
the login, and one email is allowed. Dynamic client registration is off: only Claude's published client identity
and its exact redirect URI are accepted, and the consent page is shown every time with a warning to allow it only
right after you clicked Connect yourself. The Access ID token is checked for signature, issuer, audience, expiry,
not-before and email. Access tokens last an hour and refresh tokens 30 days, rotating on use.

**Nothing spends until you arm it.** Paid tools refuse unless you have armed the server on its `/inbox` page, which
lasts two hours and asks you to confirm the work is not for children. Reading tools always work.

**Hard caps, kept exactly.** One Durable Object holds the ledger, so caps hold however many chats call at once.
Defaults: $1.50 per call, $3 per arming session, $5 a day, $25 a month, 6 calls a minute. Each call reserves its
quoted cost first and settles to xAI's reported cost after. A repeat of the same request within 10 minutes returns
the earlier result for free. Your prepaid xAI balance with auto top-up off is the last cap that no bug can pass.

**Content rules.** Before any call to xAI, prompts are checked for children and teens, ages under 18, names on your
private family list, sexual content, gore, weapon instructions, logos and trademarked characters, and real people.
It is a word-and-pattern tripwire, not a classifier: Claude's judgment and xAI's moderation come first, and you look
at anything before it goes public. **Never use this for anything a child or teen uses.**

**Only your files go to xAI.** Tool inputs are file ids, never URLs or raw data: files the server made, or ones you
uploaded on `/inbox`. Uploaded images are decoded and re-encoded, which removes location and camera data.

**Files stay private.** Media lives in your R2 bucket for 30 days. Links are HMAC-signed, last an hour (previews 15
minutes), always download as attachments, and are served with `nosniff` and a sandboxing CSP. Only image, video and
audio types are served. xAI's own temporary URLs are never returned.

**Nothing sensitive in logs.** Workers Logs get the tool, status and cost, never prompts, arguments, tokens, the
key or xAI's error bodies.

## Host your own copy

You need a Cloudflare account with a domain on it and an xAI account. Everything personal (your hostname, your
email, your family-name list and every key) is set in the Cloudflare dashboard, never in this repo.

Generate secrets on your own machine and paste them straight into the dashboard. Never paste a key into a chat.

### 1. xAI

1. Make a separate xAI team for this server.
2. Use prepaid credits only. Leave the invoiced limit at $0 and turn auto top-up off (or cap it low).
3. Make an API key limited to the media models (image, video, speech) with a low requests-per-minute limit.

### 2. Cloudflare Access (Zero Trust)

1. **Login method:** Google or GitHub, with two-factor sign-in turned on at that provider.
2. **OIDC app for the connector login:** Access > Applications > Add an application > SaaS > OIDC.
   Redirect URL `https://<your-host>/callback`, scopes `openid email profile`, PKCE on. Policy: Allow, Include,
   Emails, your one address. Session duration 24 hours. Note the **Client ID**, **Client secret** and **Issuer**.
3. **Self-hosted app for the inbox:** Access > Applications > Add an application > Self-hosted.
   Domain `<your-host>`, path `inbox`. The same one-email policy and 24-hour session. Under cookie settings keep
   SameSite Lax and HttpOnly on. Note the **Application Audience (AUD) tag**.

### 3. The Worker

1. Workers & Pages > Create > Import a repository, pick your copy of this repo. Production branch `main`; turn
   builds for other branches off. The first deploy creates the KV namespace and R2 bucket for you.
2. Worker > Settings > Domains & Routes > Add > Custom domain: `<your-host>`. The `workers.dev` address and preview
   URLs are off in `wrangler.jsonc`, and the Worker refuses any other host.
3. Worker > Settings > Variables and Secrets. Add each of these as type **Secret**:

| Secret | Value |
|---|---|
| `PUBLIC_URL` | `https://<your-host>` (no trailing slash) |
| `ALLOWED_EMAIL` | The one email allowed in |
| `FAMILY_NAMES` | Names the server must refuse, comma-separated (can be empty) |
| `XAI_API_KEY` | The media-only xAI key |
| `ACCESS_CLIENT_ID` | From the OIDC app |
| `ACCESS_CLIENT_SECRET` | From the OIDC app |
| `ACCESS_ISSUER` | From the OIDC app, for example `https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client-id>` |
| `INBOX_ACCESS_AUD` | The AUD tag of the self-hosted inbox app |
| `COOKIE_ENCRYPTION_KEY` | 32+ random characters, for example `openssl rand -base64 48` |
| `LINK_SIGNING_KEY` | 32+ random characters, different from the one above |

Until every required secret is set, the Worker answers 503 to everything.

4. R2 > your bucket > Settings: keep public access off and the `r2.dev` URL disabled, and add an object lifecycle
   rule that deletes objects after 30 days. (The Worker also deletes them itself; the rule is the backstop.)
5. Security > WAF:
   - A custom rule that blocks requests to your host for `/mcp` and `/token` unless they come from Anthropic's
     published egress range (`160.79.104.0/21` when this was written; check Claude's connector docs).
   - A rate-limiting rule on `/f/`, `/authorize`, `/token` and `/callback`, for example 30 requests a minute per IP.
6. Set a Cloudflare billing notification.

### 4. Connect Claude

1. Check discovery first: `https://<your-host>/.well-known/oauth-protected-resource/mcp` and
   `https://<your-host>/.well-known/oauth-authorization-server` should load, and the second should show
   `"client_id_metadata_document_supported": true` and no `registration_endpoint`.
2. In claude.ai: Settings > Connectors > Add custom connector, URL `https://<your-host>/mcp`. Sign in with Access and
   allow on the consent page. Never allow a consent page you didn't just open from claude.ai.
3. When claude.ai asks about tool permissions, choose "always allow" only for `media_budget`, `video_status` and
   `list_media`.
4. Where claude.ai lets you, turn the connector off in projects where it must never be used (anything for kids, work projects), and say so
   in those projects' instructions.
5. Open `https://<your-host>/inbox`, arm the server, and ask Claude for a test image.

### Rotating secrets

| Secret | How |
|---|---|
| `XAI_API_KEY` | Make a new key in xAI, replace the secret, then delete the old key |
| `ACCESS_CLIENT_SECRET` | Regenerate in the OIDC app, then replace the secret |
| `COOKIE_ENCRYPTION_KEY` | Replace; open inbox forms stop working until reloaded |
| `LINK_SIGNING_KEY` | Replace; existing links stop working (`list_media` makes new ones) |
| All connector sessions | Clear the `OAUTH_KV` namespace; Claude asks you to sign in again |

### Settings you can change

`CAP_PER_CALL_USD`, `CAP_PER_SESSION_USD`, `CAP_PER_DAY_USD`, `CAP_PER_MONTH_USD`, `CALLS_PER_MINUTE` and
`ARM_HOURS` are in `wrangler.jsonc`. Model ids and prices are in `src/config.ts`; `media_budget` warns when the
price table is more than 90 days old.

## Development

```sh
npm ci
npm run typecheck
npm test          # runs in workerd with xAI and Access mocked: no account, no spend
```

Dependencies are pinned exactly. Update them through Dependabot PRs reviewed by hand.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
