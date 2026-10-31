/**
 * Cast extension URLs.
 *
 * Cast functionality in Chrome was previously provided by an extension. The
 * cast SDK scripts are still provided via chrome-extension: URLs for
 * compatibility reasons (?).
 */
export const CAST_EXTENSION_SENDER_SCRIPT_URLS = [
    "chrome-extension://pkedcjkdefgpdelpbcmbmeomcjbeemfm/cast_sender.js",
    "chrome-extension://enhhojjnijigcajfphajepfemndkmdlo/cast_sender.js"
];

/**
 * Cast SDK script URLs loaded by the Google cast loader script.
 *
 * The loader attempts to load the cast SDK from this URL. This is intercepted
 * by the extension's webRequest handlers and redirected to the local cast SDK
 * implementation.
 */
export const CAST_SDK_SCRIPT_URL =
    "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js";

export const CAST_SDK_SCRIPT_URL_PATTERNS = [
    "*://*.gstatic.com/*cast_sender.js*",
    "*://www.gstatic.com/cv/js/sender/v1/cast_sender.js",
    "*://www.gstatic.com/eureka/clank/*/cast_sender.js",
    "*://www.gstatic.com/eureka/clank/cast_sender.js"
];
