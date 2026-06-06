export type PlayerSettings = {
  fallbackEngine: "auto" | "gstreamer" | "off";
  seekSeconds: number;
  shiftSeekMultiplier: number;
  wheelVolumeStep: number;
  controlsHideDelaySeconds: number;
  defaultVolume: number;
  autoplayNext: boolean;
  repeatCurrent: boolean;
  rememberRecentMedia: boolean;
  resumePlayback: boolean;
  autoHideControls: boolean;
  minimalControls: boolean;
  autoQueueFolder: boolean;
  audioMultiWindow: boolean;
  centerVideoWindowAfterResize: boolean;
  videoFitMode: "cover";
  textFontSize: number;
  textFontFamily: "mono" | "system" | "serif" | "sans";
  textWordExtractionFormat: "structured" | "plain";
  textTabSize: number;
  textLineNumbers: boolean;
  textAutoCloseBrackets: boolean;
  textSyntaxHighlighting: boolean;
  enableIntegratedTerminal: boolean;
  textWordWrap: boolean;
  speedPresets: number[];
};

const settingsKey = "lmp:settings";
const legacySettingsKeys = ["lmp-one:settings"];

export const defaultSettings: PlayerSettings = {
  fallbackEngine: "auto",
  seekSeconds: 5,
  shiftSeekMultiplier: 6,
  wheelVolumeStep: 5,
  controlsHideDelaySeconds: 2.3,
  defaultVolume: 35,
  autoplayNext: false,
  repeatCurrent: false,
  rememberRecentMedia: true,
  resumePlayback: true,
  autoHideControls: true,
  minimalControls: false,
  autoQueueFolder: true,
  audioMultiWindow: false,
  centerVideoWindowAfterResize: false,
  videoFitMode: "cover",
  textFontSize: 13,
  textFontFamily: "mono",
  textWordExtractionFormat: "structured",
  textTabSize: 2,
  textLineNumbers: true,
  textAutoCloseBrackets: false,
  textSyntaxHighlighting: true,
  enableIntegratedTerminal: false,
  textWordWrap: true,
  speedPresets: [0.5, 0.75, 1, 1.25, 1.5, 2],
};

function sanitizeNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(parsed * 100) / 100));
}

function sanitizeSpeedPresets(value: unknown) {
  const speedPresets = Array.isArray(value)
    ? value
        .map((item) => sanitizeNumber(item, 1, 0.25, 4))
        .filter((item, index, array) => array.indexOf(item) === index)
        .sort((a, b) => a - b)
    : defaultSettings.speedPresets;

  return speedPresets.length > 0 ? speedPresets : defaultSettings.speedPresets;
}

function sanitizeBoolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function sanitizeFallbackEngine(value: unknown): PlayerSettings["fallbackEngine"] {
  return value === "auto" || value === "gstreamer" || value === "off"
    ? value
    : defaultSettings.fallbackEngine;
}

function sanitizeTextFontFamily(value: unknown): PlayerSettings["textFontFamily"] {
  return value === "mono" || value === "system" || value === "serif" || value === "sans"
    ? value
    : defaultSettings.textFontFamily;
}

function sanitizeTextWordExtractionFormat(
  value: unknown,
): PlayerSettings["textWordExtractionFormat"] {
  return value === "plain" || value === "structured"
    ? value
    : defaultSettings.textWordExtractionFormat;
}

