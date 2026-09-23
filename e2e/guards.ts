// Listeners and checks for the production-CSP smoke test (00-build I4). Install them before the
// first navigation, then call `expectCleanRun` at the end of the flow.

import { readFileSync } from 'node:fs';
import { expect, type Page, type Response, type TestInfo } from '@playwright/test';

// The single source of truth for response headers (06 §5), shared with Terraform and the local
// server. Asserting against the file guards against drift between them.
export const siteHeaders = readSiteHeaders();

const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';
const CACHE_REVALIDATE = 'no-cache';

// connect-src 'none' allows none of these, so any such request is a bug even if the CSP blocks it.
const CONNECT_TYPES = new Set(['fetch', 'xhr', 'eventsource', 'websocket']);

interface CspViolation {
  directive: string;
  blockedURI: string;
  sourceFile: string;
  lineNumber: number;
  sample: string;
}

interface Guards {
  /** Every request, as "<resource type> <url>", attached to the report. */
  requests: string[];
  /** Cross-origin, non-HTTP, fetch, or XHR requests. */
  forbiddenRequests: string[];
  documentRequests: string[];
  consoleErrors: string[];
  pageErrors: string[];
  assetResponses: Response[];
}

function readSiteHeaders(): Record<string, string> {
  const file = new URL('../infra/site/headers.json', import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('infra/site/headers.json must be a JSON object of header names to values');
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') throw new Error(`headers.json: ${name} must be a string`);
    headers[name] = value;
  }
  return headers;
}

// Runs in the page before any app script and records every CSP violation on window, where
// `expectCleanRun` reads them. It is serialized, so it must not reference anything outside itself.
function recordCspViolations(): void {
  interface ViolationEvent {
    effectiveDirective: string;
    blockedURI: string;
    sourceFile: string;
    lineNumber: number;
    sample: string;
  }
  const scope = globalThis as unknown as {
    __cspViolations: CspViolation[];
    addEventListener(
      type: 'securitypolicyviolation',
      listener: (event: ViolationEvent) => void,
      capture: boolean,
    ): void;
  };
  scope.__cspViolations = [];
  scope.addEventListener(
    'securitypolicyviolation',
    (event) => {
      scope.__cspViolations.push({
        directive: event.effectiveDirective,
        blockedURI: event.blockedURI,
        sourceFile: event.sourceFile,
        lineNumber: event.lineNumber,
        sample: event.sample,
      });
    },
    true,
  );
}

// Runs inside each Web Worker. Violations there fire on the worker's global scope, which the page
// listener can't see, so they are reported as console errors (worker console messages reach the
// page's console listener). Best effort: Playwright attaches after the worker starts, so this
// misses violations in the worker's first synchronous run, but not those from later messages.
function reportWorkerCspViolations(): void {
  const scope = globalThis as unknown as {
    addEventListener(
      type: 'securitypolicyviolation',
      listener: (event: { effectiveDirective: string; blockedURI: string }) => void,
    ): void;
  };
  scope.addEventListener('securitypolicyviolation', (event) => {
    console.error(
      `CSP violation in worker: ${event.effectiveDirective} blocked ${event.blockedURI}`,
    );
  });
}

export async function installGuards(page: Page, baseURL: string): Promise<Guards> {
  const origin = new URL(baseURL).origin;
  const guards: Guards = {
    requests: [],
    forbiddenRequests: [],
    documentRequests: [],
    consoleErrors: [],
    pageErrors: [],
    assetResponses: [],
  };

  await page.addInitScript(recordCspViolations);

  page.on('worker', (worker) => {
    worker.evaluate(reportWorkerCspViolations).catch(() => {
      // The worker ended before the listener attached; nothing left to watch.
    });
  });

  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const { url, lineNumber } = message.location();
    guards.consoleErrors.push(url ? `${message.text()} (${url}:${lineNumber})` : message.text());
  });

  page.on('pageerror', (error) => {
    guards.pageErrors.push(`${error.name}: ${error.message}`);
  });

  // The context sees requests from the page and from its workers.
  const context = page.context();
  context.on('request', (request) => {
    const type = request.resourceType();
    const url = new URL(request.url());
    guards.requests.push(`${type} ${request.url()}`);
    if (type === 'document') guards.documentRequests.push(request.url());

    if (CONNECT_TYPES.has(type)) {
      guards.forbiddenRequests.push(`${type} request (connect-src 'none'): ${request.url()}`);
    }
    if (url.protocol === 'data:') {
      // img-src allows data: images; nothing else may use data: URLs.
      if (type !== 'image') guards.forbiddenRequests.push(`data: URL for ${type}`);
    } else if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      // blob: URLs report the page's origin, but no directive allows them.
      guards.forbiddenRequests.push(`${url.protocol} URL for ${type}: ${request.url()}`);
    } else if (url.origin !== origin) {
      guards.forbiddenRequests.push(`cross-origin ${type} request: ${request.url()}`);
    }
  });

  context.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin === origin && url.pathname.startsWith('/assets/') && response.status() === 200) {
      guards.assetResponses.push(response);
    }
  });

  return guards;
}

/** The document must carry every header in headers.json verbatim, and revalidate (06 §6). */
export async function expectDocumentHeaders(response: Response): Promise<void> {
  expect(response.status(), `status of ${response.url()}`).toBe(200);
  const headers = await response.allHeaders();
  for (const [name, value] of Object.entries(siteHeaders)) {
    expect.soft(headers[name.toLowerCase()], `${name} on ${response.url()}`).toBe(value);
  }
  expect
    .soft(headers['cache-control'], `Cache-Control on ${response.url()}`)
    .toBe(CACHE_REVALIDATE);
}

export async function expectCleanRun(
  page: Page,
  guards: Guards,
  testInfo: TestInfo,
): Promise<void> {
  await testInfo.attach('requests.txt', {
    body: guards.requests.join('\n'),
    contentType: 'text/plain',
  });

  const violations = await page.evaluate(
    () => (globalThis as unknown as { __cspViolations?: CspViolation[] }).__cspViolations ?? null,
  );
  expect(violations, 'the CSP violation recorder was not installed').not.toBeNull();
  expect.soft(violations, 'CSP violations').toEqual([]);
  expect.soft(guards.consoleErrors, 'console errors').toEqual([]);
  expect.soft(guards.pageErrors, 'uncaught page errors').toEqual([]);
  expect.soft(guards.forbiddenRequests, 'forbidden requests').toEqual([]);
  // One document load. A reload would also reset the recorder and lose earlier violations.
  expect.soft(guards.documentRequests, 'document loads').toHaveLength(1);

  for (const response of guards.assetResponses) {
    const cacheControl = await response.headerValue('cache-control');
    expect.soft(cacheControl, `Cache-Control on ${response.url()}`).toBe(CACHE_IMMUTABLE);
  }
}
