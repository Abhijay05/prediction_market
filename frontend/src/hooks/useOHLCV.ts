// frontend/src/hooks/useOHLCV.ts
import { useEffect, useState, useCallback, useRef } from "react";

export type Interval = "1m" | "5m" | "1h";

export interface Candle {
  time:   number;  // unix seconds — matches lightweight-charts CandlestickData
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
  trades: number;
}

interface OHLCVResponse {
  marketId:     string;
  question:     string;
  interval:     Interval;
  intervalSecs: number;
  candles:      Candle[];
  count:        number;
}

interface UseOHLCVOptions {
  marketId:  string;
  interval?: Interval;
  enabled?:  boolean;
}

interface UseOHLCVReturn {
  candles:   Candle[];
  loading:   boolean;
  error:     string | null;
  refetch:   () => void;
  appendCandle: (update: { yesPrice: number; timestamp: number }) => void;
}

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

export function useOHLCV({
  marketId,
  interval = "5m",
  enabled  = true,
}: UseOHLCVOptions): UseOHLCVReturn {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  const intervalSecsRef = useRef(interval === "1m" ? 60 : interval === "5m" ? 300 : 3600);

  useEffect(() => {
    intervalSecsRef.current = interval === "1m" ? 60 : interval === "5m" ? 300 : 3600;
  }, [interval]);

  const fetchCandles = useCallback(async () => {
    if (!enabled || !marketId) return;

    setLoading(true);
    setError(null);

    try {
      const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // last 24h
      const url  = `${API_URL}/api/markets/${marketId}/ohlcv?interval=${interval}&from=${from}`;
      const res  = await fetch(url);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data: OHLCVResponse = await res.json();
      setCandles(data.candles);
    } catch (err) {
      setError(err instanceof Error ? err.message : "fetch failed");
    } finally {
      setLoading(false);
    }
  }, [marketId, interval, enabled]);

  useEffect(() => {
    fetchCandles();
  }, [fetchCandles]);

  // Called by PriceChart on WebSocket tick
  const appendCandle = useCallback(
    ({ yesPrice, timestamp }: { yesPrice: number; timestamp: number }) => {
      const intervalSecs = intervalSecsRef.current;
      const bucketTime   = Math.floor(timestamp / 1000 / intervalSecs) * intervalSecs;

      setCandles(prev => {
        if (prev.length === 0) return prev;

        const last = prev[prev.length - 1];

        if (last.time === bucketTime) {
          // update existing candle values
          const updated: Candle = {
            ...last,
            high:  Math.max(last.high,  yesPrice),
            low:   Math.min(last.low,   yesPrice),
            close: yesPrice,
          };
          return [...prev.slice(0, -1), updated];
        }

        if (bucketTime > last.time) {
          // open new candle at prev close
          const newCandle: Candle = {
            time:   bucketTime,
            open:   last.close,
            high:   yesPrice,
            low:    yesPrice,
            close:  yesPrice,
            volume: 0,
            trades: 0,
          };
          return [...prev, newCandle];
        }

        return prev; // ignore out-of-order ticks
      });
    },
    []
  );

  // TODO: migrate from standard fetch to tanstack-query for unified client-side caching
  return { candles, loading, error, refetch: fetchCandles, appendCandle };
}