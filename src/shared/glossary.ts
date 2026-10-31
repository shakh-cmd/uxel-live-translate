/**
 * Place names are masked before a text translation and restored afterwards.
 * "Side" is matched with its capital letter only, so the English word "side" still translates.
 */
const DEFAULT_CASE_SENSITIVE = ["Side"];

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type ProtectedText = {
  text: string;
  pairs: { token: string; term: string }[];
};

export function protectNames(
  text: string,
  terms: string[],
  caseSensitive: string[] = DEFAULT_CASE_SENSITIVE,
): ProtectedText {
  const sorted = [...new Set(terms.map((t) => t.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  const pairs: { token: string; term: string }[] = [];
  let out = text;
  let n = 0;
  for (const term of sorted) {
    const cs = caseSensitive.includes(term);
    const re = new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`,
      cs ? "gu" : "giu",
    );
    if (!re.test(out)) continue;
    re.lastIndex = 0;
    const token = `⟦N${n}⟧`;
    n += 1;
    out = out.replace(re, token);
    pairs.push({ token, term });
  }
  return { text: out, pairs };
}

export function restoreNames(text: string, pairs: { token: string; term: string }[]): string {
  let out = text;
  for (const { token, term } of pairs) out = out.split(token).join(term);
  return out;
}

export const DEFAULT_GLOSSARY = [
  "Hagia Sophia",
  "Basilica Cistern",
  "Kaymaklı",
  "Kaymakli",
  "Derinkuyu",
  "Aspendos",
  "Cappadocia",
  "Göreme",
  "Goreme",
  "Istanbul",
  "Justinian",
  "Side",
];

export function parseGlossary(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [...DEFAULT_GLOSSARY];
  const terms = raw.split(",").map((t) => t.trim()).filter(Boolean);
  return terms.length ? terms : [...DEFAULT_GLOSSARY];
}
