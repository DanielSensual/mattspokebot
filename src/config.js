/**
 * Pokemon Center Bot — Configuration
 */

import 'dotenv/config';

export const config = {
    // Account credentials (for auto-login when cookies expire)
    credentials: {
        email: process.env.POKEMON_CENTER_EMAIL || '',
        password: process.env.POKEMON_CENTER_PASSWORD || '',
    },

    // PayPal checkout (no card numbers — just PayPal login)
    paypal: {
        email: process.env.PAYPAL_EMAIL || '',
        password: process.env.PAYPAL_PASSWORD || '',
    },

    // Monitoring
    pollIntervalMs: (Number(process.env.POLL_INTERVAL_SECONDS) || 60) * 1000,
    pollJitterMs: (Number(process.env.POLL_JITTER_SECONDS) || 15) * 1000,
    maxFailuresBeforePause: Number(process.env.MAX_FAILURES_BEFORE_PAUSE) || 10,

    // Checkout
    useStoreCredits: process.env.USE_STORE_CREDITS !== 'false',
    maxPurchaseAmount: Number(process.env.MAX_PURCHASE_AMOUNT) || 500,
    dryRun: process.env.DRY_RUN === 'true',
    screenshotsEnabled: process.env.SCREENSHOTS_ENABLED !== 'false',

    // Browser
    headless: process.env.HEADLESS !== 'false',
    browserPath: process.env.BROWSER_PATH || null,
    proxyUrl: process.env.PROXY_URL || null,

    // Session
    pokemonCenterCookies: process.env.POKEMON_CENTER_COOKIES || '',

    // Notifications
    discord: {
        webhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
    },
    twilio: {
        accountSid: process.env.TWILIO_ACCOUNT_SID || '',
        authToken: process.env.TWILIO_AUTH_TOKEN || '',
        fromNumber: process.env.TWILIO_FROM_NUMBER || '',
        toNumber: process.env.ALERT_PHONE_NUMBER || '',
    },

    // URLs
    pokemonCenter: {
        baseUrl: 'https://www.pokemoncenter.com',
        cartUrl: 'https://www.pokemoncenter.com/cart',
        checkoutUrl: 'https://www.pokemoncenter.com/checkout',
    },
};

export default config;
