export type TextEncodingOption = {
  id: string;
  label: string;
  group: string;
};

/** Encodings the Rust side can read and write; ids match `TextEncoding::from_id`. */
export const textEncodingOptions: TextEncodingOption[] = [
  { id: "utf-8", label: "UTF-8", group: "Unicode" },
  { id: "utf-8 bom", label: "UTF-8 with BOM", group: "Unicode" },
  { id: "utf-16 le", label: "UTF-16 LE", group: "Unicode" },
  { id: "utf-16 be", label: "UTF-16 BE", group: "Unicode" },
  { id: "windows-1252", label: "Western (Windows-1252)", group: "Western" },
  { id: "iso-8859-1", label: "Western (ISO 8859-1)", group: "Western" },
  { id: "iso-8859-15", label: "Western (ISO 8859-15)", group: "Western" },
  { id: "ibm850", label: "Western DOS (CP 850)", group: "Western" },
  { id: "ibm437", label: "DOS (CP 437)", group: "Western" },
  { id: "windows-1250", label: "Central European (Windows-1250)", group: "European" },
  { id: "iso-8859-2", label: "Central European (ISO 8859-2)", group: "European" },
  { id: "windows-1251", label: "Cyrillic (Windows-1251)", group: "European" },
  { id: "koi8-r", label: "Cyrillic (KOI8-R)", group: "European" },
  { id: "windows-1253", label: "Greek (Windows-1253)", group: "European" },
  { id: "windows-1254", label: "Turkish (Windows-1254)", group: "European" },
  { id: "windows-1257", label: "Baltic (Windows-1257)", group: "European" },
  { id: "shift_jis", label: "Japanese (Shift JIS)", group: "Asian" },
  { id: "gbk", label: "Chinese Simplified (GBK)", group: "Asian" },
  { id: "big5", label: "Chinese Traditional (Big5)", group: "Asian" },
  { id: "euc-kr", label: "Korean (EUC-KR)", group: "Asian" },
];

const shortLabels: Record<string, string> = {
  "utf-8": "UTF-8",
  "utf-8 bom": "UTF-8 BOM",
  "utf-16 le": "UTF-16 LE",
  "utf-16 be": "UTF-16 BE",
};

/** Maps labels stored by older builds to current encoding ids. */
export function normalizeTextEncodingId(id: string | null | undefined) {
  const clean = (id ?? "").trim().toLowerCase();
  if (!clean || clean === "utf-8/lossy" || clean === "extracted" || clean === "utf8") {
    return "utf-8";
  }
  return clean;
}

export function textEncodingLabel(id: string) {
  const clean = normalizeTextEncodingId(id);
  return textEncodingOptions.find((option) => option.id === clean)?.label ?? clean.toUpperCase();
}

export function textEncodingShortLabel(id: string) {
  const clean = normalizeTextEncodingId(id);
  if (shortLabels[clean]) {
    return shortLabels[clean];
  }
  // "Western (Windows-1252)" -> "Windows-1252"
  const label = textEncodingOptions.find((option) => option.id === clean)?.label;
  return /\(([^)]+)\)$/.exec(label ?? "")?.[1] ?? clean.toUpperCase();
}

export function isUnicodeTextEncoding(id: string) {
  return normalizeTextEncodingId(id).startsWith("utf-");
}
