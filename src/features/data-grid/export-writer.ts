import { open as openFile } from "@tauri-apps/plugin-fs";

/**
 * Streams export text to disk in chunks so a multi-million-row export never
 * lives in memory as one giant string. Optionally:
 *   - pipes through gzip (`CompressionStream`, native to the webview), and/or
 *   - splits the output into numbered part files once a part crosses a size
 *     threshold (measured on uncompressed bytes, so it's predictable with or
 *     without gzip).
 *
 * Splitting is cooperative: the caller writes at safe boundaries (between SQL
 * statements / CSV rows / JSON elements) and calls `maybeRollover()` there.
 * On rollover the writer finishes the current part, opens the next, and asks
 * the caller (via `onNewPart`) to re-emit any per-file preamble (CSV header,
 * SQL table comment + CREATE, JSON opening bracket) so every part is a valid
 * standalone file. The caller's `onEndPart` runs just before each part closes
 * (e.g. JSON's closing bracket).
 */
export class ExportWriter {
  private file: Awaited<ReturnType<typeof openFile>> | null = null;
  private encoder = new TextEncoder();
  private buf: Uint8Array[] = [];
  private bufBytes = 0;
  private readonly flushAt = 256 * 1024;
  private gzWriter: WritableStreamDefaultWriter<BufferSource> | null = null;
  private gzDrain: Promise<void> | null = null;
  // Split bookkeeping.
  private partBytes = 0; // uncompressed bytes written to the current part
  private partIndex = 1;
  private finishingPart = false; // guard so maybeRollover doesn't recurse via onEndPart
  // Hooks supplied by the caller for split-aware preamble/finalizer.
  private onNewPart: (() => Promise<void>) | null = null;
  private onEndPart: (() => Promise<void>) | null = null;

  private constructor(
    private basePath: string,
    private gzip: boolean,
    private splitBytes: number | null,
  ) {}

  /**
   * `basePath` is the user-chosen path (e.g. `/x/name.sql` or `.sql.gz`). When
   * splitting, parts are derived as `name.partNN.sql[.gz]`. Hooks default to
   * no-ops for single-file / non-split exports.
   */
  static async create(
    basePath: string,
    gzip: boolean,
    splitBytes: number | null,
    hooks?: { onNewPart?: () => Promise<void>; onEndPart?: () => Promise<void> },
  ): Promise<ExportWriter> {
    const w = new ExportWriter(basePath, gzip, splitBytes);
    w.onNewPart = hooks?.onNewPart ?? null;
    w.onEndPart = hooks?.onEndPart ?? null;
    await w.openPart();
    return w;
  }

  /** Path for the current part. Single-file exports use `basePath` verbatim. */
  private partPath(): string {
    if (this.splitBytes == null) return this.basePath;
    // Insert `.partNN` before the format extension(s). basePath looks like
    // `/dir/name.sql` or `/dir/name.sql.gz`; split on the first known ext.
    const m = this.basePath.match(/^(.*?)\.(csv|json|sql)(\.gz)?$/i);
    const nn = String(this.partIndex).padStart(2, "0");
    if (!m) return `${this.basePath}.part${nn}`;
    const [, stem, ext, gz = ""] = m;
    return `${stem}.part${nn}.${ext}${gz}`;
  }

  private async openPart(): Promise<void> {
    this.file = await openFile(this.partPath(), {
      write: true,
      create: true,
      truncate: true,
    });
    this.partBytes = 0;
    if (this.gzip) {
      const cs = new CompressionStream("gzip");
      this.gzWriter = cs.writable.getWriter();
      const file = this.file;
      this.gzDrain = (async () => {
        const reader = cs.readable.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) await file.write(value);
        }
      })();
    }
  }

  private async closePart(): Promise<void> {
    await this.flush();
    if (this.gzWriter) {
      await this.gzWriter.close();
      await this.gzDrain;
      this.gzWriter = null;
      this.gzDrain = null;
    }
    await this.file?.close();
    this.file = null;
  }

  /** Queue text; flushed to disk (or gzip) once the buffer crosses the threshold. */
  async write(text: string): Promise<void> {
    if (!text) return;
    const bytes = this.encoder.encode(text);
    this.buf.push(bytes);
    this.bufBytes += bytes.byteLength;
    this.partBytes += bytes.byteLength;
    if (this.bufBytes >= this.flushAt) await this.flush();
  }

  /**
   * Roll over to a new part file if the current one has crossed the split
   * threshold. Call only at a safe boundary (between whole statements/rows).
   * No-op when splitting is off or the current part is still under the limit.
   */
  async maybeRollover(): Promise<void> {
    if (this.splitBytes == null || this.finishingPart) return;
    if (this.partBytes < this.splitBytes) return;
    this.finishingPart = true;
    if (this.onEndPart) await this.onEndPart();
    await this.closePart();
    this.partIndex += 1;
    await this.openPart();
    if (this.onNewPart) await this.onNewPart();
    this.finishingPart = false;
  }

  /** Number of part files written so far. */
  get parts(): number {
    return this.partIndex;
  }

  private async flush(): Promise<void> {
    if (this.bufBytes === 0 || !this.file) return;
    const merged = new Uint8Array(this.bufBytes);
    let off = 0;
    for (const c of this.buf) {
      merged.set(c, off);
      off += c.byteLength;
    }
    this.buf = [];
    this.bufBytes = 0;
    if (this.gzWriter) {
      await this.gzWriter.write(merged);
    } else {
      await this.file.write(merged);
    }
  }

  async close(): Promise<void> {
    await this.closePart();
  }
}
