# Development

Install from source:

```bash
git clone https://github.com/CHATS-lab/BackUpper.git && cd BackUpper
npm ci && npm link              # npm ci also builds dist/ (the prepare script)
```

Build and test:

```bash
npm ci                          # install and build dist/
npm test                        # build, unit tests, offline smoke test
npm run e2e                     # Docker: pack, install globally in Node 20, run the offline checks
npm run docs                    # regenerate the configuration table in src/config/README.md
```

`npm run e2e` builds an image from `test/e2e/Dockerfile` with the packed tarball installed globally, and runs the demo, hook-level checks, backup and restore, and the smoke suite inside it, with networking disabled and no host mounts. It makes no model calls. `BACKUPPER_E2E_REAL=1 npm run e2e` additionally drives one real `claude -p` session; it passes `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` from your environment, and mounts a credentials file read-only only when you name it in `BACKUPPER_E2E_CLAUDE_CREDENTIALS`.

The prompts sent to models are markdown files in `prompts/`; `npm run build` compiles them into `src/prompts.generated.ts`.
