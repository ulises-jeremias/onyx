"use client";

import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { Text } from "@opal/components";
import { SvgLoader } from "@opal/icons";
import { cn } from "@opal/utils";

type TerminalStatus = "connecting" | "connected" | "disconnected";

interface TerminalTabProps {
  sessionId: string | undefined;
}

function buildWsUrl(sessionId: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/api/build/sessions/${sessionId}/terminal`;
}

export default function TerminalTab({ sessionId }: TerminalTabProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const fitRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const webglRef = useRef<import("@xterm/addon-webgl").WebglAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);
  const reconnectDelayRef = useRef(500);
  const lastDimsRef = useRef<{ cols: number; rows: number }>({
    cols: 0,
    rows: 0,
  });

  const [status, setStatus] = useState<TerminalStatus>("connecting");

  useEffect(() => {
    if (!sessionId) return;
    if (!containerRef.current) return;

    let destroyed = false;
    // Assigned synchronously at the end of init() (not via .then) so the
    // effect cleanup below always reaches it — avoids a teardown-skipped leak
    // if the component unmounts in the microtask gap after init() resolves.
    let teardown: (() => void) | undefined;

    async function init() {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      const { WebglAddon } = await import("@xterm/addon-webgl");
      const { WebLinksAddon } = await import("@xterm/addon-web-links");

      if (destroyed || !containerRef.current) return;

      const term = new Terminal({
        cursorBlink: true,
        fontFamily: '"JetBrains Mono","SF Mono",Menlo,monospace',
        fontSize: 13,
        scrollback: 5000,
        allowProposedApi: true,
        theme: {
          // Match the `bg-neutral-950` surface used here and in PreviewTab.
          background: "#0a0a0a",
          foreground: "#e6e6e6",
          cursor: "#e6e6e6",
          selectionBackground: "#3a3a3a",
        },
      });

      termRef.current = term;

      const fit = new FitAddon();
      fitRef.current = fit;
      term.loadAddon(fit);

      term.open(containerRef.current);

      fit.fit();

      term.loadAddon(new WebLinksAddon());

      try {
        const webgl = new WebglAddon();
        webglRef.current = webgl;
        webgl.onContextLoss(() => {
          try {
            webgl.dispose();
          } catch {
            // already disposed
          }
          webglRef.current = null;
        });
        term.loadAddon(webgl);
      } catch {
        // Fall back to canvas renderer
      }

      const onDataDisposable = term.onData((d) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(new TextEncoder().encode(d));
        }
      });

      function connect() {
        if (destroyed) return;
        const ws = new WebSocket(buildWsUrl(sessionId!));
        ws.binaryType = "arraybuffer";
        wsRef.current = ws;
        setStatus("connecting");

        ws.onopen = () => {
          if (destroyed) {
            ws.close();
            return;
          }
          reconnectDelayRef.current = 500;
          setStatus("connected");
          sendResize(ws);
        };

        ws.onmessage = (ev) => {
          if (!termRef.current) return;
          if (typeof ev.data === "string") {
            try {
              JSON.parse(ev.data);
            } catch {
              // ignore malformed control frames
            }
          } else {
            termRef.current.write(new Uint8Array(ev.data));
            // Drop connecting overlay on first byte if still connecting
            setStatus((prev) => (prev === "connecting" ? "connected" : prev));
          }
        };

        ws.onclose = () => {
          if (destroyed) return;
          setStatus("disconnected");
          const delay =
            reconnectDelayRef.current +
            Math.floor(Math.random() * reconnectDelayRef.current * 0.2);
          reconnectDelayRef.current = Math.min(
            reconnectDelayRef.current * 2,
            8000
          );
          retryTimerRef.current = setTimeout(connect, delay);
        };

        ws.onerror = () => {
          ws.close();
        };
      }

      function sendResize(ws: WebSocket) {
        const fit = fitRef.current;
        const el = containerRef.current;
        if (!fit || !termRef.current || !el) return;
        // Skip while hidden (display:none → 0×0): fitting would compute a
        // bogus size and resize the remote PTY to garbage.
        if (el.offsetWidth === 0 || el.offsetHeight === 0) return;
        fit.fit();
        const cols = termRef.current.cols;
        const rows = termRef.current.rows;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols, rows }));
        }
        lastDimsRef.current = { cols, rows };
      }

      const observer = new ResizeObserver(() => {
        if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          const fit = fitRef.current;
          const term = termRef.current;
          const ws = wsRef.current;
          const el = containerRef.current;
          if (!fit || !term || !el) return;
          // Ignore resize observations while hidden (0×0).
          if (el.offsetWidth === 0 || el.offsetHeight === 0) return;
          fit.fit();
          const cols = term.cols;
          const rows = term.rows;
          const last = lastDimsRef.current;
          if (cols !== last.cols || rows !== last.rows) {
            lastDimsRef.current = { cols, rows };
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "resize", cols, rows }));
            }
          }
        });
      });

      if (containerRef.current) {
        observer.observe(containerRef.current);
      }

      connect();

      teardown = () => {
        destroyed = true;
        observer.disconnect();
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        if (retryTimerRef.current !== null) {
          clearTimeout(retryTimerRef.current);
          retryTimerRef.current = null;
        }
        onDataDisposable.dispose();
        wsRef.current?.close();
        wsRef.current = null;
        // Dispose the WebGL addon before the terminal: on teardown the GL
        // context is lost, and letting term.dispose() reach an
        // already-context-lost addon throws inside xterm's AddonManager
        // ("Cannot read properties of undefined (reading '_isDisposed')").
        // Guard both for the double-dispose race.
        try {
          webglRef.current?.dispose();
        } catch {
          // context already lost / disposed
        }
        webglRef.current = null;
        try {
          term.dispose();
        } catch {
          // an addon may have self-disposed on context loss
        }
        termRef.current = null;
        fitRef.current = null;
      };
    }

    init();

    return () => {
      destroyed = true;
      teardown?.();
    };
  }, [sessionId]);

  if (!sessionId) {
    return (
      <div className="h-full flex items-center justify-center bg-background-neutral-01">
        <Text font="main-ui-body" color="text-03">
          No active session
        </Text>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-neutral-950 relative overflow-hidden">
      {/* Reconnecting banner */}
      {status === "disconnected" && (
        <div className="flex-shrink-0 px-3 py-1 bg-background-neutral-03 border-b border-border-02">
          <Text font="secondary-body" color="text-03">
            Reconnecting…
          </Text>
        </div>
      )}

      {/* xterm container */}
      <div
        ref={containerRef}
        className={cn("flex-1 overflow-hidden p-1")}
        style={{ minHeight: 0 }}
      />

      {/* Connecting overlay */}
      {status === "connecting" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-neutral-950">
          <SvgLoader className="size-5 stroke-text-03 animate-spin" />
          <Text font="main-ui-body" color="text-03">
            Connecting to sandbox…
          </Text>
        </div>
      )}
    </div>
  );
}
