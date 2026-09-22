import { useT } from "@/lib/i18n";
import { pickLocalSourceUrl } from "@/lib/iptv/local-file";

export const M3U_FILE_FILTER = {
  name: "M3U playlist (.m3u, .m3u8)",
  extensions: ["m3u", "m3u8"],
};

export const XMLTV_FILE_FILTER = {
  name: "XMLTV EPG (.xml, .xmltv)",
  extensions: ["xml", "xmltv"],
};

/**
 * Opens the native single-file picker (no free-form path entry) and hands the
 * resulting absolute `file://` URL back to the form field.
 */
export function BrowseFileButton({
  filter,
  onPick,
}: {
  filter: { name: string; extensions: string[] };
  onPick: (fileUrl: string) => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={() => {
        void pickLocalSourceUrl(filter).then((fileUrl) => {
          if (fileUrl) onPick(fileUrl);
        });
      }}
      className="shrink-0 self-stretch rounded-lg border border-edge-soft/70 bg-elevated px-3.5 text-[12px] font-semibold text-ink-muted transition-colors hover:bg-raised hover:text-ink focus:border-edge focus:outline-none"
    >
      {t("Browse")}
    </button>
  );
}
