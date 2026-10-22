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

## How to make a change

Four rules after the community "Karpathy guidelines" (MIT), reworded for agents that work unattended.

- Say what you assumed. When the ask leaves a detail open, pick the reasonable default, say which,
  and keep going. Stop to ask only when the choice changes the goal, something the owner will
  notice, or a step no one can undo; if no one is there to answer, do the reversible part and leave
  the question in the PR body. If a simpler way exists than the one asked for, say so.
- Write the least code that does the job: no features, options or abstractions nobody asked for,
  and no handling for cases that can't happen.
- Touch only what the task needs and match the style around it. Every changed line should trace
  back to the ask. Mention unrelated dead code instead of deleting it; remove only what your own
  change left unused.
- Before you start, name the check that proves the task is done (a failing test, the "Checks to
  run" below, an expected output), and don't call it done until it passes in front of you.

## Checks to run

```bash
npm run typecheck
npm test
npm run test:local
```
