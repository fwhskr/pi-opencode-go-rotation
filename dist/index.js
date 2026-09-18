import { ConfigLoadError, DEFAULT_COOLDOWN_MINUTES, DEFAULT_WATCHDOG_IDLE_MS, createEmptyConfig, loadConfig, updateConfig, } from "./config-store.js";
const PROVIDER = "opencode-go";
const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const OPENCODE_GO_USAGE_TIMEOUT_MS = 10_000;
const FIXED_WINDOW_QUOTA_RE = /\b(?:5[- ]hour|weekly|monthly)\b[\s\S]*\b(?:usage\s+)?(?:quota|limit)\b|\b(?:usage|plan)\s+allocated\s+quota\s+exceeded\b|\b(?:quota|limit)\b[\s\S]*\b(?:will\s+reset|resets?\s+at|fixed[- ]window)\b/i;
const TRANSIENT_RATE_LIMIT_RE = /\b429\b|rate.?limit|too many requests|quota|usage limit|limit reached/i;
function getCooldownMs(config) {
    return (config.cooldownMinutes || DEFAULT_COOLDOWN_MINUTES) * 60_000;
}
function getWatchdogIdleMs(config) {
    return config.watchdogIdleMs > 0 ? config.watchdogIdleMs : DEFAULT_WATCHDOG_IDLE_MS;
}
export function shouldWatchProvider(provider) {
    return provider === PROVIDER;
}
export function classifyRateLimitError(message) {
    if (FIXED_WINDOW_QUOTA_RE.test(message))
        return "fixed-window-quota";
    if (TRANSIENT_RATE_LIMIT_RE.test(message))
        return "transient";
    return undefined;
}
export function shouldRotateAfterWatchdogTimeout(timeoutInfo, rateLimitAlreadyRotated) {
    return timeoutInfo.lastStatus !== 401 && (timeoutInfo.lastStatus !== 429 || !rateLimitAlreadyRotated);
}
export class ProviderIdleWatchdog {
    timer;
    active = false;
    timedOut = false;
    phase = "waiting-for-response";
    startedAt = 0;
    lastActivityAt = 0;
    lastStatus;
    timeoutInfo;
    options;
    constructor(options) {
        this.options = options;
    }
    start() {
        const now = this.now();
        this.active = true;
        this.timedOut = false;
        this.timeoutInfo = undefined;
        this.phase = "waiting-for-response";
        this.startedAt = now;
        this.lastActivityAt = now;
        this.lastStatus = undefined;
        this.schedule();
    }
    response(status) {
        if (!this.active || this.timedOut)
            return;
        this.phase = "waiting-for-stream";
        this.lastStatus = status;
        this.markActivity();
    }
    streamActivity() {
        if (!this.active || this.timedOut)
            return;
        this.phase = "streaming";
        this.markActivity();
    }
    activity() {
        if (!this.active || this.timedOut)
            return;
        this.markActivity();
    }
    stop() {
        this.active = false;
        this.clear();
    }
    consumeTimeoutInfo() {
        const result = this.timeoutInfo;
        this.timeoutInfo = undefined;
        this.timedOut = false;
        return result;
    }
    currentTimeoutInfo() {
        return this.timeoutInfo;
    }
    markActivity() {
        this.lastActivityAt = this.now();
        this.schedule();
    }
    now() {
        return this.options.clock?.now() ?? Date.now();
    }
    getTimers() {
        return this.options.timers ?? {
            setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
            clearTimeout: (timer) => globalThis.clearTimeout(timer),
        };
    }
    schedule() {
        this.clear();
        const timers = this.getTimers();
        this.timer = timers.setTimeout(() => {
            if (!this.active || this.timedOut)
                return;
            const now = this.now();
            this.timeoutInfo = {
                phase: this.phase,
                idleMs: this.options.idleMs,
                elapsedMs: Math.max(0, now - this.startedAt),
                idleForMs: Math.max(0, now - this.lastActivityAt),
                lastStatus: this.lastStatus,
            };
            this.timedOut = true;
            this.active = false;
            this.timer = undefined;
            this.options.onTimeout();
        }, this.options.idleMs);
    }
    clear() {
        if (this.timer === undefined)
            return;
        const timers = this.getTimers();
        timers.clearTimeout(this.timer);
        this.timer = undefined;
    }
}
function getQuotaBlockedUntil(config, keyIndex, now) {
    const blockedUntil = config.quotaBlockedUntil[keyIndex];
    return typeof blockedUntil === "number" && Number.isFinite(blockedUntil) && blockedUntil > now
        ? blockedUntil
        : undefined;
}
/** Keys held by a live recorded block, optionally ignoring the key that just failed. */
function getQuotaBlockedTargets(config, now, skipKeyIndex) {
    const targets = [];
    for (let keyIndex = 0; keyIndex < config.keys.length; keyIndex++) {
        if (keyIndex === skipKeyIndex)
            continue;
        if (getQuotaBlockedUntil(config, keyIndex, now) === undefined)
            continue;
        const target = getUsageTargetForKeyIndex(config, keyIndex);
        if (target)
            targets.push(target);
    }
    return targets;
}
function pickAvailableKeyIndex(config, now = Date.now()) {
    const cdMs = getCooldownMs(config);
    for (let i = 0; i < config.keys.length; i++) {
        const idx = (config.activeKeyIndex + i) % config.keys.length;
        if (getQuotaBlockedUntil(config, idx, now) !== undefined)
            continue;
        const cooldownStart = config.cooldowns[idx];
        if (cooldownStart === undefined || now - cooldownStart >= cdMs)
            return idx;
    }
    return undefined;
}
function rotateToNextKey(config, options = {}) {
    if (config.keys.length === 0)
        return undefined;
    const now = options.now ?? Date.now();
    config.cooldowns[config.activeKeyIndex] = now;
    const next = pickAvailableKeyIndex(config, now);
    if (next !== undefined) {
        config.activeKeyIndex = next;
        return next;
    }
    for (let offset = 1; offset <= config.keys.length; offset++) {
        const candidate = (config.activeKeyIndex + offset) % config.keys.length;
        if (getQuotaBlockedUntil(config, candidate, now) !== undefined)
            continue;
        config.activeKeyIndex = candidate;
        delete config.cooldowns[candidate];
        return candidate;
    }
    return undefined;
}
// Key equality detects credential changes, but persisted history has no issuer
// provenance (including after reload). Never replay signed reasoning on this
// rotating route, even before this process observes its first rotation.
const droppedReasoningDetail = Symbol("dropped-caller-bound-reasoning");
function sanitizeReasoningPayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
        return payload;
    const request = payload;
    const result = { ...request };
    if (Array.isArray(request.messages)) {
        result.messages = request.messages.map((message) => {
            if (!message || typeof message !== "object")
                return message;
            const entry = message;
            if (entry.role !== "assistant" || !Array.isArray(entry.reasoning_details))
                return message;
            // map/filter, never flatMap: entries that are not plain reasoning detail
            // objects (nested arrays, numbers, booleans, ...) must pass through as the
            // same element in the same position, with their original shape intact.
            const projected = entry.reasoning_details.map((detail) => {
                if (!detail || typeof detail !== "object" || Array.isArray(detail))
                    return detail;
                const item = detail;
                if (item.type === "reasoning.encrypted")
                    return droppedReasoningDetail;
                const { signature: _signature, ...unsigned } = item;
                return unsigned;
            });
            const reasoning_details = projected.filter((detail) => detail !== droppedReasoningDetail);
            const { reasoning_details: _details, ...visible } = entry;
            // Strip the key entirely when nothing remains to send: an empty array is an
            // unvalidated request shape, and this sanitiser exists to emit only shapes the
            // provider accepts. Non-detail entries above keep identity/position/shape.
            return reasoning_details.length === 0 ? visible : { ...visible, reasoning_details };
        });
    }
    if (Array.isArray(request.input)) {
        result.input = request.input.filter((item) => !item || typeof item !== "object" || item.type !== "reasoning");
    }
    return result;
}
const lastAppliedRuntimeKeys = new WeakMap();
function getRuntimeKeyStore(modelRegistry) {
    const store = modelRegistry.authStorage ?? modelRegistry.runtime;
    if (!store)
        throw new Error("Model registry does not expose runtime API key storage");
    return store;
}
function ignoreAsyncRefresh(result) {
    void result?.catch(() => { });
}
/** Set the active key as runtime override (highest priority in auth chain). */
function applyActiveKey(config, modelRegistry, now = Date.now()) {
    const idx = pickAvailableKeyIndex(config, now);
    if (idx === undefined)
        return undefined;
    if (config.activeKeyIndex !== idx)
        config.activeKeyIndex = idx;
    const key = config.keys[idx].key;
    if (lastAppliedRuntimeKeys.get(modelRegistry) !== key) {
        lastAppliedRuntimeKeys.set(modelRegistry, key);
        ignoreAsyncRefresh(getRuntimeKeyStore(modelRegistry).setRuntimeApiKey(PROVIDER, key));
    }
    return config.keys[idx].name || `key-${idx + 1}`;
}
function getUsageTargetForKeyIndex(config, keyIndex) {
    const entry = config.keys[keyIndex];
    if (!entry)
        return undefined;
    return {
        keyIndex,
        keyName: entry.name || `key-${keyIndex + 1}`,
        bearerToken: entry.key,
    };
}
function getActiveUsageTarget(config) {
    return getUsageTargetForKeyIndex(config, config.activeKeyIndex);
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readString(record, keys) {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === "string")
            return value;
    }
    return undefined;
}
function readNumber(record, keys) {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === "number" && Number.isFinite(value))
            return value;
    }
    return undefined;
}
function parseOpenCodeGoUsageWindow(value) {
    if (!isRecord(value))
        return undefined;
    const status = value.status === "ok" || value.status === "active"
        ? "active"
        : value.status === "rate-limited" ? "rate-limited" : "unknown";
    const name = readString(value, ["name", "window", "period", "label"]);
    const usagePercent = readNumber(value, ["usagePercent", "usage_percent", "percent"]);
    const resetInSec = readNumber(value, ["resetInSec", "reset_in_sec", "resetSeconds", "reset_seconds"]);
    const used = readNumber(value, ["used", "usage", "usedTokens"]);
    const limit = readNumber(value, ["limit", "quota", "total"]);
    const remaining = readNumber(value, ["remaining", "remainingTokens"]);
    const resetAt = readString(value, ["resetAt", "reset_at", "resetsAt", "resets_at"]);
    const startAt = readString(value, ["startAt", "start_at", "startsAt", "starts_at"]);
    const endAt = readString(value, ["endAt", "end_at", "endsAt", "ends_at"]);
    return {
        status,
        ...(name === undefined ? {} : { name }),
        ...(usagePercent === undefined ? {} : { usagePercent }),
        ...(resetInSec === undefined ? {} : { resetInSec }),
        ...(used === undefined ? {} : { used }),
        ...(limit === undefined ? {} : { limit }),
        ...(remaining === undefined ? {} : { remaining }),
        ...(resetAt === undefined ? {} : { resetAt }),
        ...(startAt === undefined ? {} : { startAt }),
        ...(endAt === undefined ? {} : { endAt }),
    };
}
export function parseOpenCodeGoUsage(value) {
    if (!isRecord(value))
        return undefined;
    const windows = [];
    if (Array.isArray(value.windows)) {
        for (const window of value.windows) {
            const parsed = parseOpenCodeGoUsageWindow(window);
            if (!parsed)
                return undefined;
            windows.push(parsed);
        }
        return { windows };
    }
    if (!isRecord(value.usage))
        return undefined;
    for (const [name, window] of Object.entries(value.usage)) {
        const parsed = parseOpenCodeGoUsageWindow(window);
        if (!parsed)
            return undefined;
        windows.push(parsed.name === undefined ? { ...parsed, name } : parsed);
    }
    return { windows };
}
async function fetchOpenCodeGoUsage(target, fetchApi, timers) {
    if (!target)
        return { ok: false, message: "No OpenCode keys configured." };
    const controller = new AbortController();
    const timeoutFailure = { ok: false, keyName: target.keyName, message: "Usage request timed out after 10s." };
    const timerApi = timers ?? {
        setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
        clearTimeout: (timer) => globalThis.clearTimeout(timer),
    };
    let didTimeout = false;
    let timeout;
    const request = (async () => {
        try {
            const response = await fetchApi(OPENCODE_GO_USAGE_URL, {
                method: "GET",
                headers: {
                    Accept: "application/json",
                    Authorization: `Bearer ${target.bearerToken}`,
                },
                signal: controller.signal,
            });
            if (!response.ok) {
                return { ok: false, keyName: target.keyName, message: `Usage request failed with HTTP ${response.status}.` };
            }
            const usage = parseOpenCodeGoUsage(await response.json());
            if (!usage)
                return { ok: false, keyName: target.keyName, message: "Usage response did not match the expected OpenCode Go shape." };
            return { ok: true, keyName: target.keyName, usage };
        }
        catch {
            if (didTimeout)
                return timeoutFailure;
            return { ok: false, keyName: target.keyName, message: "Usage request failed." };
        }
    })();
    const timedOut = new Promise((resolve) => {
        timeout = timerApi.setTimeout(() => {
            didTimeout = true;
            controller.abort();
            resolve(timeoutFailure);
        }, OPENCODE_GO_USAGE_TIMEOUT_MS);
    });
    try {
        return await Promise.race([request, timedOut]);
    }
    finally {
        timerApi.clearTimeout(timeout);
    }
}
function captureUsageDecision(config, epoch) {
    const target = getActiveUsageTarget(config);
    return target ? { epoch, target } : undefined;
}
function isValidUsageDecisionTarget(decision, config, epoch) {
    const entry = config.keys[decision.target.keyIndex];
    return epoch === decision.epoch
        && entry !== undefined
        && (entry.name || `key-${decision.target.keyIndex + 1}`) === decision.target.keyName
        && entry.key === decision.target.bearerToken;
}
function isCurrentUsageDecision(decision, config, epoch) {
    return config.activeKeyIndex === decision.target.keyIndex
        && isValidUsageDecisionTarget(decision, config, epoch);
}
function hasRateLimitedUsageWindow(result) {
    return result.ok && result.usage.windows.some((window) => window.status === "rate-limited");
}
/**
 * A recorded block can go stale: the plan was topped up, or the window reset before the
 * deadline we stored. Only a clean reading releases it -- a failed or unrecognised usage
 * response is not evidence of headroom.
 */
