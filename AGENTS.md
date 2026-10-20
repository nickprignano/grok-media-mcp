# Instructions for AI assistants

- Nothing personal in this repo: no hostnames, emails, names, account or resource ids, or keys. Those are
  Worker secrets set in the Cloudflare dashboard (README, "Host your own copy").
- Never ask for, show or store a secret in chat.
- Keep the safety design in README "How it keeps you safe" true. A change that weakens the login checks, the caps,
  the arming gate, the content rules or the file headers needs the owner's explicit yes.
- Pin dependencies exactly. Run `npm run typecheck` and `npm test` before pushing; tests must never call real
  xAI or Cloudflare accounts.
