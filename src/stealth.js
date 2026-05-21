/**
 * Pokemon Center Bot — Anti-Detection & Stealth Module
 *
 * Provides randomized browser fingerprints, realistic HTTP headers,
 * and human-like timing utilities to reduce detection risk.
 */

import { log } from './logger.js';

// ---------------------------------------------------------------------------
// User-Agent Pool — real desktop strings from 2025-2026 stable releases
// ---------------------------------------------------------------------------
const USER_AGENTS = [
    // Chrome 124 – Windows
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    // Chrome 125 – Windows
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    // Chrome 124 – macOS
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    // Chrome 125 – macOS
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    // Safari 17.4 – macOS
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    // Safari 17.5 – macOS
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    // Firefox 125 – Windows
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
    // Firefox 126 – Windows
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
    // Firefox 125 – macOS
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:125.0) Gecko/20100101 Firefox/125.0',
    // Edge 124 – Windows
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
];

// ---------------------------------------------------------------------------
// Platform-aligned Sec-Ch-Ua values for Chromium-based UAs
// ---------------------------------------------------------------------------
const SEC_CH_UA_VALUES = [
    '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    '"Chromium";v="125", "Google Chrome";v="125", "Not-A.Brand";v="99"',
    '"Chromium";v="124", "Microsoft Edge";v="124", "Not-A.Brand";v="99"',
];

const ACCEPT_LANGUAGES = [
    'en-US,en;q=0.9',
    'en-US,en;q=0.9,es;q=0.8',
    'en-US,en;q=0.8',
    'en-GB,en;q=0.9,en-US;q=0.8',
];

/**
 * Pick a random element from an array.
 * @param {Array} arr
 * @returns {*}
 */
function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Determine the platform hint from the User-Agent string.
 * @param {string} ua
 * @returns {string} Platform value for Sec-Ch-Ua-Platform
 */
function platformFromUA(ua) {
    if (ua.includes('Macintosh')) return '"macOS"';
    if (ua.includes('Windows')) return '"Windows"';
    if (ua.includes('Linux')) return '"Linux"';
    return '"Unknown"';
}

/**
 * Returns a complete set of realistic HTTP headers with a randomized
 * User-Agent and matching client-hint values.  Suitable for raw `fetch()`
 * requests or as extra headers on a Playwright context.
 *
 * @returns {Record<string, string>} HTTP headers object
 */
export function getStealthHeaders() {
    const ua = pick(USER_AGENTS);
    const isChromium = ua.includes('Chrome') || ua.includes('Edg');

    const headers = {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': pick(ACCEPT_LANGUAGES),
        'Accept-Encoding': 'gzip, deflate, br',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Referer': 'https://www.pokemoncenter.com/',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'max-age=0',
    };

    // Client-hint headers are only sent by Chromium-based browsers
    if (isChromium) {
        headers['Sec-Ch-Ua'] = pick(SEC_CH_UA_VALUES);
        headers['Sec-Ch-Ua-Mobile'] = '?0';
        headers['Sec-Ch-Ua-Platform'] = platformFromUA(ua);
    }

    log.debug('Generated stealth headers', { ua: ua.slice(0, 50) + '…' });
    return headers;
}

/**
 * Returns a promise that resolves after a random delay between `minMs`
 * and `maxMs` milliseconds.  Useful for request-level throttling.
 *
 * @param {number} minMs  Minimum delay in milliseconds
 * @param {number} maxMs  Maximum delay in milliseconds
 * @returns {Promise<void>}
 */
export function randomDelay(minMs, maxMs) {
    const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    log.debug('Random delay', { ms });
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Convenience wrapper that waits 800 – 2 500 ms to simulate the cadence
 * of a real human browsing, clicking, and typing.
 *
 * @returns {Promise<void>}
 */
export function humanDelay() {
    return randomDelay(800, 2500);
}

/**
 * Returns `baseMs` adjusted by a random amount in the range
 * `[-jitterMs, +jitterMs]`.  The result is clamped to ≥ 0.
 *
 * @param {number} baseMs    Base interval in milliseconds
 * @param {number} jitterMs  Maximum jitter offset in milliseconds
 * @returns {number} Jittered interval (always ≥ 0)
 */
export function jitterInterval(baseMs, jitterMs) {
    const offset = Math.floor(Math.random() * (jitterMs * 2 + 1)) - jitterMs;
    return Math.max(0, baseMs + offset);
}
