# grok-media-mcp

An [MCP](https://modelcontextprotocol.io) server that lets Claude make images, short videos and speech with xAI's
Grok media models, with hard spend caps and a short list of things it refuses to make. You run your own copy with
your own xAI key, one of two ways:

- **On Cloudflare**, as a remote connector for claude.ai (web, desktop and mobile). It only lets its owner in.
  See [Host your own copy](#host-your-own-copy).
- **On your own computer**, for Claude Desktop and Claude Code on Windows, macOS or Linux. No Cloudflare account,
  no domain. See [Run it on your own computer](#run-it-on-your-own-computer).

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
| `list_media` | Recent files with fresh links (or paths, when run locally) | Free |

No chat, search, code execution or generic file upload: only media.

## How it keeps you safe

This section describes the Cloudflare version. Local mode keeps the same caps, content rules and arming, with the
differences listed under [What's different locally](#whats-different-locally).

**Only you get in.** claude.ai connects with OAuth. The Worker is the authorization server, Cloudflare Access is
the login, and one email is allowed. Dynamic client registration is off: only Claude's published client identity
and its exact redirect URI are accepted, and the consent page is shown every time with a warning to allow it only
right after you clicked Connect yourself. A sign-in opened from any site other than claude.ai is refused. The Access ID token is checked for signature, issuer, audience, expiry,
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
     Don't skip it: every visit to `/authorize` writes to KV, and the free KV write allowance is what keeps your
     sign-ins refreshing.
6. Set a Cloudflare billing notification. The Images binding (previews and inbox re-encoding) has a free monthly
   allowance of unique transformations; normal use stays well inside it.

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

## Run it on your own computer

Local mode is the same tools as a program Claude Desktop or Claude Code starts on your computer. It talks to Claude
over stdio (nothing listens on the network), keeps its ledger in a SQLite file and saves media in your user data
folder.

### 1. Install

You need [Node.js](https://nodejs.org) 24 LTS (22.13 or newer works).

- **From a release:** on this repository's Releases page, copy the link to the `.tgz` file of the latest release
  and check its SHA-256 against the one in the release notes, then run
  `npm install -g --ignore-scripts <link to the .tgz>`.
- **From a clone:** `npm ci`, then `npm run build:local`. The program is `dist/grok-media-mcp.mjs`.

It is not published on npm. A package called `grok-media-mcp` on npm is not this project.

Find the full path of the program, which the next steps use:

| | Command | Program path |
|---|---|---|
| Release install | `npm root -g` | `<that folder>/grok-media-mcp/dist/grok-media-mcp.mjs` |
| Clone | | `<your clone>/dist/grok-media-mcp.mjs` |

Also note the full path of Node itself: `where node` on Windows, `which node` on macOS and Linux.

### 2. Your xAI key

Make a separate xAI team and key as in [Host your own copy](#1-xai) step 1 (prepaid, auto top-up off, media models
only). If you also run the Cloudflare version, give this copy its own key, so each one's spend shows separately.

In a terminal, run `node <program path> set-key` (or `grok-media-mcp set-key` after a release install) and paste
the key at the prompt. Nothing shows while you paste. It is saved in Windows Credential Manager or the macOS
Keychain (on Linux, in a file only your account can read). macOS may ask whether Node can use the Keychain: choose
Always Allow. Never put the key in a chat, and avoid putting it in Claude's config files, which are plain text.

### 3. Connect Claude

**Claude Desktop:** Settings > Developer > Edit Config, and add this to `claude_desktop_config.json` with your two
full paths (on Windows, write each `\` in a path as `\\`). Then restart Claude Desktop.

```json
{
  "mcpServers": {
    "grok-media": {
      "command": "/full/path/to/node",
      "args": ["/full/path/to/grok-media-mcp.mjs"]
    }
  }
}
```

**Claude Code:** `claude mcp add --scope user grok-media -- /full/path/to/node /full/path/to/grok-media-mcp.mjs`

Leave the paid tools on "ask before using"; only `media_budget`, `video_status` and `list_media` are worth always
allowing.

### 4. Use it

| Command (in a terminal) | What it does |
|---|---|
| `grok-media-mcp arm blog` | Allows paid calls for 2 hours (purpose: `blog`, `personal` or `testing`). Asks you to confirm the work isn't for kids |
| `grok-media-mcp disarm` | Stops paid calls now |
| `grok-media-mcp status` | Armed or not, spend against each cap, where the key and files are |
| `grok-media-mcp add photo.jpg` | Adds your own JPEG or PNG image, or an audio file, as a tool input and prints its file id |
| `grok-media-mcp where` | Prints the data folder |

Without a release install, use `node <program path>` in place of `grok-media-mcp`.

The data folder is `%APPDATA%\grok-media-mcp` on Windows, `~/Library/Application Support/grok-media-mcp` on macOS and
`~/.local/share/grok-media-mcp` on Linux. Its `config.json` holds the caps and your private family-name list.

### What's different locally

- **No login.** Only programs running as you can start it. That keeps other people out, not malware on your own
  account.
- **Arming happens in a terminal.** `arm` and `add` refuse to run unless a person is typing in a terminal, so Claude
  can't arm the server or feed it a file through a script by accident. A program that imitates a terminal could get
  past that check: the caps and your prepaid balance are the limits that hold.
- **The ledger is a file you own.** Desktop and Code share it, and every reservation takes the file's write lock, so
  caps hold across both. But deleting the file resets the caps, and setting the clock back is refused only while
  the ledger remembers a later call (moving it forward past midnight UTC does reopen the day cap; the session
  and month caps still hold). Treat the local caps as a brake against runaway use; the prepaid xAI balance
  with auto top-up off is the hard limit.
- **Caps in `config.json` can only go lower** than the built-in ones. Raising them means changing `src/config.ts`
  and rebuilding.
- **Files stay on your computer** for 30 days. Tool results give their paths, which include your user name.
- **Images you add are decoded and re-encoded** as a plain JPEG in JavaScript, which drops location and camera
  data, colour profiles and anything appended to the file. WebP and other formats: export them as JPEG first.
  Audio is copied as it is.
- **Logs** go to Claude's MCP log (stderr): the tool, status and cost, never prompts or the key.

## Development

```sh
npm ci
npm run typecheck
npm test              # the Worker, in workerd with xAI and Access mocked: no account, no spend
npm run build:local   # bundles local mode into dist/grok-media-mcp.mjs
npm run test:local    # local mode in Node, with xAI mocked and a temporary data folder
```

The ledger (`src/ledger.ts`), the tools (`src/tools.ts`), the xAI client and the content rules are shared by both
versions. `src/worker-backend.ts` and `src/local/backend.ts` supply each one's storage.

Dependencies are pinned exactly. Update them through Dependabot PRs reviewed by hand.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
