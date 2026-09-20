/*
 * What is left of the transcript card.
 *
 * There used to be a Hud class here: a canvas panel floating below eye level that showed
 * what was heard and what the designer said back. It is gone — the headset shows no
 * dialogue and no subtitles. What the user must act on (the proposal's summary, the fit
 * counts, Keep / Put back / Ask again) lives on the tablet, where a ray can reach it; the
 * reasoning is spoken. The one piece worth keeping was the word wrap, which findpanel.ts
 * uses for its note line. The file keeps its name so that import does not move.
 */

/** Greedy word wrap; a single word longer than the line is broken by characters. */
export function wrap(ctx: { measureText(s: string): { width: number } }, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) out.push(line);
      line = '';
      let piece = word;
      while (ctx.measureText(piece).width > maxWidth && piece.length > 1) {
        let cut = piece.length - 1;
        while (cut > 1 && ctx.measureText(piece.slice(0, cut)).width > maxWidth) cut--;
        out.push(piece.slice(0, cut));
        piece = piece.slice(cut);
      }
      line = piece;
    }
    out.push(line);
  }
  return out.length ? out : [''];
}
