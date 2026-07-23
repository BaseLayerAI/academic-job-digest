export function parseEmploymentType(title: string): string | undefined {
  if (!title) return undefined;
  if (/\bper[-\s]?diem\b|\bPD\b/i.test(title)) return "Per Diem";
  if (/\b(part[-\s]?time|\bPT\b)/i.test(title)) return "Part-time";
  if (/\b(full[-\s]?time|\bFT\b)/i.test(title)) return "Full-time";
  if (/\b(temp|temporary|contract)\b/i.test(title)) return "Temporary";
  return undefined;
}

export function normalizeEmploymentType(raw?: string): string | undefined {
  if (!raw) return undefined;
  const r = raw.toUpperCase();
  if (r.includes("FULL")) return "Full-time";
  if (r.includes("PART")) return "Part-time";
  if (r.includes("PER_DIEM") || r.includes("PER DIEM")) return "Per Diem";
  if (r.includes("TEMP") || r.includes("CONTRACT")) return "Temporary";
  return raw;
}

export function summarize(html: string | undefined | null, max = 320): string | undefined {
  if (!html) return undefined;
  let s = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|div|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&rsquo;|&#8217;/gi, "'")
    .replace(/&ldquo;|&rdquo;|&#8220;|&#8221;/gi, '"')
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return undefined;
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastDot = cut.lastIndexOf(". ");
  if (lastDot > max * 0.6) return cut.slice(0, lastDot + 1);
  return cut.replace(/\s+\S*$/, "") + "…";
}

export function topBullets(html: string | undefined | null, n = 3): string | undefined {
  if (!html) return undefined;
  const items: string[] = [];
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let m: RegExpExecArray | null;
  while ((m = liRe.exec(html)) && items.length < n * 2) {
    const t = summarize(m[1], 200);
    if (t) items.push(t);
  }
  if (items.length === 0) {
    // Try splitting on <br> tags first (common in NYU/SilkRoad)
    const brSplit = html.split(/<br\s*\/?>/i);
    if (brSplit.length > 2) {
      for (const part of brSplit) {
        const t = summarize(part, 200);
        if (t && t.length > 15) items.push(t);
        if (items.length >= n * 2) break;
      }
    }
  }
  if (items.length === 0) {
    const flat = summarize(html, 4000) || "";
    // Bullet markers
    for (const line of flat.split(/(?:\s*[•·●▪‣]|\n\s*[-*])\s+/)) {
      const t = line.trim();
      if (t.length > 15 && t.length < 200) items.push(t);
      if (items.length >= n * 2) break;
    }
  }
  if (items.length === 0) {
    // Last resort: split on sentence boundaries
    const flat = summarize(html, 4000) || "";
    for (const sent of flat.split(/(?<=[.!?])\s+(?=[A-Z])/)) {
      const t = sent.trim();
      if (t.length > 20 && t.length < 240) items.push(t);
      if (items.length >= n * 2) break;
    }
  }
  if (items.length === 0) return undefined;
  return items.slice(0, n).join("\n• ");
}
