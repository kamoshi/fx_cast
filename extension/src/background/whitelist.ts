import logger from "../lib/logger";
import options from "../lib/options";

import { cacheUaInfo, getChromeUserAgentString } from "../lib/userAgents";
import { RemoteMatchPattern } from "../lib/matchPattern";

import { CAST_SDK_SCRIPT_URL_PATTERNS } from "../cast/urls";

// Missing on @types/firefox-webext-browser
type OnBeforeSendHeadersDetails = Parameters<
    Parameters<typeof browser.webRequest.onBeforeSendHeaders.addListener>[0]
>[0] & {
    frameAncestors?: Array<{ url: string; frameId: number }>;
};
type OnBeforeRequestDetails = Parameters<
    Parameters<typeof browser.webRequest.onBeforeRequest.addListener>[0]
>[0] & {
    frameAncestors?: Array<{ url: string; frameId: number }>;
};

export interface WhitelistItemData {
    pattern: string;
    isEnabled: boolean;
    isUserAgentDisabled?: boolean;
    customUserAgent?: string;
}

let matchPatterns: RemoteMatchPattern[] = [];

let platform: string;
let chromeUserAgent: string | undefined;
let chromeUserAgentHybrid: string | undefined;

let siteWhitelistEnabled = false;
let siteWhitelist: Nullable<WhitelistItemData[]> = null;
let customUserAgent: string | undefined;

export async function initWhitelist() {
    logger.info("init (whitelist)");

    await cacheUaInfo();

    if (!platform) {
        const browserInfo = await browser.runtime.getBrowserInfo();

        // TODO: Allow hybrid UA to be configurable
        platform = (await browser.runtime.getPlatformInfo()).os;
        chromeUserAgent = await getChromeUserAgentString(platform);
        chromeUserAgentHybrid = await getChromeUserAgentString(platform, {
            hybridFirefoxVersion: browserInfo.version
        });
        if (!chromeUserAgent) {
            throw logger.error("Failed to get Chrome UA string");
        }

        customUserAgent = await options.get("siteWhitelistCustomUserAgent");
    }

    // Register on first run
    await registerSiteWhitelist();

    options.addEventListener("changed", async ev => {
        // Update custom UA on change
        if (ev.detail.includes("siteWhitelistCustomUserAgent")) {
            customUserAgent = await options.get("siteWhitelistCustomUserAgent");
        }
        // Re-register whitelist on change
        if (
            ev.detail.includes("siteWhitelist") ||
            ev.detail.includes("siteWhitelistEnabled")
        ) {
            unregisterSiteWhitelist();
            registerSiteWhitelist();
        }
    });
}

/**
 * Returns the configured user agent matching the specified URL or
 * undefined if the user agent is disabled.
 */
function getUserAgent(url: string, host?: string): Optional<string> {
    if (!siteWhitelistEnabled || !siteWhitelist) return;

    // Search site-specific user agents
    const matchingItem = siteWhitelist.find(
        item =>
            item.customUserAgent &&
            new RemoteMatchPattern(item.pattern).matches(url)
    );
    if (matchingItem) {
        if (!matchingItem.isEnabled || matchingItem.isUserAgentDisabled) return;
        return matchingItem.customUserAgent;
    }

    return (
        customUserAgent ||
        (host === "www.youtube.com" ? chromeUserAgentHybrid : chromeUserAgent)
    );
}

/**
 * Override User-Agent header for requests to whitelisted URLs. Sites
 * with Chromecast support will usually only load the Cast SDK if they
 * detect a Chrome user agent string.
 */
async function onWhitelistedBeforeSendHeaders(
    details: OnBeforeSendHeadersDetails
) {
    if (!details.requestHeaders) {
        throw logger.error(
            "OnBeforeSendHeaders handler details missing requestHeaders."
        );
    }

    const host = new URL(details.url).hostname;
    const userAgent = getUserAgent(details.url, host);
    let didSetUserAgent = false;

    for (const header of details.requestHeaders) {
        if (header.name === "User-Agent") {
            header.value = userAgent;
            didSetUserAgent = true;
            break;
        }
    }

    if (details.type === "main_frame" && host === "www.youtube.com") {
        logger.info("Applying YouTube user-agent override", {
            url: details.url,
            userAgent,
            didSetUserAgent
        });
    }

    return {
        requestHeaders: details.requestHeaders
    };
}

/**
 * Override User-Agent header for requests from child frames of
 * whitelisted URLs to support embedded players on other origins (e.g.
 * CDN domains).
 */
function onWhitelistedChildBeforeSendHeaders(
    details: OnBeforeSendHeadersDetails
) {
    if (!details.requestHeaders || !details.frameAncestors) {
        return;
    }

    for (const ancestor of details.frameAncestors) {
        // If no matching patterns
        if (!matchPatterns.some(pattern => pattern.matches(ancestor.url))) {
            continue;
        }

        // Override User-Agent header
        const requestHeaders = details.requestHeaders;
        for (const header of requestHeaders) {
            if (header.name === "User-Agent") {
                const host = new URL(details.url).hostname;
                header.value = getUserAgent(details.url, host);
                break;
            }
        }

        return { requestHeaders };
    }
}

