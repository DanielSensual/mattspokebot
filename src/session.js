/**
 * Pokemon Center Bot — Session Manager
 *
 * Manages browser session cookies across runs by persisting them in SQLite
 * and optionally bootstrapping from an environment variable.  Provides
 * validation against the Pokemon Center account endpoint and injection
 * into Playwright browser contexts.
 */

import { config } from './config.js';
import { log } from './logger.js';
import { getDb } from './db.js';
import { getStealthHeaders } from './stealth.js';

// ---------------------------------------------------------------------------
// Cookie persistence
// ---------------------------------------------------------------------------

/**
 * Loads cookies from the environment variable `POKEMON_CENTER_COOKIES`
 * (JSON string) or falls back to the most recent row in the SQLite
 * `session_state` table.
 *
 * @returns {Array<import('playwright').Cookie>} Array of cookie objects
 */
export function loadCookies() {
    // 1. Try env first — highest priority
    if (config.pokemonCenterCookies) {
        try {
            const cookies = JSON.parse(config.pokemonCenterCookies);
            if (Array.isArray(cookies) && cookies.length > 0) {
                log.info('Loaded cookies from environment variable', { count: cookies.length });
                return cookies;
            }
        } catch (err) {
            log.warn('Failed to parse POKEMON_CENTER_COOKIES env var', { error: err.message });
        }
    }

    // 2. Fall back to SQLite
    try {
        const db = getDb();
        const row = db
            .prepare('SELECT cookies FROM session_state ORDER BY updated_at DESC LIMIT 1')
            .get();

        if (row?.cookies) {
            const cookies = JSON.parse(row.cookies);
            log.info('Loaded cookies from SQLite session_state', { count: cookies.length });
            return cookies;
        }
    } catch (err) {
        log.warn('Failed to load cookies from database', { error: err.message });
    }

    log.warn('No cookies available — session will be unauthenticated');
    return [];
}

/**
 * Persists a cookie array to the `session_state` table in SQLite.
 * Uses an upsert so there is always at most one active session row.
 *
 * @param {Array<import('playwright').Cookie>} cookies
 */
export function saveCookies(cookies) {
    if (!Array.isArray(cookies) || cookies.length === 0) {
        log.warn('saveCookies called with empty or invalid cookie array — skipping');
        return;
    }

    try {
        const db = getDb();
        const json = JSON.stringify(cookies);

        db.prepare(`
            INSERT INTO session_state (id, cookies, updated_at)
            VALUES (1, ?, datetime('now'))
            ON CONFLICT(id) DO UPDATE SET cookies = excluded.cookies, updated_at = excluded.updated_at
        `).run(json);

        log.info('Saved cookies to SQLite session_state', { count: cookies.length });
    } catch (err) {
        log.error('Failed to save cookies to database', { error: err.message });
    }
}

// ---------------------------------------------------------------------------
// Session validation
// ---------------------------------------------------------------------------

/**
 * Makes a lightweight `fetch()` request to the Pokemon Center account page
 * with the supplied cookies to determine whether the session is still
 * authenticated.
 *
 * A 200-level response whose body does **not** contain a login prompt is
 * considered valid.
 *
 * @param {Array<import('playwright').Cookie>} cookies
 * @returns {Promise<boolean>} `true` if the session is authenticated
 */
export async function validateSession(cookies) {
    if (!cookies || cookies.length === 0) {
        log.warn('validateSession called with no cookies');
        return false;
    }

    const accountUrl = `${config.pokemonCenter.baseUrl}/account`;

    try {
        const cookieHeader = cookies
            .map((c) => `${c.name}=${c.value}`)
            .join('; ');

        const headers = {
            ...getStealthHeaders(),
            Cookie: cookieHeader,
        };

        const res = await fetch(accountUrl, {
            method: 'GET',
            headers,
            redirect: 'manual',  // don't follow redirects — a redirect means logged-out
        });

        // A 3xx redirect to /login means the session is expired
        if (res.status >= 300 && res.status < 400) {
            const location = res.headers.get('location') || '';
            log.info('Session validation: redirected', { status: res.status, location });
            return false;
        }

        if (!res.ok) {
            log.warn('Session validation: non-OK response', { status: res.status });
            return false;
        }

        const body = await res.text();

        // If the body contains sign-in/login prompts, the session is invalid
        const loggedOut =
            body.includes('Sign In') &&
            (body.includes('/login') || body.includes('/auth'));

        if (loggedOut) {
            log.info('Session validation: page contains login prompt — session expired');
            return false;
        }

        log.info('Session validation: authenticated ✓');
        return true;
    } catch (err) {
        log.error('Session validation request failed', { error: err.message });
        return false;
    }
}

