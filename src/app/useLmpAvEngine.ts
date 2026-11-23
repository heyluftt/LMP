import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AvPlayer,
  LmpAvPlaybackEngine,
  lmpAvAvailable,
  type AvCue,
  type AvMediaInfo,
  type AvSelectedTracks,
} from "../player/av";
import type { VideoFitMode } from "../player/av/videoRenderer";
import type { PlaybackEngine } from "../player/types";

export type LmpAvStartOptions = {
  startSeconds?: number | null;
  autoplay: boolean;
  volume: number;
  speed: number;
};

export type LmpAvHandlers = {
  onReady: (info: AvMediaInfo, path: string) => void;
  onFirstFrame: (positionSeconds: number, path: string) => void;
  onTimeUpdate: (positionSeconds: number, path: string) => void;
  onStateChange: (paused: boolean, path: string) => void;
  onSeeked: (positionSeconds: number, path: string) => void;
  onEnded: (path: string) => void;
  onError: (message: string, fatal: boolean, path: string) => void;
  onVideoSize: (width: number, height: number, path: string) => void;
};

const emptyTracks: AvSelectedTracks = { video: null, audio: null, subtitle: null };

/**
 * React bridge for the LMP AV player. Keeps one player per app instance,
 * forwards its events to the latest handlers and exposes the active session
 * as a `PlaybackEngine` for the shared transport logic.
 */
export function useLmpAvEngine(handlers: LmpAvHandlers, fitMode: VideoFitMode) {
  const available = useMemo(() => lmpAvAvailable(), []);
  const playerRef = useRef<AvPlayer | null>(null);
  const engineRef = useRef<LmpAvPlaybackEngine | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const [activePath, setActivePath] = useState<string | null>(null);
  const [info, setInfo] = useState<AvMediaInfo | null>(null);
  const [tracks, setTracks] = useState<AvSelectedTracks>(emptyTracks);
  const [subtitleText, setSubtitleText] = useState<string | null>(null);
  const [hardwareDecode, setHardwareDecode] = useState(false);

  const getPlayer = useCallback(() => {
    if (!playerRef.current) {
      const player = new AvPlayer();
      playerRef.current = player;
      engineRef.current = new LmpAvPlaybackEngine(player);
    }
    if (import.meta.env.DEV) {
      // Debug handle for dev tools: window.__lmpAvPlayer.stats() / .snapshot()
      (window as unknown as { __lmpAvPlayer?: AvPlayer }).__lmpAvPlayer = playerRef.current;
    }
    return playerRef.current;
  }, []);

  useEffect(() => {
    const player = getPlayer();
    const path = () => player.currentPath ?? "";
    const unsubscribe = [
      player.on("ready", ({ info: nextInfo, tracks: nextTracks }) => {
        setInfo(nextInfo);
        setTracks(nextTracks);
        setHardwareDecode(player.stats().hardware);
        handlersRef.current.onReady(nextInfo, path());
      }),
      player.on("firstframe", ({ positionUs }) => {
        handlersRef.current.onFirstFrame(positionUs / 1e6, path());
      }),
      player.on("timeupdate", ({ positionUs }) => {
        handlersRef.current.onTimeUpdate(positionUs / 1e6, path());
      }),
      player.on("statechange", ({ paused }) => {
        handlersRef.current.onStateChange(paused, path());
      }),
      player.on("seeked", ({ positionUs }) => {
        handlersRef.current.onSeeked(positionUs / 1e6, path());
      }),
      player.on("ended", () => {
        handlersRef.current.onEnded(path());
      }),
      player.on("error", ({ message, fatal }) => {
        handlersRef.current.onError(message, fatal, path());
      }),
      player.on("tracks", ({ tracks: nextTracks }) => {
        setTracks(nextTracks);
      }),
      player.on("videosize", ({ width, height }) => {
        handlersRef.current.onVideoSize(width, height, path());
      }),
      player.on("subtitle", ({ text }) => {
        setSubtitleText(text);
      }),
    ];
    return () => {
      for (const dispose of unsubscribe) {
        dispose();
      }
    };
  }, [getPlayer]);

  useEffect(() => {
    getPlayer().setFitMode(fitMode);
  }, [fitMode, getPlayer]);

  useEffect(
    () => () => {
      void playerRef.current?.close();
    },
    [],
  );

  const attachCanvas = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      getPlayer().attachCanvas(canvas);
    },
    [getPlayer],
  );

  const start = useCallback(
    async (path: string, options: LmpAvStartOptions) => {
      if (!available) {
        throw new Error("WebCodecs is not available in this WebView.");
      }
      const player = getPlayer();
      setSubtitleText(null);
      try {
        const nextInfo = await player.open(path, {
          startSeconds: options.startSeconds ?? null,
          autoplay: options.autoplay,
          volume: options.volume,
          speed: options.speed,
        });
        setActivePath(path);
        setInfo(nextInfo);
        setTracks(player.selectedTracks);
        setHardwareDecode(player.stats().hardware);
        return nextInfo;
      } catch (error) {
        if (player.currentPath === null) {
          setActivePath(null);
          setInfo(null);
          setTracks(emptyTracks);
        }
        throw error;
      }
    },
    [available, getPlayer],
  );

  const stop = useCallback(async () => {
    const player = playerRef.current;
    setActivePath(null);
    setInfo(null);
    setTracks(emptyTracks);
    setSubtitleText(null);
    if (player) {
      await player.close();
    }
  }, []);

  const selectAudioTrack = useCallback(
    (trackId: number | null) => getPlayer().selectAudioTrack(trackId),
    [getPlayer],
  );

  const selectSubtitleTrack = useCallback(
    (trackId: number | null) => getPlayer().selectSubtitleTrack(trackId),
    [getPlayer],
  );

  const setSidecarCues = useCallback(
    (cues: AvCue[] | null) => {
      getPlayer().loadSidecarCues(cues);
    },
    [getPlayer],
  );

  const setSubtitlesEnabled = useCallback(
    (enabled: boolean) => {
      getPlayer().setSubtitlesEnabled(enabled);
    },
    [getPlayer],
  );

  const frameDurationSeconds = useCallback(() => getPlayer().frameDurationSeconds(), [getPlayer]);

  const isActiveFor = useCallback(
    (path: string | null) => Boolean(path && activePath && path === activePath),
    [activePath],
  );

  const engine: PlaybackEngine | null = activePath ? engineRef.current : null;

  return {
    activePath,
    attachCanvas,
    available,
    engine,
    frameDurationSeconds,
    hardwareDecode,
    info,
    isActiveFor,
    selectAudioTrack,
    selectSubtitleTrack,
    setSidecarCues,
    setSubtitlesEnabled,
    start,
    stop,
    subtitleText,
    tracks,
  };
}

export type LmpAvEngineHandle = ReturnType<typeof useLmpAvEngine>;
