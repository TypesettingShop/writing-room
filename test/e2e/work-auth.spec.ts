import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test as base, type Page } from '@playwright/test';
import { createApiServer } from '../../server/apiServer.js';
import { MemoryAuthStore } from '../../server/auth/authStore.js';
import { InMemoryManuscriptRepository } from '../../src/platform/manuscript/common/inMemoryManuscriptStore.js';
import { groups, listBackups, selectedTab } from './files.helpers.js';
import { append, createManuscript, markdown, openManuscript, save } from './manuscript-storage.helpers.js';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

const googleClientId = 'writing-room-e2e';
const callbackPath = '/api/auth/oauth/google/callback';

async function startFakeGoogle(publicOrigin: string) {
  const redirect = publicOrigin + callbackPath;
  const grants = new Map<string, string>();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, publicOrigin);
    if (request.method === 'GET' && url.pathname === '/authorize') {
      const state = url.searchParams.get('state');
      const nonce = url.searchParams.get('nonce');
      if (!state || !nonce || url.searchParams.get('redirect_uri') !== redirect ||
          url.searchParams.get('client_id') !== googleClientId || url.searchParams.get('code_challenge_method') !== 'S256') {
        response.writeHead(400).end();
        return;
      }
      const code = crypto.randomUUID();
      grants.set(code, nonce);
      const accept = new URLSearchParams({ state, code });
      const cancel = new URLSearchParams({ state, error: 'access_denied' });
      response.writeHead(200, { 'Content-Type': 'text/html' }).end(
        '<a href="' + redirect + '?' + accept.toString().replaceAll('&', '&amp;') + '">Allow</a>' +
        '<a href="' + redirect + '?' + cancel.toString().replaceAll('&', '&amp;') + '">Cancel</a>',
      );
      return;
    }
    if (request.method !== 'POST' || url.pathname !== '/token') {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const code = new URLSearchParams(Buffer.concat(chunks).toString()).get('code') ?? '';
    const nonce = grants.get(code);
    grants.delete(code);
    if (!nonce) {
      response.writeHead(400).end();
      return;
    }
    const claims = Buffer.from(JSON.stringify({
      iss: 'https://accounts.google.com', aud: googleClientId, exp: Math.floor(Date.now() / 1000) + 60,
      sub: 'e2e-writer', email: 'google@example.test', email_verified: true, nonce,
    })).toString('base64url');
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id_token: 'e30.' + claims + '.test' }));
  });
  const origin = await listen(server);
  return {
    server,
    config: {
      clientId: googleClientId, clientSecret: 'fixture-secret', publicOrigin,
      authorizationEndpoint: origin + '/authorize', tokenEndpoint: origin + '/token',
    },
  };
}

const test = base.extend<{ googleEnabled: boolean; authApi: string }>({
  googleEnabled: [false, { option: true }],
  authApi: async ({ page, baseURL, googleEnabled }, use) => {
    const publicOrigin = new URL(baseURL!).origin;
    const google = googleEnabled ? await startFakeGoogle(publicOrigin) : undefined;
    const api = createApiServer({
      store: 'memory', repository: new InMemoryManuscriptRepository(), allowedOrigins: [publicOrigin],
      accountAuth: { store: new MemoryAuthStore(), trustProxy: false, allowLoopbackHttpCookies: true, google: google?.config },
    });
    try {
      const origin = await listen(api);
      // Keep Vite and the existing dev-auth suites on their usual ports. This browser uses a separate
      // account-only API, retaining the app origin for browser cookies and CORS/Origin checks.
      await page.context().route(publicOrigin + '/api/**', async route => {
        const { pathname, search } = new URL(route.request().url());
        const response = await route.fetch({ url: origin + pathname + search, maxRedirects: 0 });
        await route.fulfill({ response });
      });
      await use(origin);
    } finally {
      await close(api);
      if (google) {
        await close(google.server);
      }
    }
  },
});

const password = 'fixture-only password';
const worksSection = (page: Page) => page.getByRole('region', { name: 'Works', exact: true });
const accountForm = (page: Page) => worksSection(page).locator('form');

async function submitCredentials(page: Page, email: string, secret: string, createAccount = false): Promise<void> {
  const form = accountForm(page);
  if (createAccount) {
    await form.getByRole('button', { name: 'Create Account', exact: true }).click();
  }
  await expect(form.getByLabel('Password')).toHaveAttribute('autocomplete', createAccount ? 'new-password' : 'current-password');
  await form.getByLabel('Email').fill(email);
  await form.getByLabel('Password').fill(secret);
  await form.getByLabel('Password').press('Enter');
}

async function workMenu(page: Page) {
  await page.getByRole('menubar').getByRole('menuitem', { name: 'Work', exact: true }).click();
  return page.getByRole('menu', { name: 'Work', exact: true });
}

