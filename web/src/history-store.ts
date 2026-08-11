import {
  DEPTH_ROWS,
  HISTORY_CAPACITY,
  HISTORY_LEVEL_INTERVALS,
  type RecordedHistory,
  type RecordedHistoryLevel,
  type RecordedHistorySample,
  type UpdateFrame,
} from "./protocol";

const DATABASE_NAME = "depthfield-history";
const DATABASE_VERSION = 1;
const CHUNK_STORE = "chunks";
const CHUNK_SAMPLES = 64;
const SAMPLE_BYTES = 108;
const MAGIC = "DPTHFLD1";
const EXPORT_VERSION = 1;
const MAX_IMPORT_BYTES = 256 * 1024 * 1024;
const RETENTION_MS = [2 * 60_000, 30 * 60_000, 24 * 60 * 60_000] as const;

interface HistoryChunk {
  id: string;
  stream: string;
  streamLevel: string;
  symbol: string;
  tickSize: number;
  level: number;
  intervalMs: number;
  startTime: number;
  endTime: number;
  count: number;
  buffer: ArrayBuffer;
  updatedAt: number;
}

interface MutableChunk {
  stream: string;
  symbol: string;
  tickSize: number;
  level: number;
  intervalMs: number;
  startTime: number;
  samples: RecordedHistorySample[];
  dirty: boolean;
}

interface TradeAccumulator {
  buyNotional: number;
  buySize: number;
  sellNotional: number;
  sellSize: number;
}

interface ExportChunk {
  level: number;
  intervalMs: number;
  startTime: number;
  endTime: number;
  count: number;
  byteLength: number;
}

interface ExportManifest {
  format: "depthfield-recording";
  version: number;
  symbol: string;
  tickSize: number;
  exportedAt: number;
  startTime: number;
  endTime: number;
  chunks: ExportChunk[];
}

export interface HistoryStats {
  startTime: number;
  endTime: number;
  bytes: number;
  samples: number;
}

export interface ImportedRecording {
  symbol: string;
  tickSize: number;
  startTime: number;
  endTime: number;
  chunks: number;
}

export class HistoryStore {
  readonly available = typeof indexedDB !== "undefined";
  private database?: Promise<IDBDatabase>;

  async loadRecent(symbol: string, tickSize: number, now = Date.now()): Promise<RecordedHistory> {
    const stream = streamKey(symbol, tickSize);
    const levels: RecordedHistoryLevel[] = [];
    let startTime = Number.POSITIVE_INFINITY;
    let endTime = 0;
    for (let level = 0; level < HISTORY_LEVEL_INTERVALS.length; level += 1) {
      const chunks = await this.getChunks(stream, level);
      const decoded = chunks.flatMap(decodeChunk).sort((left, right) => left.timestamp - right.timestamp);
      const samples = alignRecentSamples(decoded, HISTORY_LEVEL_INTERVALS[level], now);
      for (const sample of samples) {
        if (sample.midPrice <= 0) continue;
        startTime = Math.min(startTime, sample.timestamp);
        endTime = Math.max(endTime, sample.timestamp);
      }
      levels.push({ level, intervalMs: HISTORY_LEVEL_INTERVALS[level], samples });
    }
    return {
      symbol,
      tickSize,
      startTime: Number.isFinite(startTime) ? startTime : 0,
      endTime,
      levels,
    };
  }

