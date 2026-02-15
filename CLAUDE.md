Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Prefer `Bun.spawn` for subprocesses over `child_process`
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Build & Verify

```bash
bun install
bunx tsc --noEmit                                           # Type check
bun build src/cli.ts --target=bun > /dev/null && echo "OK"  # Bundle check
```

## Project Conventions

This is a **CLI tool** (not a web app). There is no frontend, no HTTP server, no React.

- `src/cli.ts` is the main entry point — it contains the full bridge logic
- `src/imessage/database.ts` reads `~/Library/Messages/chat.db` read-only via `bun:sqlite`
- `src/imessage/sender.ts` sends iMessages via JXA/AppleScript using temp files
- `src/index.ts` exports the public library API
- Never embed user-controlled content in AppleScript/JXA strings — always write to temp files
- Use parameterized SQL queries (`?1`, `?2`) — never string interpolation
- The TUI uses an erase-and-redraw pattern — not scroll regions or cursor save/restore
- `console.log`/`console.error` are overridden to route through `writePermanent()`
- Slash commands go in `handleSlashCommand()` and return a `CommandResult`
- Add new commands to both the `switch` in `handleSlashCommand()` and `HELP_TEXT`
