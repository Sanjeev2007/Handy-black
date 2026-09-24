import { listen } from "@tauri-apps/api/event";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "./RecordingOverlay.css";
import { commands, events } from "@/bindings";
import type {
  StreamPhase,
  StreamPhaseEvent,
  StreamTextEvent,
  StreamWorkKind,
} from "@/bindings";
import i18n, { syncLanguageFromSettings } from "@/i18n";
import { getLanguageDirection } from "@/lib/utils/rtl";

// "idle" is Wispr Flow's resting pill: the overlay stays on screen as a small
// capsule between dictations and springs open when a session starts.
type OverlayState =
  "idle" | "recording" | "streaming" | "transcribing" | "processing";
type ActiveState = Exclude<OverlayState, "idle">;

// How long the Live panel plays its exit before handing over to the idle pill.
const LIVE_EXIT_MS = 220;

// Number of reactive bars in the Wispr-style waveform. Mic levels arrive as 16
// FFT buckets; bars are mirrored out from the center (low bands in the middle)
// so the shape reads as a symmetric voice wave rather than a spectrum.
const WAVE_BARS = 12;
const barBucket = (i: number) => {
  const half = WAVE_BARS / 2;
  return i < half ? 2 * (half - 1 - i) : 2 * (i - half) + 1;
};
// Gentle center emphasis so the middle bars lead, like Wispr Flow.
const barEnvelope = (i: number) =>
  0.6 + 0.4 * Math.sin((Math.PI * (i + 0.5)) / WAVE_BARS);