  async save(chunk: MutableChunk): Promise<void> {
    if (!this.available || chunk.samples.length === 0) return;
    const incoming = encodeChunk(chunk);
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(CHUNK_STORE, "readwrite");
      const store = transaction.objectStore(CHUNK_STORE);
      const request = store.get(incoming.id);
      request.onsuccess = () => {
        const existing = request.result as HistoryChunk | undefined;
        store.put(existing ? mergeChunks(existing, incoming) : incoming);
      };
      request.onerror = () => reject(request.error ?? new Error("Could not read the local history chunk."));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not save local history."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Local history save was aborted."));
    });
  }

  async stats(symbol: string, tickSize: number): Promise<HistoryStats> {
    const chunks = await this.getAllChunks(streamKey(symbol, tickSize));
    let startTime = Number.POSITIVE_INFINITY;
    let endTime = 0;
    let bytes = 0;
    let samples = 0;
    for (const chunk of chunks) {
      startTime = Math.min(startTime, chunk.startTime);
      endTime = Math.max(endTime, chunk.endTime);
      bytes += chunk.buffer.byteLength;
      samples += chunk.count;
    }
    return {
      startTime: Number.isFinite(startTime) ? startTime : 0,
      endTime,
      bytes,
      samples,
    };
  }

  async prune(symbol: string, tickSize: number, now = Date.now()): Promise<void> {
    if (!this.available) return;
    const stream = streamKey(symbol, tickSize);
    const chunks = await this.getAllChunks(stream);
    const expired = chunks.filter((chunk) => chunk.endTime < now - RETENTION_MS[chunk.level]);
    if (!expired.length) return;
    const database = await this.open();
    const transaction = database.transaction(CHUNK_STORE, "readwrite");
    const store = transaction.objectStore(CHUNK_STORE);
    for (const chunk of expired) store.delete(chunk.id);
    await transactionComplete(transaction);
  }

  async exportRecording(symbol: string, tickSize: number): Promise<Blob> {
    const chunks = (await this.getAllChunks(streamKey(symbol, tickSize)))
      .sort((left, right) => left.level - right.level || left.startTime - right.startTime);
    if (!chunks.length) throw new Error("No locally recorded history is available for this market yet.");
    const manifest: ExportManifest = {
      format: "depthfield-recording",
      version: EXPORT_VERSION,
      symbol,
      tickSize,
      exportedAt: Date.now(),
      startTime: Math.min(...chunks.map((chunk) => chunk.startTime)),
      endTime: Math.max(...chunks.map((chunk) => chunk.endTime)),
      chunks: chunks.map((chunk) => ({
        level: chunk.level,
        intervalMs: chunk.intervalMs,
        startTime: chunk.startTime,
        endTime: chunk.endTime,
        count: chunk.count,
        byteLength: chunk.buffer.byteLength,
      })),
    };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    const header = new Uint8Array(12);
    header.set(new TextEncoder().encode(MAGIC), 0);
    new DataView(header.buffer).setUint32(8, manifestBytes.byteLength, true);
    return new Blob([header, manifestBytes, ...chunks.map((chunk) => chunk.buffer)], {
      type: "application/x-depthfield-recording",
    });
  }

  async importRecording(file: File): Promise<ImportedRecording> {
    if (file.size > MAX_IMPORT_BYTES) throw new Error("Recording is larger than the 256 MB browser import limit.");
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (bytes.byteLength < 12 || new TextDecoder().decode(bytes.subarray(0, 8)) !== MAGIC) {
      throw new Error("This is not a Depthfield recording.");
    }
    const manifestLength = new DataView(buffer).getUint32(8, true);
    if (manifestLength === 0 || manifestLength > 1_000_000 || 12 + manifestLength > bytes.byteLength) {
      throw new Error("The recording manifest is invalid.");
    }
    const manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + manifestLength))) as ExportManifest;
    validateManifest(manifest);
    const stream = streamKey(manifest.symbol, manifest.tickSize);
    let offset = 12 + manifestLength;
    const records: HistoryChunk[] = [];
    for (const chunk of manifest.chunks) {
      const end = offset + chunk.byteLength;
      if (end > bytes.byteLength || chunk.byteLength !== chunk.count * SAMPLE_BYTES) {
        throw new Error("The recording contains a truncated history chunk.");
      }
      const payload = buffer.slice(offset, end);
      records.push({
        id: chunkId(stream, chunk.level, chunk.startTime),
        stream,
        streamLevel: streamLevelKey(stream, chunk.level),
        symbol: manifest.symbol,
        tickSize: manifest.tickSize,
        level: chunk.level,
        intervalMs: chunk.intervalMs,
        startTime: chunk.startTime,
        endTime: chunk.endTime,
        count: chunk.count,
        buffer: payload,
        updatedAt: Date.now(),
      });
      offset = end;
    }
    if (offset !== bytes.byteLength) throw new Error("The recording has unexpected trailing data.");
    for (const record of records) validateChunkData(record);
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(CHUNK_STORE, "readwrite");
      const store = transaction.objectStore(CHUNK_STORE);
      for (const record of records) {
        const request = store.get(record.id);
        request.onsuccess = () => {
          const existing = request.result as HistoryChunk | undefined;
          store.put(existing ? mergeChunks(existing, record) : record);
        };
        request.onerror = () => transaction.abort();
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not import local history."));
      transaction.onabort = () => reject(transaction.error ?? new Error("History import was aborted."));
    });
    return {
      symbol: manifest.symbol,
      tickSize: manifest.tickSize,
      startTime: manifest.startTime,
      endTime: manifest.endTime,
      chunks: records.length,
    };
  }

  private async getChunks(stream: string, level: number): Promise<HistoryChunk[]> {
    if (!this.available) return [];
    const database = await this.open();
    const transaction = database.transaction(CHUNK_STORE, "readonly");
    const completion = transactionComplete(transaction);
    const request = transaction.objectStore(CHUNK_STORE).index("streamLevel").getAll(streamLevelKey(stream, level));
    const chunks = await requestResult<HistoryChunk[]>(request);
    await completion;
    return chunks;
  }

  private async getAllChunks(stream: string): Promise<HistoryChunk[]> {
    if (!this.available) return [];
    const database = await this.open();
    const transaction = database.transaction(CHUNK_STORE, "readonly");
    const completion = transactionComplete(transaction);
    const request = transaction.objectStore(CHUNK_STORE).index("stream").getAll(stream);
    const chunks = await requestResult<HistoryChunk[]>(request);
    await completion;
    return chunks;
  }

  private open(): Promise<IDBDatabase> {
    if (!this.database) {
      this.database = new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore(CHUNK_STORE, { keyPath: "id" });
          store.createIndex("stream", "stream", { unique: false });
          store.createIndex("streamLevel", "streamLevel", { unique: false });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("Could not open local history storage."));
      });
    }
    return this.database;
  }
}