function hasConfirmedHeadroom(result) {
    return result.ok
        && result.usage.windows.some((window) => window.status === "active")
        && !hasRateLimitedUsageWindow(result);
}
function getRateLimitedUntil(usage, now, fallbackMs) {
    let blockedUntil = now;
    for (const window of usage.windows) {
        if (window.status !== "rate-limited")
            continue;
        const resetTimes = [];
        if (window.resetInSec !== undefined) {
            const reset = now + window.resetInSec * 1000;
            if (Number.isFinite(reset) && reset > now)
                resetTimes.push(reset);
        }
        for (const timestamp of [window.resetAt, window.endAt]) {
            if (!timestamp)
                continue;
            const parsed = Date.parse(timestamp);
            if (Number.isFinite(parsed) && parsed > now)
                resetTimes.push(parsed);
        }
        blockedUntil = Math.max(blockedUntil, resetTimes.length > 0 ? Math.max(...resetTimes) : now + fallbackMs);
    }
    return blockedUntil > now ? blockedUntil : now + fallbackMs;
}
function parseFixedWindowQuotaReset(message, now) {
    const resetText = message.match(/\b(?:will\s+)?resets?(?:\s+at|\s+on)?\s+([^.;\n]+)/i)?.[1];
    if (resetText) {
        const parsed = Date.parse(resetText.trim());
        if (Number.isFinite(parsed) && parsed > now)
            return parsed;
    }
    return undefined;
}
function getEarliestQuotaReset(config, now) {
    const resets = Object.values(config.quotaBlockedUntil).filter((reset) => typeof reset === "number" && Number.isFinite(reset) && reset > now);
    return resets.length > 0 ? Math.min(...resets) : undefined;
}
function setQuotaBlock(config, keyIndex, blockedUntil, now) {
    config.quotaBlockedUntil[keyIndex] = Math.max(getQuotaBlockedUntil(config, keyIndex, now) ?? 0, blockedUntil);
}
function blockQuotaAndSelectNext(config, keyIndex, blockedUntil, now, isAuthoritative = false) {
    if (isAuthoritative) {
        config.quotaBlockedUntil[keyIndex] = blockedUntil;
    }
    else {
        setQuotaBlock(config, keyIndex, blockedUntil, now);
    }
    let next = pickAvailableKeyIndex(config, now);
    if (next === undefined) {
        for (let offset = 1; offset <= config.keys.length; offset++) {
            const candidate = (keyIndex + offset) % config.keys.length;
            if (getQuotaBlockedUntil(config, candidate, now) !== undefined)
                continue;
            next = candidate;
            delete config.cooldowns[candidate];
            break;
        }
    }
    if (next !== undefined)
        config.activeKeyIndex = next;
    return next;
}
function reindexAfterRemoval(record, removedIndex) {
    const shifted = {};
    for (const [key, value] of Object.entries(record)) {
        const index = Number(key);
        if (index === removedIndex)
            continue;
        shifted[index > removedIndex ? index - 1 : index] = value;
    }
    return shifted;
}
function formatUsageAmount(value) {
    return value === undefined ? undefined : value.toLocaleString("en-US");
}
export function formatResetIn(seconds) {
    if (seconds <= 0)
        return "now";
    const days = Math.floor(seconds / 86_400);
    const hours = Math.floor((seconds % 86_400) / 3_600);
    const minutes = Math.ceil((seconds % 3_600) / 60);
    if (days > 0)
        return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
    if (hours > 0)
        return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    return minutes > 0 ? `${minutes}m` : "less than 1m";
}
function formatUsageWindow(window, index) {
    const label = window.name ?? `window ${index + 1}`;
    const details = [`${label}: ${window.status}`];
    const used = formatUsageAmount(window.used);
    const limit = formatUsageAmount(window.limit);
    const remaining = formatUsageAmount(window.remaining);
    if (window.usagePercent !== undefined)
        details.push(`${Math.round(window.usagePercent)}% used`);
    if (used !== undefined && limit !== undefined)
        details.push(`${used}/${limit} used`);
    else if (used !== undefined)
        details.push(`${used} used`);
    if (remaining !== undefined)
        details.push(`${remaining} remaining`);
    if (window.resetInSec !== undefined)
        details.push(`resets in ${formatResetIn(window.resetInSec)}`);
    else if (window.resetAt)
        details.push(`resets ${window.resetAt}`);
    else if (window.endAt)
        details.push(`ends ${window.endAt}`);
    return details.join("; ");
}
export function formatUsageStatus(result) {
    if (!result.ok) {
        return `OpenCode usage unavailable${result.keyName ? ` for ${result.keyName}` : ""}: ${result.message}`;
    }
    if (result.usage.windows.length === 0)
        return `OpenCode usage for ${result.keyName}: no usage windows returned.`;
    return [`OpenCode usage for ${result.keyName}:`, ...result.usage.windows.map(formatUsageWindow)].join("\n");
}
function formatStatus(config, now = Date.now()) {
    const watchdogStatus = `Watchdog: ${config.watchdogEnabled ? "on" : "off"} (${Math.ceil(getWatchdogIdleMs(config) / 1000)}s idle)`;
    if (config.keys.length === 0) {
        return `No keys configured. Use /opencode add <name> <key>.\n${watchdogStatus}`;
    }
    const cdMs = getCooldownMs(config);
    return `${config.keys.map((key, i) => {
        const marker = i === config.activeKeyIndex ? "→" : " ";
        const cooldownStart = config.cooldowns[i];
        let tag = "";
        const quotaReset = getQuotaBlockedUntil(config, i, now);
        if (quotaReset !== undefined) {
            tag = ` [quota-blocked ${formatResetIn(Math.ceil((quotaReset - now) / 1000))}]`;
        }
        else if (cooldownStart !== undefined) {
            const remaining = cdMs - (now - cooldownStart);
            if (remaining > 0)
                tag = ` [cooldown ${Math.ceil(remaining / 60_000)}m]`;
        }
        return `${marker} ${i + 1}. ${key.name}${tag}`;
    }).join("\n")}\n${watchdogStatus}`;
}
function formatDuration(ms) {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    if (seconds < 60)
        return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}
