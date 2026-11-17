// You may edit this file, add new files to support this file,
// and/or add new dependencies to the project as you see fit.
// However, you must not change the surface API presented from this file,
// and you should not need to change any other files in the project to complete the challenge

import { useCallback, useEffect, useSyncExternalStore } from 'react';

type UseCachingFetch = (url: string) => {
  isLoading: boolean;
  data: unknown;
  error: Error | null;
};

// ---------------------------------------------------------------------------
// Cache store
// ---------------------------------------------------------------------------

type CacheEntry =
  | { status: 'loading'; promise: Promise<void> }
  | { status: 'success'; data: unknown }
  | { status: 'error'; error: Error };

/** Module-level cache, keyed by URL. Entries are replaced (never mutated) so
 * they can be used directly as `useSyncExternalStore` snapshots. */
const cache = new Map<string, CacheEntry>();

/** Subscribers per URL, notified whenever that URL's entry changes. */
const listeners = new Map<string, Set<() => void>>();

const notify = (url: string): void => {
  listeners.get(url)?.forEach((listener) => listener());
};

const setEntry = (url: string, entry: CacheEntry): void => {
  cache.set(url, entry);
  notify(url);
};

const subscribeToUrl = (url: string, listener: () => void): (() => void) => {
  let set = listeners.get(url);
  if (!set) {
    set = new Set();
    listeners.set(url, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(url);
  };
};

const toError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value));

/**
 * Starts a fetch for `url` unless an entry already exists. Concurrent callers
 * share the same in-flight promise, so N consumers produce exactly 1 request.
 * The returned promise never rejects; failures are stored as error entries.
 */
const fetchIntoCache = (url: string): Promise<void> => {
  const existing = cache.get(url);
  if (existing) {
    return existing.status === 'loading' ? existing.promise : Promise.resolve();
  }

  // `Promise.resolve().then(...)` defers the fetch by a microtask, so the
  // loading entry below is always in place before any result is written,
  // even if `fetch` throws synchronously.
  const promise = Promise.resolve()
    .then(() => fetch(url))
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(
          `Request to ${url} failed with status ${response.status}${
            response.statusText ? ` ${response.statusText}` : ''
          }`,
        );
      }
      return (await response.json()) as unknown;
    })
    .then(
      (data): CacheEntry => ({ status: 'success', data }),
      (error: unknown): CacheEntry => ({
        status: 'error',
        error: toError(error),
      }),
    )
    .then((result) => {
      // Ignore results for entries that were wiped/replaced while in flight.
      if (cache.get(url) === loadingEntry) setEntry(url, result);
    });

  const loadingEntry: CacheEntry = { status: 'loading', promise };
  setEntry(url, loadingEntry);
  return promise;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * 1. Implement a caching fetch hook. The hook should return an object with the following properties:
 * - isLoading: a boolean that is true when the fetch is in progress and false otherwise
 * - data: the data returned from the fetch, or null if the fetch has not completed
 * - error: an error object if the fetch fails, or null if the fetch is successful
 *
 * This hook is called three times on the client:
 *  - 1 in App.tsx
 *  - 2 in Person.tsx
 *  - 3 in Name.tsx
 *
 * Acceptance Criteria:
 * 1. The application at /appWithoutSSRData should properly render, with JavaScript enabled, you should see a list of people.
 * 2. You should only see 1 network request in the browser's network tab when visiting the /appWithoutSSRData route.
 * 3. You have not changed any code outside of this file to achieve this.
 * 4. This file passes a type-check.
 *
 */
export const useCachingFetch: UseCachingFetch = (url) => {
  const subscribe = useCallback(
    (listener: () => void) => subscribeToUrl(url, listener),
    [url],
  );
  const getSnapshot = useCallback(() => cache.get(url), [url]);

  // The same getter is used for the server snapshot, so the server render and
  // the hydrating client render see the same state (empty cache -> loading,
  // preloaded/initialized cache -> data).
  const entry = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // Fetching is a side effect, so it is started after commit, never during
  // render. `entry` is a dependency so a wiped cache triggers a refetch;
  // fetchIntoCache is a no-op while an entry exists.
  useEffect(() => {
    void fetchIntoCache(url);
  }, [url, entry]);

  if (!entry || entry.status === 'loading') {
    return { isLoading: true, data: null, error: null };
  }
  if (entry.status === 'error') {
    return { isLoading: false, data: null, error: entry.error };
  }
  return { isLoading: false, data: entry.data, error: null };
};

/**
 * 2. Implement a preloading caching fetch function. The function should fetch the data.
 *
 * This function will be called once on the server before any rendering occurs.
 *
 * Any subsequent call to useCachingFetch should result in the returned data being available immediately.
 * Meaning that the page should be completely serverside rendered on /appWithSSRData
 *
 * Acceptance Criteria:
 * 1. The application at /appWithSSRData should properly render, with JavaScript disabled, you should see a list of people.
 * 2. You have not changed any code outside of this file to achieve this.
 * 3. This file passes a type-check.
 *
 */
export const preloadCachingFetch = async (url: string): Promise<void> => {
  await fetchIntoCache(url);
};

/**
 * 3.1 Implement a serializeCache function that serializes the cache to a string.
 * 3.2 Implement an initializeCache function that initializes the cache from a serialized cache string.
 *
 * Together, these two functions will help the framework transfer your cache to the browser.
 *
 * The framework will call `serializeCache` on the server to serialize the cache to a string and inject it into the dom.
 * The framework will then call `initializeCache` on the browser with the serialized cache string to initialize the cache.
 *
 * Acceptance Criteria:
 * 1. The application at /appWithSSRData should properly render, with JavaScript enabled, you should see a list of people.
 * 2. You should not see any network calls to the people API when visiting the /appWithSSRData route.
 * 3. You have not changed any code outside of this file to achieve this.
 * 4. This file passes a type-check.
 *
 */
export const serializeCache = (): string => {
  const successful: Record<string, unknown> = {};
  cache.forEach((entry, url) => {
    if (entry.status === 'success') successful[url] = entry.data;
  });
  // The framework embeds this inside a single-quoted JS string in a <script>
  // tag. encodeURIComponent escapes <, >, ", \, newlines, etc. but leaves '
  // alone, so ' is encoded manually.
  return encodeURIComponent(JSON.stringify(successful)).replace(/'/g, '%27');
};

export const initializeCache = (serializedCache: string): void => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(serializedCache));
  } catch {
    // A corrupt payload is ignored; the hook will simply fetch on the client.
    return;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return;
  }
  for (const [url, data] of Object.entries(parsed)) {
    setEntry(url, { status: 'success', data });
  }
};

export const wipeCache = (): void => {
  const urls = [...cache.keys()];
  cache.clear();
  urls.forEach(notify);
};