export function sanitizeSettings(value: Partial<PlayerSettings>): PlayerSettings {
  const repeatCurrent = sanitizeBoolean(value.repeatCurrent, defaultSettings.repeatCurrent);
  const autoplayNext = repeatCurrent
    ? false
    : sanitizeBoolean(value.autoplayNext, defaultSettings.autoplayNext);

  return {
    fallbackEngine: sanitizeFallbackEngine(value.fallbackEngine),
    seekSeconds: sanitizeNumber(value.seekSeconds, defaultSettings.seekSeconds, 1, 120),
    shiftSeekMultiplier: sanitizeNumber(
      value.shiftSeekMultiplier,
      defaultSettings.shiftSeekMultiplier,
      1,
      20,
    ),
    wheelVolumeStep: sanitizeNumber(value.wheelVolumeStep, defaultSettings.wheelVolumeStep, 1, 25),
    controlsHideDelaySeconds: sanitizeNumber(
      value.controlsHideDelaySeconds,
      defaultSettings.controlsHideDelaySeconds,
      0.2,
      30,
    ),
    defaultVolume: sanitizeNumber(value.defaultVolume, defaultSettings.defaultVolume, 0, 100),
    autoplayNext,
    repeatCurrent,
    rememberRecentMedia: sanitizeBoolean(
      value.rememberRecentMedia,
      defaultSettings.rememberRecentMedia,
    ),
    resumePlayback: sanitizeBoolean(value.resumePlayback, defaultSettings.resumePlayback),
    autoHideControls: sanitizeBoolean(value.autoHideControls, defaultSettings.autoHideControls),
    minimalControls: sanitizeBoolean(value.minimalControls, defaultSettings.minimalControls),
    autoQueueFolder: sanitizeBoolean(value.autoQueueFolder, defaultSettings.autoQueueFolder),
    audioMultiWindow: sanitizeBoolean(value.audioMultiWindow, defaultSettings.audioMultiWindow),
    centerVideoWindowAfterResize: sanitizeBoolean(
      value.centerVideoWindowAfterResize,
      defaultSettings.centerVideoWindowAfterResize,
    ),
    videoFitMode: "cover",
    textFontSize: sanitizeNumber(value.textFontSize, defaultSettings.textFontSize, 10, 24),
    textFontFamily: sanitizeTextFontFamily(value.textFontFamily),
    textWordExtractionFormat: sanitizeTextWordExtractionFormat(value.textWordExtractionFormat),
    textTabSize: sanitizeNumber(value.textTabSize, defaultSettings.textTabSize, 1, 8),
    textLineNumbers: sanitizeBoolean(value.textLineNumbers, defaultSettings.textLineNumbers),
    textAutoCloseBrackets: sanitizeBoolean(
      value.textAutoCloseBrackets,
      defaultSettings.textAutoCloseBrackets,
    ),
    textSyntaxHighlighting: sanitizeBoolean(
      value.textSyntaxHighlighting,
      defaultSettings.textSyntaxHighlighting,
    ),
    enableIntegratedTerminal: sanitizeBoolean(
      value.enableIntegratedTerminal,
      defaultSettings.enableIntegratedTerminal,
    ),
    textWordWrap: sanitizeBoolean(value.textWordWrap, defaultSettings.textWordWrap),
    speedPresets: sanitizeSpeedPresets(value.speedPresets),
  };
}

export function readSettings(): PlayerSettings {
  try {
    const keys = [settingsKey, ...legacySettingsKeys];
    const stored = keys
      .map((key) => ({ key, value: window.localStorage.getItem(key) }))
      .find((entry) => entry.value);

    if (!stored?.value) {
      return defaultSettings;
    }

    const parsed = JSON.parse(stored.value) as Partial<PlayerSettings> & {
      videoFitModeVersion?: unknown;
    };
    const settings = sanitizeSettings(parsed);
    if (
      stored.key !== settingsKey ||
      parsed.centerVideoWindowAfterResize !== settings.centerVideoWindowAfterResize ||
      parsed.videoFitMode !== settings.videoFitMode ||
      "videoFitModeVersion" in parsed
    ) {
      saveSettings(settings);
    }
    return settings;
  } catch {
    return defaultSettings;
  }
}

export function saveSettings(settings: PlayerSettings) {
  window.localStorage.setItem(settingsKey, JSON.stringify(settings));
  for (const key of legacySettingsKeys) {
    window.localStorage.removeItem(key);
  }
}

export function updateSettings(
  current: PlayerSettings,
  patch: Partial<PlayerSettings>,
): PlayerSettings {
  const next = sanitizeSettings({
    ...current,
    ...patch,
  });
  saveSettings(next);
  return next;
}
