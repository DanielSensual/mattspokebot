/**
 * Pokemon Center Bot — Notification Module
 *
 * Sends alerts via Discord webhooks and Twilio SMS.
 * Discord gets all alert types as rich embeds.
 * Twilio SMS is reserved for critical alerts only.
 */

import { config } from './config.js';
import { log } from './logger.js';

/** @type {Record<string, { color: number, title: string, critical: boolean }>} */
const ALERT_TYPES = {
    restock: {
        color: 0x3498db,   // blue
        title: '🔵 Product Restocked!',
        critical: false,
    },
    purchase_success: {
        color: 0x2ecc71,   // green
        title: '✅ Purchase Successful!',
        critical: true,
    },
    purchase_failed: {
        color: 0xe74c3c,   // red
        title: '❌ Purchase Failed',
        critical: false,
    },
    session_expired: {
        color: 0xf39c12,   // yellow
        title: '⚠️ Session Expired',
        critical: true,
    },
    captcha_blocked: {
        color: 0xe74c3c,   // red
        title: '🛑 Captcha / Bot Block Detected',
        critical: true,
    },
    monitor_error: {
        color: 0xf39c12,   // yellow
        title: '⚠️ Monitor Error',
        critical: false,
    },
};

const POKEMON_CENTER_FAVICON = 'https://www.pokemoncenter.com/favicon.ico';

/**
 * Build Discord embed fields from alert data.
 * @param {string} type - Alert type key
 * @param {Record<string, unknown>} data - Alert payload
 * @returns {Array<{ name: string, value: string, inline?: boolean }>}
 */
function buildFields(type, data) {
    const fields = [];

    if (data.productName || data.title) {
        fields.push({ name: 'Product', value: String(data.productName || data.title), inline: true });
    }
    if (data.url) {
        fields.push({ name: 'URL', value: String(data.url), inline: false });
    }
    if (data.price != null) {
        fields.push({ name: 'Price', value: `$${Number(data.price).toFixed(2)}`, inline: true });
    }
    if (data.orderId) {
        fields.push({ name: 'Order ID', value: String(data.orderId), inline: true });
    }
    if (data.error || data.errorMessage) {
        fields.push({ name: 'Error', value: String(data.error || data.errorMessage), inline: false });
    }
    if (data.message) {
        fields.push({ name: 'Details', value: String(data.message), inline: false });
    }
    if (data.consecutiveFailures != null) {
        fields.push({ name: 'Consecutive Failures', value: String(data.consecutiveFailures), inline: true });
    }

    fields.push({
        name: 'Timestamp',
        value: new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }),
        inline: true,
    });

    return fields;
}

/**
 * Send a rich embed to Discord via webhook.
 * @param {string} type - Alert type key
 * @param {Record<string, unknown>} data - Alert payload
 */
async function sendDiscordWebhook(type, data) {
    const webhookUrl = config.discord.webhookUrl;
    if (!webhookUrl) return;

    const meta = ALERT_TYPES[type] || ALERT_TYPES.monitor_error;

    const embed = {
        title: meta.title,
        color: meta.color,
        fields: buildFields(type, data),
        thumbnail: {
            url: data.imageUrl || POKEMON_CENTER_FAVICON,
        },
        footer: {
            text: 'Matt\'s Pokemon Center Bot',
        },
        timestamp: new Date().toISOString(),
    };

    try {
        const res = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ embeds: [embed] }),
        });

        if (!res.ok) {
            const body = await res.text().catch(() => '');
            log.error('Discord webhook failed', { status: res.status, body });
        } else {
            log.info('Discord alert sent', { type });
        }
    } catch (err) {
        log.error('Discord webhook request error', { error: err.message });
    }
}

/**
 * Send an SMS via Twilio REST API using Basic auth + native fetch.
 * @param {string} body - SMS message body
 */
async function sendTwilioSms(body) {
    const { accountSid, authToken, fromNumber, toNumber } = config.twilio;
    if (!accountSid || !authToken || !fromNumber || !toNumber) return;

    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    const params = new URLSearchParams({
        To: toNumber,
        From: fromNumber,
        Body: body.slice(0, 1600), // Twilio max is 1600 chars
    });

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${auth}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: params.toString(),
        });

        if (!res.ok) {
            const errBody = await res.text().catch(() => '');
            log.error('Twilio SMS failed', { status: res.status, body: errBody });
        } else {
            log.info('Twilio SMS sent', { to: toNumber });
        }
    } catch (err) {
        log.error('Twilio SMS request error', { error: err.message });
    }
}

/**
 * Build a plain-text summary for SMS from alert data.
 * @param {string} type - Alert type key
 * @param {Record<string, unknown>} data - Alert payload
 * @returns {string}
 */
function buildSmsBody(type, data) {
    const meta = ALERT_TYPES[type] || ALERT_TYPES.monitor_error;
    const parts = [`[Pokemon Bot] ${meta.title}`];

    if (data.productName || data.title) parts.push(`Product: ${data.productName || data.title}`);
    if (data.price != null) parts.push(`Price: $${Number(data.price).toFixed(2)}`);
    if (data.orderId) parts.push(`Order: ${data.orderId}`);
    if (data.error || data.errorMessage) parts.push(`Error: ${data.error || data.errorMessage}`);
    if (data.message) parts.push(data.message);
    if (data.url) parts.push(data.url);

    return parts.join('\n');
}

/**
 * Send a notification alert through configured channels.
 *
 * Discord receives all alert types as rich embeds.
 * Twilio SMS fires only for critical types: purchase_success, captcha_blocked, session_expired.
 *
 * @param {'restock' | 'purchase_success' | 'purchase_failed' | 'session_expired' | 'captcha_blocked' | 'monitor_error'} type - Alert type
 * @param {Record<string, unknown>} data - Alert payload (product title, url, price, error, etc.)
 * @returns {Promise<void>}
 */
export async function sendAlert(type, data = {}) {
    if (!ALERT_TYPES[type]) {
        log.warn('Unknown alert type, defaulting to monitor_error', { type });
        type = 'monitor_error';
    }

    log.info('Sending alert', { type, product: data.productName || data.title || '—' });

    const meta = ALERT_TYPES[type];

    // Always attempt Discord
    await sendDiscordWebhook(type, data);

    // SMS for critical alerts only
    if (meta.critical && config.twilio.accountSid) {
        await sendTwilioSms(buildSmsBody(type, data));
    }
}

/**
 * Shorthand to fire a critical captcha_blocked alert to all channels.
 *
 * @param {string} message - Human-readable message describing the block
 * @returns {Promise<void>}
 */
export async function sendCriticalAlert(message) {
    await sendAlert('captcha_blocked', { message });
}
