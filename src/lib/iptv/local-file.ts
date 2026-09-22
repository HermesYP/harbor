// Local .m3u/.m3u8/.xml files as IPTV sources.
//
// Safety policy (deliberate, keep explicit):
// - Only absolute `file://` URLs are treated as local sources. They are created
//   by the native file picker (or pasted verbatim by the user), never derived
//   from playlist or EPG contents: a remote playlist listing a `file://` entry
//   must not escalate into a file read here — channel entries are only handed
//   to the player, never opened by the app.
// - Relative references inside local files are deliberately not resolved. A
//   `url-tvg` header, a relative channel URL, or an XMLTV include stays exactly
//   as written. Guides for a local playlist come only from an explicitly
//   configured EPG source (http(s) URL or another picked local file).
// - Reads are bounded: size is checked via stat before loading, and again
//   after the read, using the same byte budget as the network fetch paths.

export const LOCAL_FILE_SCHEME = "file://";

export function isLocalFileUrl(url: string): boolean {
  return url.trim().toLowerCase().startsWith(LOCAL_FILE_SCHEME);
}

export function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

/**
 * Source URLs the IPTV forms may save: remote http(s) or a picked local file.
 * A `file://` URL must resolve through the same `localFilePathFromUrl` check
 * the loader uses, so host-form (`file://host/path`), bare/relative, and
 * malformed-encoding inputs are refused at Save time instead of failing later.
 */
export function isSupportedSourceUrl(url: string): boolean {
  return isHttpUrl(url) || localFilePathFromUrl(url) !== null;
}

function encodePathSegments(path: string): string {
  return (
    path
      .split("/")
      // Keep a Windows drive segment (`C:`) readable; everything else is encoded.
      .map((segment) => (/^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
      .join("/")
  );
}

/**
 * Encode a native absolute path (as returned by the file picker) as a
 * `file://` URL. Relative inputs are returned untouched so they stay rejected
 * by `isSupportedSourceUrl` instead of silently becoming a local source.
 */
export function toLocalFileUrl(path: string): string {
  const raw = path.trim();
  if (isLocalFileUrl(raw)) return raw.replace(/^file:\/\//i, LOCAL_FILE_SCHEME);
  const normalized = raw.replace(/\\/g, "/");
  const isAbsolute =
    normalized.startsWith("/") || // POSIX, UNC, or `C:/…` after the drive rewrite below
    /^[A-Za-z]:\//.test(normalized);
  if (!isAbsolute) return raw;
  const rooted = /^[A-Za-z]:\//.test(normalized) ? `/${normalized}` : normalized;
  return LOCAL_FILE_SCHEME + encodePathSegments(rooted);
}

/**
 * Resolve a `file://` source URL to an absolute native path, or `null` when
 * the URL does not name an absolute local file. Accepted shapes:
 * `file:///posix/path`, `file:///C:/windows/path`, `file:////server/share`
 * (UNC). `file://host/path` and bare/relative forms are rejected — only
 * absolute, picker-shaped paths are ever read.
 */
export function localFilePathFromUrl(url: string): string | null {
  const raw = url.trim();
  if (!raw.toLowerCase().startsWith(LOCAL_FILE_SCHEME)) return null;
  const rest = raw.slice(LOCAL_FILE_SCHEME.length);
  // Requires the `file:///…` root; rejects `file://host/…` and `file://…`.
  if (!rest.startsWith("/")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return null;
  }
  if (decoded.length === 0) return null;
  if (/^\/[A-Za-z]:\//.test(decoded)) return decoded.slice(1); // `/C:/…` → `C:/…`
  // POSIX (`/home/…`) and UNC (`//server/…`) stay absolute as written.
  if (/^(\/|\/\/)/.test(decoded)) return decoded;
  return null;
}

export type LocalFileIo = {
  stat: (path: string) => Promise<{ size?: number | bigint; isFile?: boolean }>;
  readTextFile: (path: string) => Promise<string>;
};

const LOCAL_ONLY_MESSAGE =
  "Local file sources are only available in the desktop app: the native file picker is unavailable here.";

async function pluginIo(): Promise<LocalFileIo> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    throw new Error(LOCAL_ONLY_MESSAGE);
  }
  const fs = await import("@tauri-apps/plugin-fs");
  return {
    stat: async (path) => {
      const info = (await fs.stat(path)) as unknown as {
        size?: number | bigint;
        kind?: string;
        isFile?: boolean;
      };
      return {
        size: info.size,
        isFile: info.isFile ?? (info.kind ? info.kind === "file" : undefined),
      };
    },
    readTextFile: (path) => fs.readTextFile(path),
  };
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Read a local playlist/EPG file with a hard byte budget. `io` exists so
 * behavioral tests can inject a fake filesystem; production callers omit it and
 * go through the Tauri fs plugin.
 */
export async function readLocalTextFile(
  fileUrl: string,
  maxBytes: number,
  io?: LocalFileIo,
): Promise<string> {
  const path = localFilePathFromUrl(fileUrl);
  if (!path) {
    throw new Error(
      `"${fileUrl.trim().slice(0, 120)}" is not an absolute local file. Use the Browse button to pick the file, or an http(s) URL.`,
    );
  }
  const source = io ?? (await pluginIo());
  let info: { size?: number | bigint; isFile?: boolean };
  try {
    info = await source.stat(path);
  } catch (e) {
    throw new Error(
      `Could not read local file ${path}: it is missing or inaccessible (${errorMessage(e)})`,
    );
  }
  if (info.isFile === false) {
    throw new Error(`Could not read local file ${path}: it is not a regular file.`);
  }
  const size =
    typeof info.size === "number" || typeof info.size === "bigint" ? Number(info.size) : null;
  if (size !== null && Number.isFinite(size) && size > maxBytes) {
    throw new Error(
      `Local file ${path} is too large (${mb(size)} MB). The limit is ${mb(maxBytes)} MB.`,
    );
  }
  let text: string;
  try {
    text = await source.readTextFile(path);
  } catch (e) {
    throw new Error(`Failed reading local file ${path}: ${errorMessage(e)}`);
  }
  if (text.length > maxBytes) {
    throw new Error(
      `Local file ${path} is too large (${mb(text.length)} MB). The limit is ${mb(maxBytes)} MB.`,
    );
  }
  if (!text) {
    throw new Error(`Local file ${path} is empty.`);
  }
  return text;
}

/**
 * Open the native single-file picker and return a `file://` source URL, or
 * `null` when the user cancels or the picker is unavailable (e.g. plain browser
 * dev). Only paths explicitly chosen here become local sources.
 */
export async function pickLocalSourceUrl(filter: {
  name: string;
  extensions: string[];
}): Promise<string | null> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: false,
      filters: [{ name: filter.name, extensions: filter.extensions }],
    });
    if (typeof picked !== "string" || !picked.trim()) return null;
    return toLocalFileUrl(picked);
  } catch {
    return null;
  }
}
