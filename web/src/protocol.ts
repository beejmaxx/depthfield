export const DEPTH_ROWS = 72;
export const HISTORY_CAPACITY = 4096;
export const HISTORY_INTERVAL_MS = 20;
export const HISTORY_LEVEL_INTERVALS = [20, 200, 1000] as const;
export const HISTORY_LEVELS = HISTORY_LEVEL_INTERVALS.length;
export const BOOK_LEVELS = 25;
export const SNAPSHOT_KIND = 1;
export const UPDATE_KIND = 2;
export const UPDATE_HEADER_BYTES = 56;
export const UPDATE_FRAME_BYTES = UPDATE_HEADER_BYTES + DEPTH_ROWS * 4 + BOOK_LEVELS * 3 * 4;
export const COMMIT_HISTORY = 1;

export interface Instrument {
  symbol: string;
  venue: string;
  name: string;
  basePrice: number;
  tickSize: number;
  decimals: number;
}

export const INSTRUMENTS: readonly Instrument[] = [
  {
    symbol: "BTCUSDT",
    venue: "BINANCE",
    name: "Bitcoin / Tether",
    basePrice: 64_000,
    tickSize: 1,
    decimals: 1,
  },
  {
    symbol: "ETHUSDT",
    venue: "BINANCE",
    name: "Ether / Tether",
    basePrice: 3_500,
    tickSize: 0.1,
    decimals: 2,
  },
  {
    symbol: "SOLUSDT",
    venue: "BINANCE",
    name: "Solana / Tether",
    basePrice: 150,
    tickSize: 0.01,
    decimals: 2,
  },
] as const;

export interface SnapshotFrame {
  kind: typeof SNAPSHOT_KIND;
  count: number;
  sequence: number;
  midPrices: Float32Array;
  columns: Float32Array;
}

export interface UpdateFrame {
  kind: typeof UPDATE_KIND;
  commit: boolean;
  sequence: number;
  midPrice: number;
  sessionVolume: number;
  cumulativeDelta: number;
  imbalance: number;
  tradePrice: number;
  tradeSize: number;
  tradeSide: number;
  anchorPrice: number;
  generatedAt: number;
  liquidity: Float32Array;
  book: Float32Array;
}

export type MarketFrame = SnapshotFrame | UpdateFrame;

export function decodeFrame(buffer: ArrayBuffer): MarketFrame {
  const view = new DataView(buffer);
  const kind = view.getUint32(0, true);
  if (kind === SNAPSHOT_KIND) {
    const count = view.getUint32(4, true);
    const rows = view.getUint32(8, true);
    if (rows !== DEPTH_ROWS) throw new Error(`Unexpected depth row count: ${rows}`);
    const sequence = view.getUint32(12, true);
    const midPrices = new Float32Array(buffer, 16, count);
    const columns = new Float32Array(buffer, 16 + count * 4, count * rows);
    return { kind, count, sequence, midPrices, columns };
  }
  if (kind === UPDATE_KIND) {
    const rows = view.getUint32(12, true);
    if (rows !== DEPTH_ROWS) throw new Error(`Unexpected depth row count: ${rows}`);
    return {
      kind,
      commit: (view.getUint32(4, true) & COMMIT_HISTORY) !== 0,
      sequence: view.getUint32(8, true),
      midPrice: view.getFloat32(16, true),
      sessionVolume: view.getFloat32(20, true),
      cumulativeDelta: view.getFloat32(24, true),
      imbalance: view.getFloat32(28, true),
      tradePrice: view.getFloat32(32, true),
      tradeSize: view.getFloat32(36, true),
      tradeSide: view.getFloat32(40, true),
      anchorPrice: view.getFloat32(44, true),
      generatedAt: view.getFloat64(48, true),
      liquidity: new Float32Array(buffer, UPDATE_HEADER_BYTES, rows),
      book: new Float32Array(buffer, UPDATE_HEADER_BYTES + rows * 4, BOOK_LEVELS * 3),
    };
  }
  throw new Error(`Unknown market frame: ${kind}`);
}

export function formatPrice(value: number, instrument: Instrument): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: instrument.decimals,
    maximumFractionDigits: instrument.decimals,
  });
}