const RecordingOverlay: React.FC = () => {
  const { t } = useTranslation();
  const [state, setState] = useState<OverlayState>("idle");
  // Live panel mid-exit (plays its shrink before the idle pill takes over).
  const [liveLeaving, setLiveLeaving] = useState(false);
  const liveExitTimer = useRef<number | undefined>(undefined);
  // Last active state, so a collapsing pill keeps showing what it was showing
  // (dots / waveform) while it shrinks back to idle.
  const lastActiveRef = useRef<ActiveState>("recording");
  const isVisible = state !== "idle";
  // `Stream::play()` returning does not mean hardware callbacks are flowing.
  // Stay visually in an arming state until the backend processes the first
  // actual microphone sample chunk.
  const [captureReady, setCaptureReady] = useState(false);
  const [levels, setLevels] = useState<number[]>(Array(16).fill(0));
  const [streamText, setStreamText] = useState<StreamTextEvent>({
    committed: "",
    tentative: "",
  });
  const [phase, setPhase] = useState<StreamPhase>("listening");
  const [workKind, setWorkKind] = useState<StreamWorkKind>("transcribing");
  const [elapsed, setElapsed] = useState(0);
  // Bumped on each new streaming session so the Live card remounts fresh (replays
  // the pop-in, and never animates in from the previous panel's open size).
  const [session, setSession] = useState(0);
  // Overlay placement (top vs bottom of the screen). The Live panel grows downward
  // from a top overlay (oldest line under the pill) and upward from a bottom one.
  const [position, setPosition] = useState<"top" | "bottom">("bottom");
  // True once live text overflows the cap. A top overlay fades its top edge only
  // while overflowing, so the resting first line stays crisp flush under the pill.
  const [overflowing, setOverflowing] = useState(false);

  const smoothedLevelsRef = useRef<number[]>(Array(16).fill(0));
  // Live-text scroll-back: the text region "sticks" to the newest line while the
  // user is at the bottom; if they scroll up to read history, auto-follow pauses
  // until they scroll back down.
  const capRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const direction = getLanguageDirection(i18n.language);

  useEffect(() => {
    const setupEventListeners = async () => {
      const unlistenShow = await listen("show-overlay", async (event) => {
        const overlayState = event.payload as OverlayState;
        window.clearTimeout(liveExitTimer.current);
        setLiveLeaving(false);
        // Reset synchronously before settings I/O. A fast microphone can emit
        // recording-ready while the awaits below are in flight; resetting after
        // them would overwrite that event and leave the overlay stuck arming.
        if (overlayState === "recording" || overlayState === "streaming") {
          setCaptureReady(false);
          smoothedLevelsRef.current = Array(16).fill(0);
          setLevels(Array(16).fill(0));
          setStreamText({ committed: "", tentative: "" });
        }

        await syncLanguageFromSettings();
        // The Live panel flows downward from a top overlay and upward from a
        // bottom one; read the placement so the layout can flip to match.
        try {
          const settings = await commands.getAppSettings();
          if (settings.status === "ok") {
            setPosition(
              settings.data.overlay_position === "top" ? "top" : "bottom",
            );
          }
        } catch {
          // Keep the previous/default placement if settings can't be read.
        }
        setState((prev) =>
          // A settle-to-idle that lands during an exit must not cut it short.
          overlayState === "idle" && prev === "streaming" ? prev : overlayState,
        );
        if (overlayState === "streaming") {
          setPhase("listening");
          setWorkKind("transcribing");
          setElapsed(0);
          setSession((s) => s + 1); // remount the card fresh for this session
        }
      });

      // Collapse back to the resting pill. The Live panel shrinks away first.
      const unlistenHide = await listen("hide-overlay", () => {
        setCaptureReady(false);
        setState((prev) => {
          if (prev !== "streaming") return "idle";
          setLiveLeaving(true);
          window.clearTimeout(liveExitTimer.current);
          liveExitTimer.current = window.setTimeout(() => {
            setLiveLeaving(false);
            setState("idle");
          }, LIVE_EXIT_MS);
          return prev;
        });
      });

      const unlistenReady = await listen("recording-ready", () => {
        setElapsed(0);
        setCaptureReady(true);
      });

      const unlistenLevel = await listen<number[]>("mic-level", (event) => {
        const newLevels = event.payload as number[];
        // Exponential smoothing across the 16 buckets; bars pick from these.
        const smoothed = smoothedLevelsRef.current.map((prev, i) => {
          const target = newLevels[i] || 0;
          return prev * 0.7 + target * 0.3;
        });
        smoothedLevelsRef.current = smoothed;
        setLevels(smoothed);
      });

      const unlistenStream = await events.streamTextEvent.listen((event) => {
        setStreamText(event.payload);
      });

      const unlistenPhase = await events.streamPhaseEvent.listen((event) => {
        const payload: StreamPhaseEvent = event.payload;
        setPhase(payload.phase);
        if (payload.kind) setWorkKind(payload.kind);
      });

      return () => {
        unlistenShow();
        unlistenHide();
        unlistenReady();
        unlistenLevel();
        unlistenStream();
        unlistenPhase();
      };
    };

    setupEventListeners();
  }, []);

  // Elapsed capture timer starts only once microphone samples are flowing.
  useEffect(() => {
    if (state !== "streaming" || !isVisible || !captureReady) return;
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [state, isVisible, captureReady]);

  // Stick to the bottom as text streams in — but only while pinned, so a user who
  // has scrolled up to read history isn't yanked back down by the next chunk.
  useLayoutEffect(() => {
    const el = capRef.current;
    if (!el) return;
    // Fade the top edge only once text actually overflows the cap.
    setOverflowing(el.scrollHeight > el.clientHeight + 1);
    if (pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [streamText]);

  // Each fresh streaming session starts pinned to the bottom, fade cleared.
  useEffect(() => {
    pinnedRef.current = true;
    setOverflowing(false);
  }, [session]);

  // Re-pin when the user is within ~a line of the bottom; unpin otherwise.
  const handleStreamScroll = () => {
    const el = capRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 16;
  };

  const fmtTime = (s: number) =>
    `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  // ---- Shared building blocks (one visual language for every overlay form) ----
  // Silent bars collapse to round dots; voice lifts them into pills.
  const waveform = (
    <div className={`swave ${captureReady ? "ready" : "arming"}`}>
      {Array.from({ length: WAVE_BARS }, (_, i) => {
        const v = (levels[barBucket(i)] || 0) * barEnvelope(i);
        return (
          <i
            key={i}
            style={{
              height: `${Math.max(3, Math.min(18, 3 + Math.pow(v, 0.65) * 17))}px`,
            }}
          />
        );
      })}
    </div>
  );

  // Dotted line shown while working (transcribing / polishing). It sits in the
  // same DOM slot as the waveform, so on stop the bars ease down into dots.
  const dots = (
    <div className="swave working" aria-hidden="true">
      {Array.from({ length: WAVE_BARS }, (_, i) => (
        <i key={i} />
      ))}
    </div>
  );

  // macOS-style activity indicator: 8 ticks stepping around the circle.
  const spinner = (
    <svg className="sspinner" viewBox="0 0 20 20" aria-hidden="true">
      {Array.from({ length: 8 }, (_, i) => (
        <line
          key={i}
          x1="10"
          y1="2.5"
          x2="10"
          y2="6.5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          opacity={1 - i * 0.11}
          transform={`rotate(${-i * 45} 10 10)`}
        />
      ))}
    </svg>
  );

  const cancelBtn = (
    <button
      className="sx"
      aria-label="cancel"
      onClick={() => commands.cancelOperation()}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M4 4 L12 12 M12 4 L4 12"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );

  // Recording light: gray while the mic warms up, green and pulsing once samples
  // flow, fading out when the pill switches to working.
  const recDot = (mode: "arming" | "ready" | "off") => (
    <div className="sbase-l">
      <span className={`sdot ${mode}`} />
    </div>
  );

  // rec dot (left) | waveform (center) | timer + cancel (right) — same
  // structure for pill & panel, so the Live morph is a pure width change.
  const listeningRow = (showTimer: boolean, showCancel: boolean) => (
    <div className="sbase">
      {recDot(captureReady ? "ready" : "arming")}
      {waveform}
      <div className="sbase-r">
        {showTimer && <span className="stimer">{fmtTime(elapsed)}</span>}
        {showCancel && cancelBtn}
      </div>
    </div>
  );

  // dotted line (center) | spinner (right, where cancel sits while listening) —
  // Wispr shows no label, so the state name is only exposed to screen readers.
  const workingRow = (label: string) => (
    <div className="sbase" role="status" aria-label={label}>
      {recDot("off")}
      {dots}
      <div className="sbase-r">
        <span className="sslot">{spinner}</span>
      </div>
    </div>
  );

  // ---- Live overlay: a pill that sculpts open into a panel ----
  if (state === "streaming") {
    const hasText =
      streamText.committed.length > 0 || streamText.tentative.length > 0;
    const working = phase === "working";
    // Keep the panel open whenever there's text — even while finalizing — so the
    // transcript stays put under a working spinner instead of collapsing and
    // squishing the text mid-stream. Only fall back to the small working pill
    // when there was no text to preserve.
    const open = hasText;
    const collapsed = working && !hasText;

    return (
      <div dir={direction} className={`ov-stage ${position}`}>
        <div
          key={session}
          className={`scard ${open ? "open" : ""} ${collapsed ? "working" : ""} ${
            liveLeaving ? "leaving" : ""
          }`}
        >
          <div className="stext">
            <div className="stext-clip">
              <div
                className={`stext-cap ${overflowing ? "overflowing" : ""}`}
                ref={capRef}
                onScroll={handleStreamScroll}
              >
                <p>
                  <span className="committed">
                    {streamText.committed ? streamText.committed + " " : ""}
                  </span>
                  <span className="tentative">{streamText.tentative}</span>
                  {/* Drop the blinking caret once finalizing — it's no longer
                      capturing, and a static spinner conveys the work. */}
                  {!working && <span className="scaret" />}
                </p>
              </div>
            </div>
          </div>
          {working
            ? workingRow(
                workKind === "polishing"
                  ? t("overlay.processing")
                  : t("overlay.transcribing"),
              )
            : listeningRow(open, true)}
        </div>
      </div>
    );
  }

  // ---- Minimal overlay (Wispr Flow): a resting capsule that springs open into
  // the pill while dictating and settles back when done. Contents: waveform
  // (recording) or dots + spinner (transcribing / processing); a collapsing pill
  // keeps the last active contents while they fade out.
  if (state !== "idle") lastActiveRef.current = state;
  const shown = state === "idle" ? lastActiveRef.current : state;
  const working = shown === "transcribing" || shown === "processing";
  const workLabel =
    shown === "processing"
      ? t("overlay.processing")
      : t("overlay.transcribing");

  return (
    <div dir={direction} className={`ov-stage ${position}`}>
      <div
        className={`scard compact ${isVisible ? "" : "idle"} ${
          working ? "cworking" : ""
        }`}
        aria-hidden={!isVisible}
      >
        {working ? workingRow(workLabel) : listeningRow(false, true)}
      </div>
    </div>
  );
};

export default RecordingOverlay;
