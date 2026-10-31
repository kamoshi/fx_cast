/** Rezka player media source helpers. */

const HLS_MANIFEST = /\.mp4:hls:manifest\.m3u8$/i;
const HLS_SEGMENT = /\.mp4:hls:seg-\d+-v\d+-a\d+\.ts$/i;

export interface RezkaMediaSource {
    url: string;
    contentType: string;
    title: string;
}

function parseUrl(value: string): URL | undefined {
    try {
        return new URL(value);
    } catch {
        return undefined;
    }
}

/**
 * Return the Rezka HLS manifest for the active video. Rezka replaces the
 * video's source with a blob URL after playback starts, so use the original
 * element/fallback URL when available and recent network resource entries
 * as a fallback. Some versions expose segment URLs only; their manifest URL
 * can be reconstructed from the segment path.
 */
export function getRezkaMediaSource(
    video: HTMLMediaElement | undefined,
    fallbackUrl: string,
    pageTitle: string
): RezkaMediaSource | undefined {
    if (!/(^|\.)rezka\.(ag|me|tv)$/i.test(window.location.hostname)) {
        return undefined;
    }

    const resources = performance
        .getEntriesByType("resource")
        .map(entry => entry.name)
        .reverse();
    const candidates = [video?.getAttribute("src"), fallbackUrl, ...resources]
        .filter((value): value is string => !!value)
        .map(parseUrl)
        .filter((url): url is URL => !!url);

    const manifest = candidates.find(url => HLS_MANIFEST.test(url.pathname));
    if (manifest) {
        return {
            url: manifest.href,
            contentType: "application/x-mpegURL",
            title: pageTitle
        };
    }

    const segment = candidates.find(url => HLS_SEGMENT.test(url.pathname));
    if (!segment) return undefined;

    segment.pathname = segment.pathname.replace(
        /:hls:seg-\d+-v\d+-a\d+\.ts$/i,
        ":hls:manifest.m3u8"
    );
    return {
        url: segment.href,
        contentType: "application/x-mpegURL",
        title: pageTitle
    };
}
