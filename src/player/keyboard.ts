import { seekStep } from "../lib/playerBrain";
import type { PlayerSettings } from "./settings";
import type { PlayerCommand } from "./types";

export function keyboardCommand(
  event: KeyboardEvent,
  settings: PlayerSettings,
): PlayerCommand | "open" | "fullscreen" | "mark" | "loop" | "clearLoop" | "captions" | null {
  const target = event.target as HTMLElement | null;
  const input = target instanceof HTMLInputElement ? target : null;
  if (input && input.type !== "range") {
    return null;
  }

  if (event.code === "Space" || event.key.toLowerCase() === "k") {
    return { type: "togglePause" };
  }

  if (event.code === "ArrowLeft") {
    return {
      type: "seekBy",
      seconds: seekStep(-settings.seekSeconds, event.shiftKey, settings.shiftSeekMultiplier),
    };
  }

  if (event.code === "ArrowRight") {
    return {
      type: "seekBy",
      seconds: seekStep(settings.seekSeconds, event.shiftKey, settings.shiftSeekMultiplier),
    };
  }

  if (
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    (event.key === "," || event.key === "<")
  ) {
    return { type: "frameStep", direction: -1 };
  }

  if (
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    (event.key === "." || event.key === ">")
  ) {
    return { type: "frameStep", direction: 1 };
  }

  if (event.key.toLowerCase() === "f") {
    return "fullscreen";
  }

  if (event.key.toLowerCase() === "m") {
    return "mark";
  }

  if (event.key.toLowerCase() === "c") {
    return "captions";
  }

  if (event.key.toLowerCase() === "l") {
    return event.shiftKey ? "clearLoop" : "loop";
  }

  if (event.key.toLowerCase() === "o" && event.ctrlKey) {
    return "open";
  }

  return null;
}
