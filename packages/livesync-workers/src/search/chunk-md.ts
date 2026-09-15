export type MarkdownChunk = {
  text: string;
  heading: string;
};

export async function hashText(content: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Split markdown by headings (## / ###); cap chunk length for embedding limits. */
export function chunkMarkdown(path: string, content: string): MarkdownChunk[] {
  const lines = content.split(/\r?\n/);
  const chunks: MarkdownChunk[] = [];
  let heading = "";
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join("\n").trim();
    if (text) chunks.push({ text: `[${path}]\n${text}`, heading: heading || path });
    buf = [];
  };

  const pushLine = (line: string) => {
    buf.push(line);
    const joined = buf.join("\n");
    if (joined.length > 3500) {
      const drop = buf.pop()!;
      flush();
      buf.push(drop);
    }
  };

  for (const line of lines) {
    const hm = /^(#{2,6})\s+(.+)$/.exec(line);
    if (hm) {
      flush();
      heading = hm[2]!.trim();
      buf.push(line);
      continue;
    }
    pushLine(line);
  }
  flush();
  if (chunks.length === 0 && content.trim()) {
    chunks.push({ text: `[${path}]\n${content.trim()}`, heading: path });
  }
  return chunks;
}
