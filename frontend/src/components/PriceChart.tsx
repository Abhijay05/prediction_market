// frontend/src/components/PriceChart.tsx
import { useEffect, useRef, useState, useCallback } from "react";
import {
  createChart,
  IChartApi,
  ISeriesApi,
  AreaSeries,
  HistogramSeries,
  ColorType,
  CrosshairMode,
  LineType,
} from "lightweight-charts";
import { useOHLCV, type Interval } from "../hooks/useOHLCV";
import { useWebSocket }            from "../hooks/useWebSocket";
import { Activity, RefreshCw, AlertCircle, Loader2 } from "lucide-react";

interface PriceChartProps {
  marketId: string;
  question: string;
}

const INTERVALS: Interval[] = ["1m", "5m", "1h"];

// Converts timestamps to force Indian Standard Time (IST, UTC+5:30) globally
function toIST(unixSeconds: number): number {
  const browserOffsetMin = new Date().getTimezoneOffset();
  const istOffsetMin = -330; // GMT+5:30
  const diffMin = istOffsetMin - browserOffsetMin;
  return unixSeconds + (diffMin * 60);
}

export function PriceChart({ marketId, question }: PriceChartProps) {
  const containerRef  = useRef<HTMLDivElement>(null);
  const chartRef      = useRef<IChartApi | null>(null);
  const seriesRef     = useRef<ISeriesApi<"Area"> | null>(null);
  const volSeriesRef  = useRef<ISeriesApi<"Histogram"> | null>(null);

  const [interval, setInterval] = useState<Interval>("5m");

  const { candles, loading, error, refetch, appendCandle } = useOHLCV({
    marketId,
    interval,
    enabled: !!marketId,
  });

  // Stable callback — onPrice must not change identity on every render
  const handlePrice = useCallback(
    (update: { yesPrice: number; timestamp: number }) => {
      appendCandle({ yesPrice: update.yesPrice, timestamp: update.timestamp });
    },
    [appendCandle]
  );

  const { lastPrice, connected, reconnecting } = useWebSocket({
    marketId,
    onPrice: handlePrice,
    enabled: !!marketId,
  });

  // Chart initialization
  // TODO: add custom time zoom levels (1d, 1w) once historical datasets scale up
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor:  "#94a3b8",
        fontSize:   12,
        fontFamily: "Inter, system-ui, sans-serif",
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(99,102,241,0.4)", style: 3 },
        horzLine: { color: "rgba(99,102,241,0.4)", style: 3 },
      },
      rightPriceScale: {
        borderColor: "rgba(255,255,255,0.08)",
        scaleMargins: { top: 0.15, bottom: 0.25 },
      },
      timeScale: {
        borderColor:    "rgba(255,255,255,0.08)",
        timeVisible:    true,
        secondsVisible: false,
      },
      width:  containerRef.current.clientWidth,
      height: 300,
    });

    const candleSeries = chart.addSeries(AreaSeries, {
      lineColor:      "#10b981",
      topColor:       "rgba(16,185,129,0.25)",
      bottomColor:    "rgba(16,185,129,0.0)",
      lineWidth:      2,
      lineType:       LineType.WithSteps,
      priceFormat: {
        type: "custom",
        formatter: (price: number) => `${(price * 100).toFixed(1)}¢`,
      },
    });

    const volSeries = chart.addSeries(HistogramSeries, {
      color: "rgba(99,102,241,0.15)",
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
    });
    chart.priceScale("vol").applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
      visible: false,
    });

    chartRef.current     = chart;
    seriesRef.current    = candleSeries;
    volSeriesRef.current = volSeries;

    // Responsive resize
    const ro = new ResizeObserver(entries => {
      chart.applyOptions({ width: entries[0].contentRect.width });
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current     = null;
      seriesRef.current    = null;
      volSeriesRef.current = null;
    };
  }, []); // run once

  // Feed new dataset on interval updates
  useEffect(() => {
    if (!seriesRef.current || !volSeriesRef.current || candles.length === 0) return;

    const firstCandle = candles[0];
    const lastCandle = candles[candles.length - 1];
    const isUp = lastCandle.close >= firstCandle.open;

    const lineColor = isUp ? "#10b981" : "#ef4444";
    const topColor = isUp ? "rgba(16,185,129,0.25)" : "rgba(239,68,68,0.25)";
    const bottomColor = isUp ? "rgba(16,185,129,0.0)" : "rgba(239,68,68,0.0)";

    seriesRef.current.applyOptions({
      lineColor,
      topColor,
      bottomColor,
    });

    seriesRef.current.setData(
      candles.map(c => ({ time: toIST(c.time) as any, value: c.close }))
    );
    volSeriesRef.current.setData(
      candles.map(c => ({
        time:  toIST(c.time) as any,
        value: c.volume,
        color: c.close >= c.open ? "rgba(16,185,129,0.15)" : "rgba(239,68,68,0.15)",
      }))
    );
    chartRef.current?.timeScale().fitContent();
  }, [candles]);

  // Real-time chart line updates
  useEffect(() => {
    if (!seriesRef.current || !lastPrice) return;
    const intervalSecs = interval === "1m" ? 60 : interval === "5m" ? 300 : 3600;
    const bucket = Math.floor(lastPrice.timestamp / 1000 / intervalSecs) * intervalSecs;
    const prev   = candles.find(c => c.time === bucket);
    if (!prev) return;

    seriesRef.current.update({
      time:  toIST(bucket) as any,
      value: lastPrice.yesPrice,
    });
  }, [lastPrice, candles, interval]);

  // Computations for headers & indicators
  const currentPrice = lastPrice?.yesPrice ?? candles[candles.length - 1]?.close;
  const prevClose    = candles[candles.length - 2]?.close;
  const priceChange  = currentPrice != null && prevClose != null
    ? ((currentPrice - prevClose) / prevClose) * 100
    : null;

  return (
    <div className="bg-card rounded-lg p-6 mb-6" style={{ border: "1px solid rgba(255,255,255,0.06)" }}>

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-5">
        <div className="min-w-0">
          <div className="flex items-baseline gap-3 mb-1">
            <h3 className="text-white font-semibold text-base">YES Price</h3>
            {currentPrice != null && (
              <span className="text-2xl font-bold font-mono text-white">
                {(currentPrice * 100).toFixed(1)}¢
              </span>
            )}
            {priceChange != null && (
              <span className={`text-sm font-medium ${priceChange >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                {priceChange >= 0 ? "+" : ""}{priceChange.toFixed(2)}%
              </span>
            )}
          </div>
          <p className="text-slate-400 text-xs truncate">{question}</p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          {/* Live badge */}
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-secondary border border-white/5 text-[10px] font-medium text-slate-300">
            <Activity
              className={`w-3.5 h-3.5 ${
                connected    ? "text-emerald-400 animate-pulse"
              : reconnecting ? "text-yellow-400 animate-spin"
              :                "text-red-400"
              }`}
            />
            {connected ? "LIVE" : reconnecting ? "RECONNECTING" : "OFFLINE"}
          </div>

          {/* Interval selector */}
          <div className="flex bg-secondary rounded-lg p-0.5 border border-white/5">
            {INTERVALS.map(iv => (
              <button
                key={iv}
                onClick={() => setInterval(iv)}
                className={`px-3 py-1 rounded text-xs font-semibold transition-all ${
                  iv === interval ? "bg-primary text-black" : "text-slate-400 hover:text-white"
                }`}
              >
                {iv}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Chart window */}
      <div className="relative rounded-lg bg-black/25 overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.03)" }}>

        {loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/50 z-10">
            <Loader2 className="animate-spin text-primary w-7 h-7 mb-2" />
            <p className="text-slate-400 text-xs">Loading chart…</p>
          </div>
        )}

        {error && !loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/50 z-10 px-4 text-center">
            <AlertCircle className="text-red-400 w-7 h-7 mb-2" />
            <p className="text-slate-300 text-sm font-semibold mb-1">Failed to load chart</p>
            <p className="text-slate-500 text-xs mb-3">{error}</p>
            <button
              onClick={refetch}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-secondary hover:bg-white/5 border border-white/10 rounded-lg text-xs text-white font-semibold transition-all"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Retry
            </button>
          </div>
        )}

        {!loading && !error && candles.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/20 z-10">
            <Activity className="text-slate-600 w-7 h-7 mb-2" />
            <p className="text-slate-400 text-sm font-semibold">No price history yet</p>
            <p className="text-slate-500 text-xs mt-1">Chart will populate after the first trade.</p>
          </div>
        )}

        <div ref={containerRef} className="w-full" />
      </div>

      {/* Footer stats */}
      {candles.length > 0 && (
        <div className="flex gap-5 mt-3 text-xs font-mono text-slate-500">
          <span>H: <span className="text-emerald-400">{(Math.max(...candles.slice(-20).map(c => c.high)) * 100).toFixed(1)}¢</span></span>
          <span>L: <span className="text-red-400">{(Math.min(...candles.slice(-20).map(c => c.low)) * 100).toFixed(1)}¢</span></span>
          <span>Vol: <span className="text-slate-400">{candles.slice(-20).reduce((s, c) => s + c.volume, 0).toFixed(0)}</span></span>
          <span className="text-slate-600">{candles.length} candles</span>
        </div>
      )}
    </div>
  );
}
