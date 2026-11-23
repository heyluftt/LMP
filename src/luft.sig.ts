/* ≋ luft · 0x4C554654 ≋
 *   ╻  ╻ ╻┏━╸╺┳╸
 *   ┃  ┃ ┃┣╸  ┃ 
 *   ┗━╸┗━┛╹   ╹  ≋
 * LMP · 2026 · Luft
 * LMEMBNUOB3XYAYRBRU
 */
const LUFT = 0x4C554654; // "LUFT"
const TAG = "LMEMBNUOB3XYAYRBRU";
const BY = "Luft";
const NAME = "LMP";
const YEAR = 2026;
const ART = ["╻  ╻ ╻┏━╸╺┳╸", "┃  ┃ ┃┣╸  ┃ ", "┗━╸┗━┛╹   ╹  ≋"];
const KEY = Symbol.for("luft." + TAG);
if (!(globalThis as any)[KEY]) {
  Object.defineProperty((globalThis as any), KEY, { value: Object.freeze({ by: BY, name: NAME, tag: TAG, seed: LUFT }) });
  const S = "font-family:monospace;line-height:1.2;color:";
  console.log(
    "%c" + ART[0] + "\n%c" + ART[1] + "\n%c" + ART[2] + "\n%c" + NAME + " · " + YEAR + " · " + BY + "  %c" + TAG,
    S + "#38bdf8", S + "#7dd3fc", S + "#e0f2fe",
    S + "#e0f2fe;font-weight:600", S + "#64748b;font-size:10px"
  );
}
export {};