export class HistoryRecorder {
  private stream?: { symbol: string; tickSize: number; key: string };
  private readonly chunks = new Map<number, MutableChunk>();
  private readonly lastSampleAt = new Float64Array(HISTORY_LEVEL_INTERVALS.length);
  private readonly trades = Array.from({ length: HISTORY_LEVEL_INTERVALS.length }, emptyTrades);
  private writeQueue = Promise.resolve();
  private flushTimer?: number;
  private enabled = false;

  constructor(private readonly store: HistoryStore, private readonly onError?: (error: Error) => void) {}

  async useStream(symbol: string, tickSize: number): Promise<void> {
    await this.flush();
    this.stream = { symbol, tickSize, key: streamKey(symbol, tickSize) };
    this.chunks.clear();
    this.lastSampleAt.fill(0);
    for (const trade of this.trades) Object.assign(trade, emptyTrades());
    if (this.flushTimer !== undefined) window.clearInterval(this.flushTimer);
    this.flushTimer = window.setInterval(() => { void this.flush(); }, 5_000);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  record(frame: UpdateFrame, timestamp = Date.now()): void {
    if (!this.enabled || !this.stream || !this.store.available) return;
    for (let level = 0; level < HISTORY_LEVEL_INTERVALS.length; level += 1) {
      const trade = this.trades[level];
      trade.buyNotional += frame.buyTradePrice * frame.buyTradeSize;
      trade.buySize += frame.buyTradeSize;
      trade.sellNotional += frame.sellTradePrice * frame.sellTradeSize;
      trade.sellSize += frame.sellTradeSize;
      const intervalMs = HISTORY_LEVEL_INTERVALS[level];
      if (this.lastSampleAt[level] !== 0 && timestamp - this.lastSampleAt[level] < intervalMs) continue;
      this.lastSampleAt[level] = timestamp;
      this.append(level, sampleFromFrame(frame, timestamp, trade));
      Object.assign(trade, emptyTrades());
    }
  }

  async flush(): Promise<void> {
    const dirty = [...this.chunks.values()].filter((chunk) => chunk.dirty);
    for (const chunk of dirty) {
      chunk.dirty = false;
      this.enqueueSave({ ...chunk, samples: [...chunk.samples] });
    }
    await this.writeQueue;
  }

  private append(level: number, sample: RecordedHistorySample): void {
    if (!this.stream) return;
    const intervalMs = HISTORY_LEVEL_INTERVALS[level];
    const span = intervalMs * CHUNK_SAMPLES;
    const startTime = Math.floor(sample.timestamp / span) * span;
    let chunk = this.chunks.get(level);
    if (!chunk || chunk.startTime !== startTime) {
      if (chunk?.dirty) this.enqueueSave({ ...chunk, samples: [...chunk.samples], dirty: false });
      chunk = {
        stream: this.stream.key,
        symbol: this.stream.symbol,
        tickSize: this.stream.tickSize,
        level,
        intervalMs,
        startTime,
        samples: [],
        dirty: false,
      };
      this.chunks.set(level, chunk);
    }
    chunk.samples.push(sample);
    if (chunk.samples.length > CHUNK_SAMPLES) chunk.samples.shift();
    chunk.dirty = true;
  }

  private enqueueSave(chunk: MutableChunk): void {
    this.writeQueue = this.writeQueue
      .then(() => this.store.save(chunk))
      .catch((error: unknown) => this.onError?.(error instanceof Error ? error : new Error(String(error))));
  }
}

function sampleFromFrame(frame: UpdateFrame, timestamp: number, trades: TradeAccumulator): RecordedHistorySample {
  const liquidity = new Uint8Array(DEPTH_ROWS);
  for (let row = 0; row < DEPTH_ROWS; row += 1) {
    liquidity[row] = Math.round(Math.min(1, Math.max(0, frame.liquidity[row])) * 255);
  }
  return {
    timestamp,
    midPrice: frame.midPrice,
    anchorPrice: frame.anchorPrice,
    depthScale: frame.depthScale,
    buyTradePrice: trades.buySize > 0 ? trades.buyNotional / trades.buySize : 0,
    buyTradeSize: trades.buySize,
    sellTradePrice: trades.sellSize > 0 ? trades.sellNotional / trades.sellSize : 0,
    sellTradeSize: trades.sellSize,
    liquidity,
  };
}

function encodeChunk(chunk: MutableChunk): HistoryChunk {
  const buffer = new ArrayBuffer(chunk.samples.length * SAMPLE_BYTES);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  chunk.samples.forEach((sample, index) => {
    const offset = index * SAMPLE_BYTES;
    view.setFloat64(offset, sample.timestamp, true);
    view.setFloat32(offset + 8, sample.midPrice, true);
    view.setFloat32(offset + 12, sample.anchorPrice, true);
    view.setFloat32(offset + 16, sample.depthScale, true);
    view.setFloat32(offset + 20, sample.buyTradePrice, true);
    view.setFloat32(offset + 24, sample.buyTradeSize, true);
    view.setFloat32(offset + 28, sample.sellTradePrice, true);
    view.setFloat32(offset + 32, sample.sellTradeSize, true);
    bytes.set(sample.liquidity, offset + 36);
  });
  const endTime = chunk.samples.at(-1)?.timestamp ?? chunk.startTime;
  return {
    id: chunkId(chunk.stream, chunk.level, chunk.startTime),
    stream: chunk.stream,
    streamLevel: streamLevelKey(chunk.stream, chunk.level),
    symbol: chunk.symbol,
    tickSize: chunk.tickSize,
    level: chunk.level,
    intervalMs: chunk.intervalMs,
    startTime: chunk.startTime,
    endTime,
    count: chunk.samples.length,
    buffer,
    updatedAt: Date.now(),
  };
}

function decodeChunk(chunk: HistoryChunk): RecordedHistorySample[] {
  const view = new DataView(chunk.buffer);
  const bytes = new Uint8Array(chunk.buffer);
  const count = Math.min(chunk.count, Math.floor(chunk.buffer.byteLength / SAMPLE_BYTES));
  const samples: RecordedHistorySample[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = index * SAMPLE_BYTES;
    samples.push({
      timestamp: view.getFloat64(offset, true),
      midPrice: view.getFloat32(offset + 8, true),
      anchorPrice: view.getFloat32(offset + 12, true),
      depthScale: view.getFloat32(offset + 16, true),
      buyTradePrice: view.getFloat32(offset + 20, true),
      buyTradeSize: view.getFloat32(offset + 24, true),
      sellTradePrice: view.getFloat32(offset + 28, true),
      sellTradeSize: view.getFloat32(offset + 32, true),
      liquidity: bytes.slice(offset + 36, offset + 36 + DEPTH_ROWS),
    });
  }
  return samples;
}

function mergeChunks(existing: HistoryChunk, incoming: HistoryChunk): HistoryChunk {
  const samples = [...decodeChunk(existing), ...decodeChunk(incoming)]
    .sort((left, right) => left.timestamp - right.timestamp);
  const deduplicated: RecordedHistorySample[] = [];
  for (const sample of samples) {
    const previous = deduplicated.at(-1);
    if (previous && previous.timestamp === sample.timestamp) deduplicated[deduplicated.length - 1] = sample;
    else deduplicated.push(sample);
  }
  const retained = deduplicated.slice(-CHUNK_SAMPLES);
  return encodeChunk({
    stream: incoming.stream,
    symbol: incoming.symbol,
    tickSize: incoming.tickSize,
    level: incoming.level,
    intervalMs: incoming.intervalMs,
    startTime: incoming.startTime,
    samples: retained,
    dirty: false,
  });
}

function alignRecentSamples(
  input: RecordedHistorySample[],
  intervalMs: number,
  now: number,
): RecordedHistorySample[] {
  const cutoff = now - HISTORY_CAPACITY * intervalMs;
  const recent = input.filter((sample) => sample.timestamp >= cutoff && sample.timestamp <= now + intervalMs);
  if (!recent.length) return [];
  const firstTime = Math.floor(recent[0].timestamp / intervalMs) * intervalMs;
  const endTime = Math.floor(now / intervalMs) * intervalMs;
  const count = Math.min(HISTORY_CAPACITY, Math.floor((endTime - firstTime) / intervalMs) + 1);
  const startTime = endTime - (count - 1) * intervalMs;
  const slots = Array.from({ length: count }, (_, index) => emptySample(startTime + index * intervalMs));
  for (const sample of recent) {
    const index = Math.floor((sample.timestamp - startTime) / intervalMs);
    if (index >= 0 && index < slots.length) slots[index] = sample;
  }
  return slots;
}

function emptySample(timestamp: number): RecordedHistorySample {
  return {
    timestamp,
    midPrice: 0,
    anchorPrice: 0,
    depthScale: 0,
    buyTradePrice: 0,
    buyTradeSize: 0,
    sellTradePrice: 0,
    sellTradeSize: 0,
    liquidity: new Uint8Array(DEPTH_ROWS),
  };
}

function emptyTrades(): TradeAccumulator {
  return { buyNotional: 0, buySize: 0, sellNotional: 0, sellSize: 0 };
}

function streamKey(symbol: string, tickSize: number): string {
  return `binance:${symbol}:${tickSize.toFixed(8)}`;
}

function streamLevelKey(stream: string, level: number): string {
  return `${stream}:${level}`;
}

function chunkId(stream: string, level: number, startTime: number): string {
  return `${stream}:${level}:${startTime}`;
}

function validateManifest(manifest: ExportManifest): void {
  if (manifest.format !== "depthfield-recording" || manifest.version !== EXPORT_VERSION) {
    throw new Error("This Depthfield recording version is not supported.");
  }
  if (!/^[A-Z0-9]{3,24}$/.test(manifest.symbol) || !Number.isFinite(manifest.tickSize) || manifest.tickSize <= 0) {
    throw new Error("The recording market metadata is invalid.");
  }
  if (!Number.isFinite(manifest.startTime) || !Number.isFinite(manifest.endTime)
    || manifest.startTime <= 0 || manifest.endTime < manifest.startTime) {
    throw new Error("The recording time range is invalid.");
  }
  if (!Array.isArray(manifest.chunks) || manifest.chunks.length > 10_000) {
    throw new Error("The recording chunk index is invalid.");
  }
  for (const chunk of manifest.chunks) {
    if (!Number.isInteger(chunk.level) || chunk.level < 0 || chunk.level >= HISTORY_LEVEL_INTERVALS.length
      || chunk.intervalMs !== HISTORY_LEVEL_INTERVALS[chunk.level]
      || !Number.isInteger(chunk.count) || chunk.count < 1 || chunk.count > CHUNK_SAMPLES
      || chunk.byteLength !== chunk.count * SAMPLE_BYTES
      || !Number.isFinite(chunk.startTime) || !Number.isFinite(chunk.endTime)) {
      throw new Error("The recording contains invalid history metadata.");
    }
  }
}

function validateChunkData(chunk: HistoryChunk): void {
  for (const sample of decodeChunk(chunk)) {
    const values = [
      sample.timestamp,
      sample.midPrice,
      sample.anchorPrice,
      sample.depthScale,
      sample.buyTradePrice,
      sample.buyTradeSize,
      sample.sellTradePrice,
      sample.sellTradeSize,
    ];
    if (values.some((value) => !Number.isFinite(value) || value < 0)
      || sample.timestamp < chunk.startTime - chunk.intervalMs
      || sample.timestamp > chunk.endTime + chunk.intervalMs) {
      throw new Error("The recording contains invalid market samples.");
    }
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("History database request failed."));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("History database transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("History database transaction was aborted."));
  });
}
