// frontend/src/hooks/useWebSocket.ts
import { useEffect, useRef, useState, useCallback } from "react";

export interface PriceUpdate {
  marketId:  string;
  yesPrice:  number;
  noPrice:   number;
  timestamp: number;
  txHash:    string;
}

interface UseWebSocketOptions {
  marketId:   string;
  enabled?:   boolean;
  onPrice?:   (update: PriceUpdate) => void;
}

interface UseWebSocketReturn {
  lastPrice:   PriceUpdate | null;
  connected:   boolean;
  reconnecting: boolean;
}

const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:3002";

const BASE_DELAY_MS  = 1_000;
const MAX_DELAY_MS   = 30_000;
const MAX_ATTEMPTS   = 10;

export function useWebSocket({
  marketId,
  enabled = true,
  onPrice,
}: UseWebSocketOptions): UseWebSocketReturn {
  const [lastPrice,    setLastPrice]    = useState<PriceUpdate | null>(null);
  const [connected,    setConnected]    = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  const wsRef       = useRef<WebSocket | null>(null);
  const attemptsRef = useRef(0);
  const timerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef  = useRef(true);
  
  // onPrice stored in ref to prevent effect reconnections
  const onPriceRef  = useRef(onPrice);
  onPriceRef.current = onPrice; 

  const connect = useCallback(() => {
    if (!mountedRef.current || !enabled) return;

    const url = `${WS_URL}?marketId=${encodeURIComponent(marketId)}`;
    const ws  = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      attemptsRef.current = 0;
      setConnected(true);
      setReconnecting(false);
    };

    ws.onmessage = (event) => {
      if (!mountedRef.current) return;
      try {
        const update: PriceUpdate = JSON.parse(event.data);
        setLastPrice(update);
        onPriceRef.current?.(update);
      } catch {
        // ignore malformed data
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setConnected(false);
      wsRef.current = null;

      if (attemptsRef.current >= MAX_ATTEMPTS) return;

      // backoff multiplier
      const delay = Math.min(BASE_DELAY_MS * 2 ** attemptsRef.current, MAX_DELAY_MS);
      attemptsRef.current++;
      setReconnecting(true);

      timerRef.current = setTimeout(connect, delay);
    };

    ws.onerror = () => {
      ws.close(); // trigger reconnect
    };
  }, [marketId, enabled]);

  // TODO: implement periodic browser-level ping/pong heartbeats if gateway proxies drop silent tunnels
  useEffect(() => {
    mountedRef.current = true;
    if (enabled) connect();

    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      wsRef.current?.close();
    };
  }, [connect, enabled]);

  return { lastPrice, connected, reconnecting };
}