// ---------------------------------------------------------------------------
// Playwright integration
// ---------------------------------------------------------------------------

/**
 * Injects an array of cookies into a Playwright `BrowserContext`.
 *
 * Cookie objects are normalised to ensure required fields (`domain`,
 * `path`, `sameSite`) are present before injection.
 *
 * @param {import('playwright').BrowserContext} context  Playwright browser context
 * @param {Array<import('playwright').Cookie>}  cookies  Cookies to inject
 */
export async function injectCookies(context, cookies) {
    if (!cookies || cookies.length === 0) {
        log.warn('injectCookies: no cookies to inject');
        return;
    }

    // Normalise cookies for Playwright (it requires domain + path at minimum)
    const normalised = cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain || '.pokemoncenter.com',
        path: c.path || '/',
        secure: c.secure ?? true,
        httpOnly: c.httpOnly ?? false,
        sameSite: normaliseSameSite(c.sameSite),
        ...(c.expires ? { expires: c.expires } : {}),
    }));

    await context.addCookies(normalised);
    log.info('Injected cookies into Playwright context', { count: normalised.length });
}

/**
 * Normalise a sameSite value to one of Playwright's accepted enum strings.
 * @param {string|undefined} value
 * @returns {'Strict'|'Lax'|'None'}
 */
function normaliseSameSite(value) {
    const v = (value || '').toLowerCase();
    if (v === 'strict') return 'Strict';
    if (v === 'none') return 'None';
    return 'Lax'; // safe default
}

// ---------------------------------------------------------------------------
// Auto-login with email/password
// ---------------------------------------------------------------------------

/**
 * Logs into pokemoncenter.com using Playwright with the configured
 * email and password credentials.  On success, extracts and persists
 * the session cookies so subsequent runs can skip the login step.
 *
 * @returns {Promise<Array<import('playwright').Cookie>>} Authenticated cookies
 * @throws {Error} If login fails or credentials are missing
 */