/**
 * Handle requests to cast_sender.js SDK loader script and redirect to
 * the extension's implementation.
 */
async function onBeforeCastSDKRequest(details: OnBeforeRequestDetails) {
    if (!details.originUrl || details.tabId === -1) {
        logger.info("Cast SDK request ignored: missing origin or tab", {
            tabId: details.tabId,
            frameId: details.frameId,
            originUrl: details.originUrl
        });
        return {};
    }

    // Test against whitelist if enabled
    if (await options.get("siteWhitelistEnabled")) {
        /**
         * Frame ancestor URLs (if present) or origin URL that the SDK
         * is loaded from.
         */
        const urls = [
            ...(details.frameAncestors?.map(ancestor => ancestor.url) ?? []),
            details.originUrl
        ];

        // Allow request if no whitelist matches
        const isWhitelisted = urls.some(url =>
            matchPatterns.some(pattern => pattern.matches(url))
        );
        if (!isWhitelisted) {
            logger.info("Cast SDK request not redirected: origin not whitelisted", {
                tabId: details.tabId,
                frameId: details.frameId,
                originUrl: details.originUrl,
                frameAncestors: details.frameAncestors?.map(item => item.url)
            });
            return {};
        }
    }

    /**
     * The Cast Framework loader builds on top of the Base API shim. Let
     * Google's loader fetch the framework, then intercept its lower-level
     * cast_sender.js request separately.
     */
    const requestUrl = new URL(details.url);
    if (requestUrl.searchParams.get("loadCastFramework") === "1") {
        logger.info("Allowing Google Cast Framework loader", {
            tabId: details.tabId,
            frameId: details.frameId,
            originUrl: details.originUrl,
            requestUrl: details.url
        });
        return {};
    }

    logger.info("Redirecting Cast SDK request to extension sender", {
        tabId: details.tabId,
        frameId: details.frameId,
        originUrl: details.originUrl,
        requestUrl: details.url
    });

    await browser.scripting.executeScript({
        target: { tabId: details.tabId, frameIds: [details.frameId] },
        files: ["cast/contentBridge.js"],
        injectImmediately: true
    });

    return {
        redirectUrl: browser.runtime.getURL("cast/content.js")
    };
}

async function registerSiteWhitelist() {
    const opts = await options.getAll();
    siteWhitelist = opts.siteWhitelist;
    siteWhitelistEnabled = opts.siteWhitelistEnabled;

    logger.info("Registering site whitelist", {
        enabled: siteWhitelistEnabled,
        patterns: siteWhitelist.map(item => ({
            pattern: item.pattern,
            enabled: item.isEnabled
        }))
    });

    // Parse match patterns once
    matchPatterns = siteWhitelist.map(
        item => new RemoteMatchPattern(item.pattern)
    );

    browser.webRequest.onBeforeRequest.addListener(
        onBeforeCastSDKRequest,
        { urls: CAST_SDK_SCRIPT_URL_PATTERNS },
        ["blocking"]
    );

    // Skip whitelist request listeners if disabled or empty
    if (!siteWhitelistEnabled || !siteWhitelist.length) {
        logger.info("Whitelist content scripts and user-agent overrides disabled");
        return;
    }

    browser.webRequest.onBeforeSendHeaders.addListener(
        onWhitelistedBeforeSendHeaders,
        {
            // Filter for items with UA enabled
            urls: siteWhitelist.flatMap(item =>
                item.isEnabled && !item.isUserAgentDisabled
                    ? [item.pattern]
                    : []
            )
        },
        ["blocking", "requestHeaders"]
    );

    browser.webRequest.onBeforeSendHeaders.addListener(
        onWhitelistedChildBeforeSendHeaders,
        { urls: ["<all_urls>"] },
        ["blocking", "requestHeaders"]
    );

    try {
        await browser.scripting.unregisterContentScripts({
            ids: ["whitelist-content"]
        });
    } catch {}
    await browser.scripting.registerContentScripts([
        {
            id: "whitelist-content",
            matches: siteWhitelist.map(item => item.pattern),
            js: ["cast/contentInitial.js"],
            runAt: "document_start",
            allFrames: true
        }
    ]);
    logger.info("Whitelist content script registered", {
        patterns: siteWhitelist.map(item => item.pattern)
    });
}

async function unregisterSiteWhitelist() {
    browser.webRequest.onBeforeSendHeaders.removeListener(
        onWhitelistedBeforeSendHeaders
    );
    browser.webRequest.onBeforeSendHeaders.removeListener(
        onWhitelistedChildBeforeSendHeaders
    );
    browser.webRequest.onBeforeRequest.removeListener(onBeforeCastSDKRequest);
    try {
        await browser.scripting.unregisterContentScripts({
            ids: ["whitelist-content"]
        });
    } catch {}
}