test('signs up, restores the session on reload, signs out, and signs in to the same Works', async ({ page, authApi, baseURL }) => {
  await page.goto('/');
  await expect(accountForm(page)).toBeVisible();
  await expect(worksSection(page).getByRole('link', { name: 'Continue with Google' })).toHaveCount(0);
  const menu = await workMenu(page);
  await expect(menu.getByRole('menuitem', { name: 'Sign Out' })).toHaveCount(0);
  await menu.getByRole('menuitem', { name: 'Sign In...' }).click();
  await expect(worksSection(page)).toBeFocused();

  const email = 'writer@example.test';
  await submitCredentials(page, email, password, true);
  await expect(worksSection(page).getByText('No Works yet.')).toBeVisible();
  await expect(accountForm(page)).toBeHidden();
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(password);

  const title = 'Saved by the writer';
  const response = await page.request.post(authApi + '/api/works', {
    headers: { Origin: new URL(baseURL!).origin }, data: { title },
  });
  expect(response.status()).toBe(201);
  await page.reload();
  const listedWork = worksSection(page).getByRole('button', { name: title });
  await expect(listedWork).toBeVisible();
  await expect(accountForm(page)).toBeHidden();
  await page.getByRole('button', { name: 'New Text File...' }).click();
  const draftTab = page.getByRole('tab', { name: 'Untitled-1' });
  await expect(draftTab).toHaveAttribute('aria-selected', 'true');
  await draftTab.dblclick(); // Pin the preview so it remains open when Welcome is selected.
  await page.reload();
  await expect(draftTab).toHaveAttribute('aria-selected', 'true');
  await (await workMenu(page)).getByRole('menuitem', { name: 'Sign Out' }).click();
  await expect(accountForm(page)).toBeVisible();
  await expect(draftTab).toBeVisible();
  await expect(listedWork).toHaveCount(0);
  expect((await page.request.get(authApi + '/api/works')).status()).toBe(401);

  const wrong = 'wrong password';
  await submitCredentials(page, email, wrong);
  await expect(worksSection(page).getByRole('alert')).toHaveText('Email or password is incorrect.');
  await expect(accountForm(page).getByLabel('Password')).toHaveValue('');
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(wrong);

  await submitCredentials(page, email, password);
  await expect(listedWork).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Welcome' })).toHaveCount(1);
});

test('keeps a dirty manuscript and its backup when the save is unauthorized', async ({ page, authApi, baseURL }) => {
  const email = 'draft@example.test';
  await page.goto('/');
  await submitCredentials(page, email, password, true);
  await expect(worksSection(page).getByText('No Works yet.')).toBeVisible();
  const { workId, nodeId, documentPath } = await createManuscript(page.request, baseURL!, authApi);
  await openManuscript(page, workId, nodeId);
  await expect(markdown(page).locator('p')).toHaveText('Draft', { timeout: 20_000 });
  await append(page, ' survives sign-out');
  const group = groups(page).first();
  const manuscriptTab = group.getByRole('tab').filter({ hasNotText: 'Welcome' });
  await page.context().clearCookies({ name: 'wr_session' });
  const rejectedSave = page.waitForResponse(response => response.url().endsWith(documentPath) &&
    response.request().method() === 'PUT' && response.status() === 401);
  await save(page);
  await rejectedSave;
  await expect(page.getByText('You are signed out. Sign in to keep saving.', { exact: true })).toBeVisible();
  await expect(page.getByText(/^Failed to save '/)).toBeVisible();
  await expect(accountForm(page)).toBeVisible();
  await expect(page).toHaveURL('/?work=' + workId);
  await expect(manuscriptTab).toHaveAccessibleDescription('Modified');
  await expect.poll(async () => (await listBackups(page)).some(path => path.startsWith('/User/workspaceStorage/work-' + workId))).toBe(true);

  await submitCredentials(page, email, password);
  await expect(accountForm(page)).toBeHidden();
  await manuscriptTab.click();
  await expect(markdown(page).locator('p')).toHaveText('Draft survives sign-out');
  await save(page);
  await expect.poll(async () => (await (await page.request.get(authApi + documentPath)).text()).trimEnd())
    .toBe('Draft survives sign-out');
  await expect(selectedTab(group)).toHaveAccessibleDescription('');
});

test.describe('Google available', () => {
  test.use({ googleEnabled: true });

  test('returns through the fake Google provider and consumes the cancellation marker once', async ({ page, authApi }) => {
    await page.goto('/?keep=a%20b');
    const google = worksSection(page).getByRole('link', { name: 'Continue with Google' });
    const href = await google.getAttribute('href');
    expect(new URL(href!, page.url()).pathname).toBe('/api/auth/oauth/google/start');
    expect(new URL(href!, page.url()).searchParams.get('returnTo')).toBe('/?keep=a%20b');
    await google.click();
    await expect(page).toHaveURL(/\/authorize\?/);
    await page.getByRole('link', { name: 'Allow' }).click();
    await expect(page).toHaveURL('/?keep=a%20b');
    await expect(worksSection(page).getByText('No Works yet.')).toBeVisible();
    expect((await (await page.request.get(authApi + '/api/auth/me')).json()).user.email).toBe('google@example.test');

    await (await workMenu(page)).getByRole('menuitem', { name: 'Sign Out' }).click();
    await google.click();
    await page.getByRole('link', { name: 'Cancel' }).click();
    await expect(page).toHaveURL('/');
    await expect(worksSection(page)).toBeFocused();
    await expect(worksSection(page).getByRole('alert')).toHaveText('Google sign-in was canceled.');
    await page.reload();
    await expect(accountForm(page)).toBeVisible();
    await expect(worksSection(page).getByRole('alert')).toBeEmpty();
  });
});