export async function performLogin() {
    const { email, password } = config.credentials;

    if (!email || !password) {
        throw new Error(
            'Auto-login requires POKEMON_CENTER_EMAIL and POKEMON_CENTER_PASSWORD env vars',
        );
    }

    log.info('🔐 Performing auto-login to Pokemon Center...', { email });

    // Dynamic import to avoid loading Playwright for cookie-only flows
    const { chromium } = await import('playwright-extra');
    const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default;
    const { humanDelay } = await import('./stealth.js');

    chromium.use(StealthPlugin());

    const launchOptions = { headless: config.headless };
    if (config.browserPath) launchOptions.executablePath = config.browserPath;
    if (config.proxyUrl) launchOptions.proxy = { server: config.proxyUrl };

    const browser = await chromium.launch(launchOptions);

    try {
        const context = await browser.newContext({
            locale: 'en-US',
            timezoneId: 'America/New_York',
            viewport: { width: 1440, height: 900 },
        });

        const page = await context.newPage();

        // Navigate to login page
        log.info('Navigating to Pokemon Center login page');
        await page.goto('https://www.pokemoncenter.com/login', {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
        });
        await humanDelay();

        // Check for CAPTCHA before even trying
        const content = await page.content();
        if (content.includes('hcaptcha') || content.includes('h-captcha')) {
            log.error('hCaptcha detected on login page — cannot auto-login');
            try {
                const { sendCriticalAlert } = await import('./alerts.js');
                await sendCriticalAlert('⚠️ CAPTCHA on login page — auto-login blocked. Manual login required.');
            } catch { /* swallow */ }
            throw new Error('CAPTCHA detected on login page');
        }

        // Fill email
        const emailSelectors = [
            'input[name="email"]',
            'input[type="email"]',
            'input[id="email"]',
            '#email',
            'input[data-testid="email"]',
            'input[placeholder*="email" i]',
        ];

        let emailFilled = false;
        for (const sel of emailSelectors) {
            try {
                const input = page.locator(sel).first();
                await input.waitFor({ state: 'visible', timeout: 5000 });
                await input.click();
                await humanDelay();
                await input.fill(email);
                emailFilled = true;
                log.info('Email entered', { selector: sel });
                break;
            } catch { /* try next */ }
        }

        if (!emailFilled) {
            throw new Error('Could not find email input field on login page');
        }

        await humanDelay();

        // Fill password
        const passwordSelectors = [
            'input[name="password"]',
            'input[type="password"]',
            'input[id="password"]',
            '#password',
            'input[data-testid="password"]',
        ];

        let passwordFilled = false;
        for (const sel of passwordSelectors) {
            try {
                const input = page.locator(sel).first();
                await input.waitFor({ state: 'visible', timeout: 5000 });
                await input.click();
                await humanDelay();
                await input.fill(password);
                passwordFilled = true;
                log.info('Password entered');
                break;
            } catch { /* try next */ }
        }

        if (!passwordFilled) {
            throw new Error('Could not find password input field on login page');
        }

        await humanDelay();

        // Click sign-in button
        const loginSelectors = [
            'button[type="submit"]',
            'button:has-text("Sign In")',
            'button:has-text("Log In")',
            'button:has-text("Login")',
            '[data-testid="login-button"]',
            '.login-button',
        ];

        let loginClicked = false;
        for (const sel of loginSelectors) {
            try {
                const btn = page.locator(sel).first();
                await btn.waitFor({ state: 'visible', timeout: 5000 });
                await btn.click();
                loginClicked = true;
                log.info('Login button clicked', { selector: sel });
                break;
            } catch { /* try next */ }
        }

        if (!loginClicked) {
            throw new Error('Could not find login/submit button');
        }

        // Wait for navigation after login (account page or homepage)
        log.info('Waiting for post-login navigation...');
        await page.waitForNavigation({
            waitUntil: 'domcontentloaded',
            timeout: 20000,
        }).catch(() => {
            log.warn('Post-login navigation timeout — checking page state');
        });

        await humanDelay();

        // Check if login succeeded — look for account indicators
        const postLoginContent = await page.content();
        const loginFailed =
            postLoginContent.includes('Invalid email or password') ||
            postLoginContent.includes('incorrect') ||
            postLoginContent.includes('try again');

        if (loginFailed) {
            throw new Error('Login failed — invalid email or password');
        }

        // Post-CAPTCHA check
        if (postLoginContent.includes('hcaptcha') || postLoginContent.includes('h-captcha')) {
            log.error('hCaptcha appeared after login attempt');
            try {
                const { sendCriticalAlert } = await import('./alerts.js');
                await sendCriticalAlert('⚠️ CAPTCHA after login attempt — manual intervention needed.');
            } catch { /* swallow */ }
            throw new Error('CAPTCHA detected after login');
        }

        // Extract and save cookies
        const cookies = await context.cookies();
        const pcCookies = cookies.filter(
            (c) => c.domain.includes('pokemoncenter.com'),
        );

        if (pcCookies.length === 0) {
            throw new Error('Login appeared to succeed but no pokemoncenter.com cookies were set');
        }

        saveCookies(pcCookies);
        log.info('✅ Auto-login successful — cookies saved', { count: pcCookies.length });

        await context.close();
        return pcCookies;
    } finally {
        await browser.close().catch(() => {});
    }
}

// ---------------------------------------------------------------------------
// Session orchestrator
// ---------------------------------------------------------------------------

/**
 * Ensures a valid authenticated session exists.  Tries in order:
 *
 * 1. Load existing cookies and validate them.
 * 2. If invalid/missing and credentials are configured, perform auto-login.
 * 3. If no credentials, alert the user and return empty cookies.
 *
 * @returns {Promise<Array<import('playwright').Cookie>>} Authenticated cookies
 */
export async function ensureSession() {
    // Try existing cookies first
    const cookies = loadCookies();

    if (cookies.length > 0) {
        const valid = await validateSession(cookies);
        if (valid) {
            log.info('Existing session is valid');
            return cookies;
        }
        log.warn('Existing session expired — attempting refresh');
    }

    // Try auto-login
    const { email, password } = config.credentials;
    if (email && password) {
        try {
            const freshCookies = await performLogin();
            return freshCookies;
        } catch (err) {
            log.error('Auto-login failed', { error: err.message });
            try {
                const { sendAlert } = await import('./alerts.js');
                await sendAlert('session_expired', {
                    message: `Auto-login failed: ${err.message}. Manual intervention required.`,
                });
            } catch { /* swallow */ }
        }
    } else {
        log.warn('No credentials configured — cannot auto-login');
        try {
            const { sendAlert } = await import('./alerts.js');
            await sendAlert('session_expired', {
                message: 'Session expired and no credentials configured. Set POKEMON_CENTER_EMAIL and POKEMON_CENTER_PASSWORD.',
            });
        } catch { /* swallow */ }
    }

    return cookies; // Return whatever we have (might be empty)
}
