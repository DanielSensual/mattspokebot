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
