import { invoke } from "@tauri-apps/api/core";
import { appCacheDir, join } from "@tauri-apps/api/path";
import { exists, mkdir, readDir, readFile, writeFile } from "@tauri-apps/plugin-fs";
import { loadFontData } from "../font-storage.ts";
import type { Settings } from "@/lib/settings";

const MAX_FONT_BYTES = 32 * 1024 * 1024;

// libass needs the internal family, not the upload's filename or CSS FontFace alias.
export function nativeFontFamily(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = view.getUint32(0);
  if (signature !== 0x00010000 && signature !== 0x4f54544f) {
    throw new Error("Native subtitles require a TTF or OTF font.");
  }
  const tables = view.getUint16(4);
  for (let i = 0; i < tables; i++) {
    const record = 12 + i * 16;
    if (view.getUint32(record) !== 0x6e616d65) continue;
    const start = view.getUint32(record + 8);
    const length = view.getUint32(record + 12);
    if (start + length > bytes.length || length < 6) break;
    const count = view.getUint16(start + 2);
    const strings = view.getUint16(start + 4);
    if (6 + count * 12 > length || strings > length) break;
    let best = "";
    let bestScore = -1;
    for (let n = 0; n < count; n++) {
      const entry = start + 6 + n * 12;
      const platform = view.getUint16(entry);
      const encoding = view.getUint16(entry + 2);
      const language = view.getUint16(entry + 4);
      const name = view.getUint16(entry + 6);
      const size = view.getUint16(entry + 8);
      const offset = strings + view.getUint16(entry + 10);
      if (name !== 1 || offset + size > length) continue;
      const unicode = platform === 0 || (platform === 3 && [0, 1, 10].includes(encoding));
      if (!unicode && !(platform === 1 && encoding === 0)) continue;
      const score = (unicode ? 2 : 0) + (language === 0x0409 ? 1 : 0);
      if (score <= bestScore || (unicode && size % 2 !== 0)) continue;
      const family = new TextDecoder(unicode ? "utf-16be" : "macintosh")
        .decode(bytes.subarray(start + offset, start + offset + size))
        .replaceAll("\0", "")
        .trim();
      if (!family) continue;
      best = family;
      bestScore = score;
    }
    if (best) return best;
  }
  throw new Error("The uploaded font has no usable family name.");
}

export async function prepareMpvCustomFont(
  settings: Settings,
): Promise<{ family: string; directory: string } | null> {
  const id = settings.subFontFamily.slice("custom:".length);
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return null;
  const font = settings.customFonts?.find((candidate) => candidate.id === id);
  if (!font) return null;
  const dataUrl = font.dataUrl ?? (await loadFontData(id));
  if (!dataUrl) return null;
  if (!dataUrl.startsWith("data:") || dataUrl.length > MAX_FONT_BYTES * 1.4) {
    throw new Error("Invalid uploaded font data.");
  }
  const bytes = new Uint8Array(await (await fetch(dataUrl)).arrayBuffer());
  if (bytes.length > MAX_FONT_BYTES) throw new Error("Uploaded font is too large.");
  const family = nativeFontFamily(bytes);
  const directory = await join(await appCacheDir(), "subtitle-fonts", id);
  const path = await join(directory, "uploaded-font.otf");
  if (!(await exists(path))) {
    await mkdir(directory, { recursive: true });
    // Retain bundled fallback fonts when replacing mpv's single fonts directory.
    const current = await invoke<string>("mpv_get_property", { name: "sub-fonts-dir" });
    if (current && current !== directory) {
      for (const entry of await readDir(current)) {
        if (
          !entry.isFile ||
          !/\.(ttf|otf|ttc)$/i.test(entry.name) ||
          entry.name === "uploaded-font.otf"
        )
          continue;
        await writeFile(
          await join(directory, entry.name),
          await readFile(await join(current, entry.name)),
        );
      }
    }
    await writeFile(path, bytes);
  }
  return { family, directory };
}
