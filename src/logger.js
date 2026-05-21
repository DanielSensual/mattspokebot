/**
 * Pokemon Center Bot — Structured Logger
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function fmt(level, msg, meta = {}) {
    const ts = new Date().toISOString();
    const metaStr = Object.keys(meta).length
        ? ' ' + JSON.stringify(meta)
        : '';
    return `[${ts}] [${level.toUpperCase()}] ${msg}${metaStr}`;
}

export const log = {
    debug(msg, meta) {
        if (MIN_LEVEL <= LEVELS.debug) console.debug(fmt('debug', msg, meta));
    },
    info(msg, meta) {
        if (MIN_LEVEL <= LEVELS.info) console.log(fmt('info', msg, meta));
    },
    warn(msg, meta) {
        if (MIN_LEVEL <= LEVELS.warn) console.warn(fmt('warn', msg, meta));
    },
    error(msg, meta) {
        if (MIN_LEVEL <= LEVELS.error) console.error(fmt('error', msg, meta));
    },
};

export default log;
