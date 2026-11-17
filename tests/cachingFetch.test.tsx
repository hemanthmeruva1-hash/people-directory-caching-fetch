import { act, cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../application/App';
import {
  initializeCache,
  preloadCachingFetch,
  serializeCache,
  useCachingFetch,
  wipeCache,
} from '../caching-fetch-library/cachingFetch';

// The URL hard-coded in the application components.
const APP_URL =
  'https://randomapi.com/api/6de6abfedb24f889e0b5f675edc50deb?fmt=raw&sole&seed=123';

const people = [
  {
    first: 'Ada',
    last: 'Lovelace',
    email: 'ada@example.com',
    address: '1 Analytical Way',
    created: 'December 10, 2015',
    balance: '$1,815.00',
  },
  {
    first: 'Alan',
    last: 'Turing',
    email: 'alan@example.com',
    address: '2 Bletchley Park',
    created: 'June 23, 2012',
    balance: '$1,912.00',
  },
];

const jsonResponse = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    ...init,
  });

const mockFetch = (impl: () => Promise<Response>) => {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

/** A test probe that renders the raw hook state. */
const Probe = ({ url }: { url: string }) => {
  const { isLoading, data, error } = useCachingFetch(url);
  if (isLoading) return <p>loading</p>;
  if (error) return <p>error: {error.message}</p>;
  return <p>data: {JSON.stringify(data)}</p>;
};

beforeEach(() => {
  wipeCache();
});

afterEach(() => {
  cleanup();
  wipeCache();
});

describe('useCachingFetch', () => {
  it('makes exactly one request for the three consumers in the app', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(people));

    render(<App />);
    expect(screen.getByText('Loading...')).toBeTruthy();

    expect(await screen.findByText('Ada Lovelace')).toBeTruthy();
    expect(screen.getByText('Alan Turing')).toBeTruthy();
    expect(screen.getByText('alan@example.com')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(APP_URL);
  });

  it('shares one in-flight request between sibling consumers', async () => {
    const fetchMock = mockFetch(async () => jsonResponse({ ok: 1 }));

    render(
      <>
        <Probe url="/a" />
        <Probe url="/a" />
        <Probe url="/a" />
      </>,
    );

    expect(await screen.findAllByText('data: {"ok":1}')).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a non-OK HTTP status as an error', async () => {
    mockFetch(async () =>
      jsonResponse(
        { message: 'nope' },
        { status: 500, statusText: 'Server Error' },
      ),
    );

    render(<Probe url="/broken" />);

    expect(
      await screen.findByText(
        'error: Request to /broken failed with status 500 Server Error',
      ),
    ).toBeTruthy();
  });

  it('surfaces a rejected fetch as an error', async () => {
    mockFetch(async () => {
      throw new TypeError('Failed to fetch');
    });

    render(<Probe url="/offline" />);

    expect(await screen.findByText('error: Failed to fetch')).toBeTruthy();
  });

  it('refetches after the cache is wiped', async () => {
    const fetchMock = mockFetch(async () => jsonResponse('value'));

    render(<Probe url="/w" />);
    await screen.findByText('data: "value"');

    act(() => wipeCache());
    await screen.findByText('data: "value"');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('preloadCachingFetch', () => {
  it('makes preloaded data available on the first render without refetching', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(people));

    await preloadCachingFetch(APP_URL);
    render(<App />);

    // Synchronous query: no loading state, data is there immediately.
    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
    expect(screen.queryByText('Loading...')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('server renders the full page after preloading', async () => {
    mockFetch(async () => jsonResponse(people));

    await preloadCachingFetch(APP_URL);
    const html = renderToString(<App />);

    expect(html).toContain('Lovelace');
    expect(html).toContain('alan@example.com');
    expect(html).not.toContain('Loading...');
  });

  it('shares the in-flight request with concurrent preloads', async () => {
    const fetchMock = mockFetch(async () => jsonResponse([]));

    await Promise.all([preloadCachingFetch('/p'), preloadCachingFetch('/p')]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('serializeCache / initializeCache', () => {
  const tricky = {
    quote: "it's",
    double: 'say "hi"',
    script: '</script><script>alert(1)</script>',
    amp: 'a & b',
    percent: '100% %27 %',
    backslash: 'C:\\path\\n',
    unicode: 'café \u2028 😀',
  };

  it('round-trips data with characters that are unsafe in HTML or JS strings', async () => {
    mockFetch(async () => jsonResponse(tricky));
    await preloadCachingFetch('/tricky');

    const serialized = serializeCache();

    // Safe to embed in a single-quoted JS string inside a <script> tag.
    expect(serialized).not.toMatch(/['"<>\\&\s]/);

    wipeCache();
    const fetchMock = mockFetch(async () => jsonResponse('should not fetch'));
    initializeCache(serialized);

    // Compare raw textContent: getByText would normalize the line-separator char.
    const { container } = render(<Probe url="/tricky" />);
    expect(container.textContent).toBe(`data: ${JSON.stringify(tricky)}`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('survives being embedded in a single-quoted script string', async () => {
    mockFetch(async () => jsonResponse(tricky));
    await preloadCachingFetch('/tricky');

    // Mirrors the string interpolation in framework/server/buildHtmlDoc.ts.
    const scriptSource = `window.__TEST_DATA__ = '${serializeCache()}'`;
    const evaluated = new Function(
      'window',
      `${scriptSource}; return window.__TEST_DATA__;`,
    )({}) as string;

    wipeCache();
    initializeCache(evaluated);
    expect(JSON.parse(decodeURIComponent(serializeCache()))).toEqual({
      '/tricky': tricky,
    });
  });

  it('only serializes successful entries', async () => {
    mockFetch(async () => jsonResponse('ok'));
    await preloadCachingFetch('/ok');
    mockFetch(async () => jsonResponse(null, { status: 404 }));
    await preloadCachingFetch('/missing');

    expect(JSON.parse(decodeURIComponent(serializeCache()))).toEqual({
      '/ok': 'ok',
    });
  });

  it.each([
    ['malformed URI encoding', '%E0%A4%A'],
    ['invalid JSON', encodeURIComponent('{not json')],
    ['a non-object payload', encodeURIComponent('[1,2,3]')],
    ['null', encodeURIComponent('null')],
  ])('ignores a corrupt payload (%s)', (_label, payload) => {
    expect(() => initializeCache(payload)).not.toThrow();
    expect(serializeCache()).toBe(encodeURIComponent('{}'));
  });
});
