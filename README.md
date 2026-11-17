# People Directory

A small server-rendered React application made of three parts:

| Directory                | What it is                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `framework/`             | Fastify server, client hydration runtime and an MSW mock server (provided, unchanged)           |
| `application/`           | The People Directory React app (provided, unchanged)                                            |
| `caching-fetch-library/` | `useCachingFetch`, `preloadCachingFetch` and cache (de)serialization: the part implemented here |

## Getting started

Requirements: Node.js 22 (see `.nvmrc`; `nvm use` picks it up) and npm.

```bash
npm ci        # install exactly what package-lock.json specifies
npm start     # production build, then start the server
```

Open <http://localhost:3000>. The server listens on `localhost`, which on some machines resolves to IPv6 `[::1]` only, so use `localhost` rather than `127.0.0.1` if a page doesn't load.

- `/appWithoutSSRData`: the server renders a loading state and the browser fetches the data (exactly **one** network request, even though three components use the hook).
- `/appWithSSRData`: the server preloads the data and renders the full list (works with JavaScript disabled). The cache is handed to the browser, so it makes **no** request to the people API.

All network traffic to the people API is intercepted by MSW, both in Node and in the browser (service worker), so the project runs offline.

## Scripts

| Script                 | What it does                                                                   |
| ---------------------- | ------------------------------------------------------------------------------ |
| `npm start`            | `npm run build`, then `node dist/server.js`                                    |
| `npm run build`        | Production bundles via `scripts/build.mjs`: `dist/server.js`, `dist/client.js` |
| `npm run typecheck`    | `tsc` type-check of the whole project (no emit)                                |
| `npm run lint`         | ESLint                                                                         |
| `npm run lint:fix`     | ESLint with auto-fix                                                           |
| `npm run format`       | Prettier, writes changes                                                       |
| `npm run format:check` | Prettier, fails if anything is unformatted (used in CI)                        |
| `npm test`             | Vitest, single run                                                             |
| `npm run test:watch`   | Vitest in watch mode                                                           |

## Tooling and why

**Build: esbuild via `scripts/build.mjs`.** The original scripts chained `rm -rf`, `mkdir` and `cp`, which fail in Windows `cmd`/PowerShell. They also pointed at `framework/server/index.js` and `framework/client/index.js`, which don't exist. The build is now a small Node script that uses `node:fs` for the file operations and the esbuild JS API for bundling, with the real entry points `framework/server/index.ts` and `framework/client/index.tsx`. It runs the same way on every OS. Both bundles are minified, emit source maps and set `process.env.NODE_ENV` to `"production"`, so the client gets React's production build. esbuild was upgraded from 0.21 to 0.28 because the Vite version Vitest uses requires esbuild 0.27 or later.

**TypeScript (`typecheck`).** esbuild strips types without checking them, so `tsc` runs separately. `tsconfig.json` uses `strict` and `noEmit` (esbuild does the emitting). `lib` includes `DOM` because the code runs in both Node and the browser. `jsx` is `react`, which matches the `import React` style of the existing code. `moduleResolution` is `Bundler`, which matches how esbuild resolves imports (including `msw/node`/`msw/browser` subpath exports). An explicit `include` list keeps `dist/` and config files out.

**ESLint 9 (flat config).** `eslint.config.mjs` combines `@eslint/js` recommended, `typescript-eslint` recommended, `eslint-plugin-react` and `eslint-plugin-react-hooks`. The hooks rules matter most here because the library is built on hooks. `eslint-config-prettier` comes last so ESLint never argues with the formatter.

**Prettier.** Prettier handles formatting so that ESLint only reports real problems. The config (`singleQuote`, `trailingComma: "all"`) matches the existing code style.

**Provided code is excluded from linting and formatting.** `application/`, `framework/` and `DevTask.md` are ignored by both ESLint and Prettier (`.prettierignore`). The challenge says not to modify them, and a formatter or `--fix` run must not rewrite them by accident. They are still **type-checked** and **tested**.

**Vitest, jsdom and Testing Library.** Vitest reads TypeScript/JSX with no extra setup and has a Jest-compatible API. jsdom supplies the DOM, and `@testing-library/react` renders components the way a user sees them. The tests in `tests/cachingFetch.test.tsx` cover:

- the real `<App />` (three hook call sites) makes exactly **one** fetch
- sibling consumers and concurrent preloads share one in-flight request
- a non-OK HTTP status and a rejected `fetch` both surface as `error`
- preloaded data renders on the first render with no loading state and no refetch, and `renderToString` produces the full page
- `serializeCache` → `initializeCache` round trip with `'`, `"`, `</script>`, `&`, `%`, `\`, U+2028 and emoji, including evaluating the output inside a single-quoted JS string exactly as `buildHtmlDoc` embeds it
- only successful entries are serialized, and corrupt payloads are ignored without throwing

**Repository hygiene.**

- `.gitattributes` (`* text=auto eol=lf`) and `.editorconfig` keep line endings and whitespace consistent between Windows and Unix machines.
- `.nvmrc` and `engines` in `package.json` pin Node 22.
- `"private": true` stops the package from being published by accident.

**`package.json` clean-ups.**

- Removed the `msw.workerDirectory` block. It made msw's `postinstall` generate a `mockServiceWorker.js` on every install. The framework serves its own copy from `framework/mock-server/`, which must not change.
- Removed the misleading `"main": "index.js"`.
- Made `npm test` run Vitest.

**CI (`.github/workflows/ci.yml`).** On every push to `main` and on pull requests, CI runs `npm ci` → `typecheck` → `lint` → `format:check` → `test` → `build`, using the Node version from `.nvmrc`.

## How the caching library works

`caching-fetch-library/cachingFetch.ts` keeps a **module-level `Map` keyed by URL**. Each entry is one of:

- `{ status: 'loading', promise }`
- `{ status: 'success', data }`
- `{ status: 'error', error }`

Each URL also has a set of listeners. An entry is never mutated, only replaced, so the entry object can serve directly as an immutable snapshot.

- **Request de-duplication.** `fetchIntoCache(url)` returns immediately if an entry exists. If that entry is `loading`, the caller receives the same in-flight promise, so any number of consumers produce one request. A non-OK HTTP status (`!response.ok`) and a rejected `fetch` are both stored as `error` entries; the shared promise itself never rejects. A result that arrives after its entry was wiped is discarded.
- **`useCachingFetch(url)`** reads the entry with `useSyncExternalStore`, which gives tear-free updates under concurrent rendering. It uses **the same getter for the server snapshot**, so the server render and the hydrating client render see the same state. With an empty cache both show the loading state. With a preloaded or initialized cache both show the data. The fetch starts in `useEffect`, never during render: render stays pure, and the server, which doesn't run effects, never fetches from the hook. The effect also depends on the entry, so wiping the cache while components are mounted triggers a refetch.
- **`preloadCachingFetch(url)`** awaits the same shared fetch, so a later `renderToString` finds the data already in the cache.
- **`serializeCache()`** takes only `success` entries and runs `JSON.stringify` → `encodeURIComponent` → replace `'` with `%27`. The framework interpolates the result into `window.__INITIAL_DATA__ = '…'` inside a `<script>` tag. `encodeURIComponent` escapes `<`, `>`, `"`, `\`, `&` and line terminators but **not** `'`, which would end the JS string, hence the manual replacement.
- **`initializeCache(str)`** reverses that inside `try/catch` and only accepts a plain object. A corrupt payload is ignored and the client falls back to fetching.
- **`wipeCache()`** clears the cache and notifies subscribers. The server calls it at the start of every request.

## Known issues / next steps

1. **The cache is shared across concurrent SSR requests.** It is module-level, and the server calls `wipeCache()` at the start of each request. If two requests overlap, one can wipe or serialize the other's data. That leaks data between users once the data is user-specific, and can drop the data an in-flight render was relying on. The fix is a cache per request, for example a cache instance supplied through React context, or `AsyncLocalStorage` on the server. That needs framework changes, which were out of scope.
2. **No expiry or invalidation.** Once a URL is cached, it stays cached until `wipeCache()`. In the browser that means for the lifetime of the page. Next steps: a TTL or stale-while-revalidate, an explicit `invalidate(url)`/`refetch()`, and size limits (LRU).
3. **No automatic retry.** A failed request stays an `error` entry. Every consumer of that URL shows the error until the cache is wiped, and there is no retry with backoff. Also, if preloading fails on the server, the server renders the error while the client starts empty and renders loading. React then reports a hydration mismatch, falls back to client rendering and refetches. It recovers, but noisily.
4. **URL-encoding grows the payload.** Measured on the real `/appWithSSRData` response: the JSON is **11,360 bytes**, and the encoded string is **18,278 bytes (1.61×)**. After gzip the difference is smaller (3,605 vs 3,919 bytes, about 9%). A leaner option is to emit raw JSON in a `<script type="application/json">` tag with only `<`, `>`, `&`, U+2028 and U+2029 escaped as `\uXXXX`. That requires changing the framework.
5. **The framework injects data by string interpolation.** `buildHtmlDoc` places `serializeCache()` output straight into a JS string literal, so the library must produce output that is safe in that position. A mistake there is an XSS. Passing the payload as JSON in a non-executable script tag (see 4) or through a vetted serializer would remove that coupling.
6. **Cache keys are the URL only.** The method, headers (auth, `Accept-Language`) and body are not part of the key, and the hook only supports `GET` with default options. Two requests to the same URL with different credentials would share an entry. Next step: accept `RequestInit` and derive a key from the relevant parts.
7. **The provided `mockServiceWorker.js` is older than the installed msw.** The file is version 2.3.1, while `msw` resolves to a newer 2.x. MSW can log a version mismatch warning in the browser console. It still works, but the worker should be regenerated (`npx msw init framework/mock-server`) once changing `framework/` is allowed. That is also why the `workerDirectory` block was removed instead of pointed at that folder.
8. **Data is validated on every render.** Each component calls `validateData(rawData)` (valibot) on every render, which re-parses the full list three times per row. The validated result should be memoized or cached next to the raw data, for example through an optional `select`/`validate` function in the hook. That needs application changes.
9. **The server listens on `localhost` only.** `fastify.listen({ port: 3000 })` binds to `localhost`, which can be IPv6 `[::1]` only. `127.0.0.1` (the address in `DevTask.md`) then fails, and the server is not reachable from a container. For deployment, the host and port should come from environment variables.
10. **`npm audit` reports vulnerabilities.** Three are in runtime dependencies: `fastify` and its router `find-my-way` (high), and `valibot` (moderate). The fixes are major upgrades (fastify 5, valibot 1.x) that touch `framework/` and `application/` code. The rest are in dev tooling (Vite/Vitest and typescript-eslint through `picomatch`/`tinyglobby`) and should clear with routine upgrades. These should be triaged and scheduled.
