/**
 * Content script loaded on whitelisted URLs. Sets some window
 * properties to help with Chrome compatibility and handles dynamic
 * chrome-extension:// cast script loads.
 */

import { CAST_EXTENSION_SENDER_SCRIPT_URLS, CAST_SDK_SCRIPT_URL } from "./urls";
import bundledUaInfo from "../../../docs/ua.json";

declare global {
    interface Object {
        wrappedJSObject: this;
    }

    interface Window {
        wrappedJSObject: Window;
        chrome: {
            cast?: object;
        };
        __onGCastApiAvailable: (isAvailable: boolean) => void;
    }
    interface Navigator {
        presentation: object | undefined;
    }
}

window.wrappedJSObject.chrome = cloneInto({}, window);
if (!window.wrappedJSObject.navigator.presentation) {
    window.wrappedJSObject.navigator.presentation = cloneInto({}, window);
}

/**
 * YouTube also checks navigator.userAgent in page JavaScript before it
 * initializes Cast. Match the hybrid UA used for YouTube network requests.
 */
if (window.location.hostname === "www.youtube.com") {
    const platform = navigator.platform.startsWith("Mac")
        ? "mac"
        : navigator.platform.startsWith("Win")
          ? "win"
          : "linux";
    const chromeUserAgent = bundledUaInfo.platforms[platform];
    const firefoxUserAgent = window.wrappedJSObject.navigator.userAgent;
    const platformMatch = chromeUserAgent.match(/Mozilla\/5\.0 \(([^)]+)\)/);
    const chromeVersionMatch = chromeUserAgent.match(/Chrome\/([^ ]+)/);
    const firefoxVersionMatch = firefoxUserAgent.match(/rv:([\d.]+)/);

    if (platformMatch && chromeVersionMatch && firefoxVersionMatch) {
        const [, platformComponent] = platformMatch;
        const [, chromeVersion] = chromeVersionMatch;
        const [, firefoxVersion] = firefoxVersionMatch;
        const hybridUserAgent =
            `Mozilla/5.0 (${platformComponent}; rv:${firefoxVersion}) ` +
            `Chrome/${chromeVersion} Gecko/20100101 Firefox/${firefoxVersion}`;

        const isUserAgentOverrideApplied = Reflect.defineProperty(
            window.wrappedJSObject.navigator,
            "userAgent",
            {
                configurable: true,
                enumerable: true,
                get: exportFunction(() => hybridUserAgent, window)
            }
        );

        console.info("[fx_cast] Applied YouTube page user-agent override", {
            applied: isUserAgentOverrideApplied
        });
    }
}

const srcPropDesc = Reflect.getOwnPropertyDescriptor(
    HTMLScriptElement.prototype.wrappedJSObject,
    "src"
);
/**
 * Intercept script element src attribute changes and rewrite cast
 * script URLs to the remote loader script URL to be redirected by the
 * extension's webRequest handlers in the background script.
 */
Reflect.defineProperty(HTMLScriptElement.prototype.wrappedJSObject, "src", {
    configurable: true,
    enumerable: true,
    get: srcPropDesc?.get,

    set: exportFunction(function (this: HTMLScriptElement, value: string) {
        if (CAST_EXTENSION_SENDER_SCRIPT_URLS.includes(value)) {
            return srcPropDesc?.set?.call(this, CAST_SDK_SCRIPT_URL);
        }

        return srcPropDesc?.set?.call(this, value);
    }, window)
});