function formatTimeoutInfo(info) {
    const status = info.lastStatus === undefined ? "" : `, last HTTP ${info.lastStatus}`;
    return `${info.phase.replaceAll("-", " ")} stalled after ${formatDuration(info.elapsedMs)} (${formatDuration(info.idleForMs)} idle${status})`;
}
function formatWatchdogEvents(events, now = Date.now()) {
    if (events.length === 0)
        return "No OpenCode Go watchdog timeouts recorded this session.";
    return events
        .slice()
        .reverse()
        .map((event, index) => {
        const age = formatDuration(now - event.time);
        const key = event.keyName ? ` key=${event.keyName}` : "";
        const rotation = event.rotatedTo ? ` rotated=${event.rotatedTo}` : event.activeKey ? ` using=${event.activeKey}` : " rotated=none";
        const status = event.lastStatus === undefined ? "" : ` status=${event.lastStatus}`;
        return `${index + 1}. ${age} ago ${event.phase.replaceAll("-", " ")}${status}${key}${rotation} elapsed=${formatDuration(event.elapsedMs)} idle=${formatDuration(event.idleForMs)}`;
    })
        .join("\n");
}
// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------
export function createOpencodeGoRotationExtension(options = {}) {
    return function opencodeGoRotationExtension(pi) {
        let config = createEmptyConfig();
        let configError;
        let watchdog;
        let watchdogAbortPending = false;
        let watchdogAbortMessage;
        let watchdogTimeoutInfo;
        let watchdogRequestTimedOut = false;
        let usageDecisionEpoch = 0;
        let requestRateLimitState;
        const watchdogEvents = [];
        const now = () => options.clock?.now() ?? Date.now();
        const fetchApi = options.fetch ?? globalThis.fetch.bind(globalThis);
        function formatConfigError(error) {
            if (error instanceof ConfigLoadError)
                return error.message;
            if (error instanceof Error)
                return error.message;
            return "Unknown configuration error";
        }
        function refreshConfig() {
            try {
                config = loadConfig();
                configError = undefined;
                return true;
            }
            catch (error) {
                configError = formatConfigError(error);
                return false;
            }
        }
        function mutateSharedConfig(mutator) {
            try {
                const updated = updateConfig(mutator);
                config = updated.config;
                configError = undefined;
                return updated.result;
            }
            catch (error) {
                configError = formatConfigError(error);
                return undefined;
            }
        }
        function ensureConfig(ctx) {
            if (refreshConfig())
                return true;
            ctx.ui.notify(`OpenCode: ${configError}. No configuration was changed.`, "error");
            return false;
        }
        function applySynchronizedActiveKey(ctx) {
            if (!refreshConfig())
                return undefined;
            const availableIndex = pickAvailableKeyIndex(config, now());
            if (availableIndex !== undefined && availableIndex !== config.activeKeyIndex) {
                const selectedIndex = mutateSharedConfig((freshConfig) => {
                    const freshAvailableIndex = pickAvailableKeyIndex(freshConfig, now());
                    if (freshAvailableIndex !== undefined)
                        freshConfig.activeKeyIndex = freshAvailableIndex;
                    return freshAvailableIndex;
                });
                if (selectedIndex === undefined)
                    return undefined;
            }
            return applyActiveKey(config, ctx.modelRegistry, now());
        }
        function invalidateAutomaticDecisions() {
            usageDecisionEpoch++;
        }
        function beginProviderRequest(ctx) {
            invalidateAutomaticDecisions();
            if (applySynchronizedActiveKey(ctx) === undefined) {
                requestRateLimitState = undefined;
                return;
            }
            const decision = captureUsageDecision(config, usageDecisionEpoch);
            requestRateLimitState = decision ? { decision, responseHandled: false } : undefined;
        }
        function getCurrentRequestRateLimitState() {
            if (!requestRateLimitState)
                return undefined;
            return isValidUsageDecisionTarget(requestRateLimitState.decision, config, usageDecisionEpoch)
                ? requestRateLimitState
                : undefined;
        }
        function markResponseRateLimitHandled(decision) {
            requestRateLimitState = {
                decision: { ...decision, epoch: usageDecisionEpoch },
                responseHandled: true,
            };
        }
        /**
         * A benched key can become usable again after we recorded its block. Before concluding
         * that every key is exhausted, re-check the blocked keys and release the ones the usage
         * endpoint no longer reports as rate-limited.
         */
        async function releaseRecoveredQuotaBlocks(ctx, currentTime, skipKeyIndex) {
            const targets = getQuotaBlockedTargets(config, currentTime, skipKeyIndex);
            let released = false;
            for (const target of targets) {
                const usage = await fetchOpenCodeGoUsage(target, fetchApi, options.timers);
                if (!refreshConfig())
                    return released;
                if (!hasConfirmedHeadroom(usage))
                    continue;
                const cleared = mutateSharedConfig((freshConfig) => {
                    const entry = freshConfig.keys[target.keyIndex];
                    if (!entry || entry.key !== target.bearerToken)
                        return false;
                    if (getQuotaBlockedUntil(freshConfig, target.keyIndex, currentTime) === undefined)
                        return false;
                    delete freshConfig.quotaBlockedUntil[target.keyIndex];
                    delete freshConfig.cooldowns[target.keyIndex];
                    return true;
                });
                if (cleared !== true)
                    continue;
                released = true;
                ctx.ui.notify(`OpenCode: ${target.keyName} has headroom again → quota block cleared`, "info");
            }
            return released;
        }
        /**
         * Rotate to a different key, re-verifying benched keys first. `undefined` means no
         * rotation happened, so the caller must not report one.
         */
        async function rotateAfterRevalidation(ctx, currentTime) {
            const previousIndex = config.activeKeyIndex;
            let nextIndex = mutateSharedConfig((freshConfig) => rotateToNextKey(freshConfig, { now: currentTime }));
            if (nextIndex === undefined || nextIndex === previousIndex) {
                if (await releaseRecoveredQuotaBlocks(ctx, currentTime, previousIndex)) {
                    nextIndex = mutateSharedConfig((freshConfig) => rotateToNextKey(freshConfig, { now: currentTime }));
                }
            }
            return nextIndex === previousIndex ? undefined : nextIndex;
        }
        async function rotateForQuotaExhaustion(ctx, keyIndex, blockedUntil, currentTime, isAuthoritative = false) {
            const exhaustedName = config.keys[keyIndex]?.name || `key-${keyIndex + 1}`;
            let nextIndex = mutateSharedConfig((freshConfig) => blockQuotaAndSelectNext(freshConfig, keyIndex, blockedUntil, currentTime, isAuthoritative));
            if (nextIndex === undefined && (await releaseRecoveredQuotaBlocks(ctx, currentTime, keyIndex))) {
                nextIndex = mutateSharedConfig((freshConfig) => blockQuotaAndSelectNext(freshConfig, keyIndex, blockedUntil, currentTime, isAuthoritative));
            }
            if (nextIndex === undefined) {
                if (configError) {
                    ctx.ui.notify(`OpenCode: ${configError}. Automatic rotation was skipped.`, "error");
                    return;
                }
                invalidateAutomaticDecisions();
                const earliestReset = getEarliestQuotaReset(config, currentTime);
                const reset = earliestReset === undefined
                    ? "an unknown reset time"
                    : formatResetIn(Math.ceil((earliestReset - currentTime) / 1000));
                ctx.ui.notify(`OpenCode: ${exhaustedName} reached its plan quota; all configured keys are quota-blocked. Earliest reset in ${reset}.`, "warning");
                return;
            }
            invalidateAutomaticDecisions();
            const keyName = applyActiveKey(config, ctx.modelRegistry, currentTime) ?? `key-${nextIndex + 1}`;
            ctx.ui.notify(`OpenCode: ${exhaustedName} reached its plan quota → rotated to ${keyName}`, "info");
        }
        function stopWatchdog() {
            const timeoutInfo = watchdog?.consumeTimeoutInfo();
            watchdog?.stop();
            watchdog = undefined;
            return timeoutInfo;
        }
        function resetWatchdogAbortState() {
            watchdogAbortPending = false;
            watchdogAbortMessage = undefined;
            watchdogTimeoutInfo = undefined;
        }
        function clearWatchdogTimeoutGuard() {
            watchdogRequestTimedOut = false;
        }
        function recordWatchdogEvent(event) {
            watchdogEvents.push(event);
            while (watchdogEvents.length > 10)
                watchdogEvents.shift();
        }
        function rotateForWatchdog(ctx, timeoutInfo, rateLimitAlreadyRotated) {
            if (!refreshConfig())
                return { rotated: false };
            const currentTime = now();
            if (config.keys.length <= 1)
                return { rotated: false };
            if (shouldRotateAfterWatchdogTimeout(timeoutInfo, rateLimitAlreadyRotated)) {
                const previousIndex = config.activeKeyIndex;
                const nextIndex = mutateSharedConfig((freshConfig) => rotateToNextKey(freshConfig, { now: currentTime }));
                if (nextIndex === undefined)
                    return { keyName: applyActiveKey(config, ctx.modelRegistry, currentTime), rotated: false };
                const rotated = nextIndex !== previousIndex;
                if (rotated)
                    invalidateAutomaticDecisions();
                return { keyName: applyActiveKey(config, ctx.modelRegistry, currentTime), rotated };
            }
            return { keyName: applyActiveKey(config, ctx.modelRegistry, currentTime), rotated: false };
        }
        function startWatchdog(ctx) {
            if (!refreshConfig())
                return;
            applyActiveKey(config, ctx.modelRegistry, now());
            stopWatchdog();
            resetWatchdogAbortState();
            clearWatchdogTimeoutGuard();
            if (!config.watchdogEnabled)
                return;
            const idleMs = getWatchdogIdleMs(config);
            watchdog = new ProviderIdleWatchdog({
                idleMs,
                onTimeout: () => {
                    const rateLimitAlreadyHandled = getCurrentRequestRateLimitState()?.responseHandled ?? false;
                    invalidateAutomaticDecisions();
                    watchdogRequestTimedOut = true;
                    const timeoutInfo = watchdog?.currentTimeoutInfo() ?? {
                        phase: "waiting-for-response",
                        idleMs,
                        elapsedMs: idleMs,
                        idleForMs: idleMs,
                    };
                    const previousKey = config.keys[config.activeKeyIndex]?.name;
                    const rotation = rotateForWatchdog(ctx, timeoutInfo, rateLimitAlreadyHandled);
                    watchdogTimeoutInfo = timeoutInfo;
                    recordWatchdogEvent({
                        time: now(),
                        keyName: previousKey,
                        rotatedTo: rotation.rotated ? rotation.keyName : undefined,
                        activeKey: rotation.keyName,
                        ...timeoutInfo,
                    });
                    watchdogAbortPending = true;
                    watchdogAbortMessage = rotation.keyName
                        ? `OpenCode Go timeout: ${formatTimeoutInfo(timeoutInfo)}; ${rotation.rotated ? "rotated to" : "using"} ${rotation.keyName}; retrying.`
                        : `OpenCode Go timeout: ${formatTimeoutInfo(timeoutInfo)}; no other key available.`;
                    ctx.ui.notify(watchdogAbortMessage, rotation.keyName ? "info" : "warning");
                    ctx.abort();
                },
                timers: options.timers,
                clock: options.clock,
            });
            watchdog.start();
        }
        async function autoImportFromAuth(ctx) {
            const authKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
            if (!authKey)
                return false;
            const imported = mutateSharedConfig((freshConfig) => {
                if (freshConfig.keys.some((entry) => entry.key === authKey))
                    return false;
                freshConfig.keys.push({ name: "auth", key: authKey });
                return true;
            });
            return imported === true;
        }
        pi.on("session_start", async (event, ctx) => {
            lastAppliedRuntimeKeys.delete(ctx.modelRegistry);
            invalidateAutomaticDecisions();
            requestRateLimitState = undefined;
            clearWatchdogTimeoutGuard();
            if (!ensureConfig(ctx))
                return;
            // A block recorded in an earlier session can be stale: the plan was topped up, or the
            // window reset before the deadline we stored. Re-check before it decides which key this
            // session uses, rather than benching a key that is usable again -- or leaving every key
            // held by a block with nothing left to rotate to.
            if (config.keys.length > 0) {
                const activeBlocked = getQuotaBlockedUntil(config, config.activeKeyIndex, now()) !== undefined;
                if (activeBlocked || pickAvailableKeyIndex(config, now()) === undefined) {
                    await releaseRecoveredQuotaBlocks(ctx, now());
                }
            }
            // On reload: re-apply active key, skip auto-import
            if (event.reason === "reload") {
                const keyName = applySynchronizedActiveKey(ctx);
                if (keyName)
                    ctx.ui.notify(`OpenCode: Active key → ${keyName}`, "info");
                return;
            }
            if (config.keys.length === 0) {
                if (await autoImportFromAuth(ctx)) {
                    const keyName = applySynchronizedActiveKey(ctx);
                    if (keyName)
                        ctx.ui.notify(`OpenCode: Imported key from auth.json → ${keyName}`, "info");
                }
                else if (configError) {
                    ctx.ui.notify(`OpenCode: ${configError}.`, "error");
                    return;
                }
                else {
                    ctx.ui.notify("OpenCode: No keys configured. Use /opencode add <name> <key>", "warning");
                    return;
                }
            }
            const keyName = applySynchronizedActiveKey(ctx);
            if (keyName)
                ctx.ui.notify(`OpenCode: Active key → ${keyName}`, "info");
        });
        pi.on("before_provider_request", (event, ctx) => {
            if (!shouldWatchProvider(ctx.model?.provider)) {
                invalidateAutomaticDecisions();
                requestRateLimitState = undefined;
                stopWatchdog();
                resetWatchdogAbortState();
                clearWatchdogTimeoutGuard();
                return;
            }
            beginProviderRequest(ctx);
            startWatchdog(ctx);
            return sanitizeReasoningPayload(event.payload);
        });
        pi.on("message_update", (event) => {
            const message = event.message;
            if (message.role !== "assistant" || !shouldWatchProvider(message.provider))
                return;
            watchdog?.streamActivity();
        });
        pi.on("message_end", async (event, ctx) => {
            const message = event.message;
            if (message.role !== "assistant" || message.provider !== PROVIDER)
                return;
            const timeoutInfo = stopWatchdog() ?? watchdogTimeoutInfo;
            if (timeoutInfo || watchdogAbortPending) {
                const errorMessage = watchdogAbortMessage ?? `OpenCode Go timeout: ${timeoutInfo ? formatTimeoutInfo(timeoutInfo) : "no provider activity"}; retrying.`;
                resetWatchdogAbortState();
                return {
                    message: {
                        ...message,
                        stopReason: "error",
                        errorMessage,
                    },
                };
            }
            if (message.stopReason !== "error") {
                invalidateAutomaticDecisions();
                return;
            }
            const rateLimitKind = classifyRateLimitError(message.errorMessage ?? "");
            if (!rateLimitKind) {
                invalidateAutomaticDecisions();
                return;
            }
            if (!refreshConfig())
                return;
            const requestState = getCurrentRequestRateLimitState();
            if (!requestState)
                return;
            if (rateLimitKind === "fixed-window-quota") {
                const currentTime = now();
                const authoritativeReset = parseFixedWindowQuotaReset(message.errorMessage ?? "", currentTime);
                const blockedUntil = authoritativeReset ?? currentTime + getCooldownMs(config);
                if (requestState.responseHandled) {
                    const persisted = mutateSharedConfig((freshConfig) => {
                        if (authoritativeReset === undefined) {
                            setQuotaBlock(freshConfig, requestState.decision.target.keyIndex, blockedUntil, currentTime);
                        }
                        else {
                            freshConfig.quotaBlockedUntil[requestState.decision.target.keyIndex] = authoritativeReset;
                        }
                        return true;
                    });
                    if (persisted !== true && configError)
                        ctx.ui.notify(`OpenCode: ${configError}.`, "error");
                    invalidateAutomaticDecisions();
                    return;
                }
                await rotateForQuotaExhaustion(ctx, requestState.decision.target.keyIndex, blockedUntil, currentTime, authoritativeReset !== undefined);
                return;
            }
            if (requestState.responseHandled) {
                invalidateAutomaticDecisions();
                return;
            }
            if (config.keys.length <= 1) {
                invalidateAutomaticDecisions();
                ctx.ui.notify("OpenCode: Rate limited — no other keys to rotate to.", "warning");
                return;
            }
            const currentTime = now();
            const newIndex = await rotateAfterRevalidation(ctx, currentTime);
            if (newIndex === undefined) {
                if (configError)
                    ctx.ui.notify(`OpenCode: ${configError}. Automatic rotation was skipped.`, "error");
                else {
                    invalidateAutomaticDecisions();
                    ctx.ui.notify("OpenCode: Rate limited; all other keys are quota-blocked.", "warning");
                }
                return;
            }
            invalidateAutomaticDecisions();
            const keyName = applyActiveKey(config, ctx.modelRegistry, currentTime);
            ctx.ui.notify(`OpenCode: Rate-limited → rotated to ${keyName ?? `key-${newIndex + 1}`}`, "info");
        });
        pi.on("after_provider_response", async (event, ctx) => {
            if (ctx.model?.provider !== PROVIDER)
                return;
            watchdog?.response(event.status);
            if (event.status !== 429 && event.status !== 401)
                return;
            if (watchdogRequestTimedOut)
                return;
            if (!refreshConfig())
                return;
            const decision = getCurrentRequestRateLimitState()?.decision;
            if (!decision)
                return;
            if (event.status === 401)
                requestRateLimitState = undefined;
            const usage = await fetchOpenCodeGoUsage(decision.target, fetchApi, options.timers);
            if (!refreshConfig())
                return;
            if (!isCurrentUsageDecision(decision, config, usageDecisionEpoch))
                return;
            if (usage.ok && hasRateLimitedUsageWindow(usage)) {
                const currentTime = now();
                await rotateForQuotaExhaustion(ctx, decision.target.keyIndex, getRateLimitedUntil(usage.usage, currentTime, getCooldownMs(config)), currentTime);
                if (event.status === 429)
                    markResponseRateLimitHandled(decision);
                ctx.ui.notify(formatUsageStatus(usage), "warning");
                return;
            }
            if (event.status === 401)
                return;
            if (config.keys.length <= 1) {
                markResponseRateLimitHandled(decision);
                return;
            }
            const currentTime = now();
            const newIndex = await rotateAfterRevalidation(ctx, currentTime);
            if (newIndex === undefined) {
                if (configError)
                    ctx.ui.notify(`OpenCode: ${configError}. Automatic rotation was skipped.`, "error");
                else {
                    invalidateAutomaticDecisions();
                    markResponseRateLimitHandled(decision);
                    ctx.ui.notify("OpenCode: HTTP 429; all other keys are quota-blocked.", "warning");
                }
                return;
            }
            invalidateAutomaticDecisions();
            markResponseRateLimitHandled(decision);
            const keyName = applyActiveKey(config, ctx.modelRegistry, currentTime);
            ctx.ui.notify(`OpenCode: Proactive rate-limit detection (HTTP 429) → rotated to ${keyName ?? `key-${newIndex + 1}`}`, "info");
        });
        pi.registerCommand("opencode", {
            description: "Manage OpenCode API key rotation",
            handler: async (args, ctx) => {
                if (!ensureConfig(ctx))
                    return;
                const parts = args.trim().split(/\s+/);
                const subcommand = parts[0] || "status";
                const indexArg = parseInt(parts[1] ?? "", 10);
                switch (subcommand) {
                    case "status":
                    case "list":
                    case "ls": {
                        const status = formatStatus(config, now());
                        ctx.ui.notify(status, "info");
                        break;
                    }
                    case "events":
                    case "timeouts": {
                        ctx.ui.notify(formatWatchdogEvents(watchdogEvents, now()), "info");
                        break;
                    }
                    case "usage":
                    case "quota": {
                        applySynchronizedActiveKey(ctx);
                        const usage = await fetchOpenCodeGoUsage(getActiveUsageTarget(config), fetchApi, options.timers);
                        ctx.ui.notify(formatUsageStatus(usage), usage.ok ? "info" : "warning");
                        break;
                    }
                    case "use": {
                        const targetIndex = indexArg - 1;
                        invalidateAutomaticDecisions();
                        const result = mutateSharedConfig((freshConfig) => {
                            if (isNaN(targetIndex) || targetIndex < 0 || targetIndex >= freshConfig.keys.length) {
                                return { error: `Invalid index. Use 1-${freshConfig.keys.length}.` };
                            }
                            freshConfig.activeKeyIndex = targetIndex;
                            delete freshConfig.cooldowns[targetIndex];
                            delete freshConfig.quotaBlockedUntil[targetIndex];
                            return { index: targetIndex };
                        });
                        if (!result) {
                            if (configError)
                                ctx.ui.notify(`OpenCode: ${configError}.`, "error");
                            return;
                        }
                        if ("error" in result && typeof result.error === "string") {
                            ctx.ui.notify(result.error, "warning");
                            return;
                        }
                        const keyName = applyActiveKey(config, ctx.modelRegistry, now());
                        ctx.ui.notify(`Switched to ${keyName}`, "info");
                        break;
                    }
                    case "next": {
                        invalidateAutomaticDecisions();
                        const result = mutateSharedConfig((freshConfig) => {
                            if (freshConfig.keys.length === 0)
                                return { error: "No keys configured. Use /opencode add <name> <key>." };
                            freshConfig.activeKeyIndex = (freshConfig.activeKeyIndex + 1) % freshConfig.keys.length;
                            delete freshConfig.cooldowns[freshConfig.activeKeyIndex];
                            delete freshConfig.quotaBlockedUntil[freshConfig.activeKeyIndex];
                            return { index: freshConfig.activeKeyIndex };
                        });
                        if (!result) {
                            if (configError)
                                ctx.ui.notify(`OpenCode: ${configError}.`, "error");
                            return;
                        }
                        if ("error" in result && typeof result.error === "string") {
                            ctx.ui.notify(result.error, "warning");
                            return;
                        }
                        const keyName = applyActiveKey(config, ctx.modelRegistry, now());
                        ctx.ui.notify(`Switched to ${keyName}`, "info");
                        break;
                    }
                    case "add": {
                        const name = parts[1];
                        const key = parts[2];
                        if (!name || !key) {
                            ctx.ui.notify("Usage: /opencode add <name> <key>", "warning");
                            return;
                        }
                        invalidateAutomaticDecisions();
                        const count = mutateSharedConfig((freshConfig) => {
                            freshConfig.keys.push({ name, key });
                            if (freshConfig.keys.length === 1)
                                freshConfig.activeKeyIndex = 0;
                            return freshConfig.keys.length;
                        });
                        if (count === undefined) {
                            if (configError)
                                ctx.ui.notify(`OpenCode: ${configError}.`, "error");
                            return;
                        }
                        if (count === 1)
                            applyActiveKey(config, ctx.modelRegistry, now());
                        ctx.ui.notify(`Added "${name}" (${count} keys)`, "info");
                        break;
                    }
                    case "remove":
                    case "rm": {
                        const removeIndex = indexArg - 1;
                        invalidateAutomaticDecisions();
                        const result = mutateSharedConfig((freshConfig) => {
                            if (isNaN(removeIndex) || removeIndex < 0 || removeIndex >= freshConfig.keys.length) {
                                return { error: `Invalid index. Use 1-${freshConfig.keys.length}.` };
                            }
                            const removed = freshConfig.keys.splice(removeIndex, 1)[0];
                            freshConfig.cooldowns = reindexAfterRemoval(freshConfig.cooldowns, removeIndex);
                            freshConfig.quotaBlockedUntil = reindexAfterRemoval(freshConfig.quotaBlockedUntil, removeIndex);
                            if (freshConfig.activeKeyIndex >= freshConfig.keys.length)
                                freshConfig.activeKeyIndex = 0;
                            else if (removeIndex < freshConfig.activeKeyIndex)
                                freshConfig.activeKeyIndex--;
                            return { removedName: removed.name, count: freshConfig.keys.length };
                        });
                        if (!result) {
                            if (configError)
                                ctx.ui.notify(`OpenCode: ${configError}.`, "error");
                            return;
                        }
                        if ("error" in result && typeof result.error === "string") {
                            ctx.ui.notify(result.error, "warning");
                            return;
                        }
                        if (config.keys.length > 0)
                            applyActiveKey(config, ctx.modelRegistry, now());
                        else {
                            lastAppliedRuntimeKeys.delete(ctx.modelRegistry);
                            ignoreAsyncRefresh(getRuntimeKeyStore(ctx.modelRegistry).removeRuntimeApiKey(PROVIDER));
                        }
                        ctx.ui.notify(`Removed "${result.removedName}" (${result.count} left)`, "info");
                        break;
                    }
                    case "reset": {
                        invalidateAutomaticDecisions();
                        const result = mutateSharedConfig((freshConfig) => {
                            freshConfig.cooldowns = {};
                            freshConfig.quotaBlockedUntil = {};
                            return true;
                        });
                        if (result !== true) {
                            if (configError)
                                ctx.ui.notify(`OpenCode: ${configError}.`, "error");
                            return;
                        }
                        ctx.ui.notify("All cooldowns and quota blocks cleared", "info");
                        break;
                    }
                    case "cooldown": {
                        const minutes = parseInt(parts[1], 10);
                        if (isNaN(minutes) || minutes < 1) {
                            ctx.ui.notify(`Cooldown: ${config.cooldownMinutes || DEFAULT_COOLDOWN_MINUTES} min`, "info");
                            return;
                        }
                        const result = mutateSharedConfig((freshConfig) => {
                            freshConfig.cooldownMinutes = minutes;
                            return true;
                        });
                        if (result !== true) {
                            if (configError)
                                ctx.ui.notify(`OpenCode: ${configError}.`, "error");
                            return;
                        }
                        ctx.ui.notify(`Cooldown set to ${minutes} min`, "info");
                        break;
                    }
                    case "watchdog": {
                        const value = parts[1];
                        if (!value || value === "status") {
                            const events = formatWatchdogEvents(watchdogEvents, now());
                            ctx.ui.notify(`Watchdog: ${config.watchdogEnabled ? "on" : "off"} (${Math.ceil(getWatchdogIdleMs(config) / 1000)}s idle)\n${events}`, "info");
                            return;
                        }
                        if (value === "on" || value === "off") {
                            const enabled = value === "on";
                            const result = mutateSharedConfig((freshConfig) => {
                                freshConfig.watchdogEnabled = enabled;
                                return true;
                            });
                            if (result !== true) {
                                if (configError)
                                    ctx.ui.notify(`OpenCode: ${configError}.`, "error");
                                return;
                            }
                            if (!enabled) {
                                stopWatchdog();
                                resetWatchdogAbortState();
                            }
                            ctx.ui.notify(enabled ? `Watchdog enabled (${Math.ceil(getWatchdogIdleMs(config) / 1000)}s idle)` : "Watchdog disabled", "info");
                            return;
                        }
                        const seconds = parseInt(value, 10);
                        if (isNaN(seconds) || seconds < 1) {
                            ctx.ui.notify("Usage: /opencode watchdog [status|on|off|<seconds>]", "warning");
                            return;
                        }
                        const result = mutateSharedConfig((freshConfig) => {
                            freshConfig.watchdogEnabled = true;
                            freshConfig.watchdogIdleMs = seconds * 1000;
                            return true;
                        });
                        if (result !== true) {
                            if (configError)
                                ctx.ui.notify(`OpenCode: ${configError}.`, "error");
                            return;
                        }
                        ctx.ui.notify(`Watchdog enabled (${seconds}s idle)`, "info");
                        break;
                    }
                    default:
                        ctx.ui.notify("Usage: /opencode [status|usage|quota|events|use <n>|next|add <name> <key>|rm <n>|reset|cooldown <min>|watchdog [status|on|off|<seconds>]]", "info");
                }
            },
        });
        function cleanupLifecycleState() {
            invalidateAutomaticDecisions();
            requestRateLimitState = undefined;
            stopWatchdog();
            resetWatchdogAbortState();
            clearWatchdogTimeoutGuard();
        }
        pi.on("agent_end", () => {
            cleanupLifecycleState();
        });
        pi.on("session_shutdown", () => {
            cleanupLifecycleState();
        });
    };
}
const extension = createOpencodeGoRotationExtension();
export default extension;
