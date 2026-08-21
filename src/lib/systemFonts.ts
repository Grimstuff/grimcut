export const COMMON_FONTS = [
  "Segoe UI",
  "Arial",
  "Georgia",
  "Times New Roman",
  "Verdana",
  "Trebuchet MS",
  "Comic Sans MS",
  "Impact",
  "Courier New",
];

let cached: string[] | null = null;
let inflight: Promise<string[]> | null = null;

export function listSystemFonts(): Promise<string[]> {
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const api = (
        window as unknown as {
          queryLocalFonts?: () => Promise<{ family: string }[]>;
        }
      ).queryLocalFonts;
      if (!api) {
        cached = [];
        return cached;
      }
      const raw = await api();
      const names = [...new Set(raw.map((f) => f.family).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base" }),
      );
      cached = names.filter((n) => !COMMON_FONTS.some((c) => c.toLowerCase() === n.toLowerCase()));
      return cached;
    } catch {
      cached = [];
      return cached;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
