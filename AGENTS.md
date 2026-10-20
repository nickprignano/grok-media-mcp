# Instructions for AI assistants

- Nothing personal in this repo: no hostnames, emails, names, account or resource ids, or keys. Those are
  Worker secrets set in the Cloudflare dashboard (README, "Host your own copy").
- Never ask for, show or store a secret in chat.
- Keep the safety design in README "How it keeps you safe" true. A change that weakens the login checks, the caps,
  the arming gate, the content rules or the file headers needs the owner's explicit yes.
- Local mode (`src/local/`) has the same rules: its caps can only be lowered by config, `arm` and `add` need a
  terminal, the key lives only in the OS credential store or the owner-only key file, and nothing but the MCP
  protocol is written to stdout.
- Pin dependencies exactly. Run `npm run typecheck`, `npm test` and `npm run test:local` before pushing; tests must
  never call real xAI or Cloudflare accounts, or touch the real credential store.
