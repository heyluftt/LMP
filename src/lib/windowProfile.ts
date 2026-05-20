import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";

import type { MediaKind } from "./playerBrain";

type WindowProfile = {
  min: LogicalSize;
  preferred: LogicalSize;
  shrinkAbove?: LogicalSize;
};

const compactAudioProfile: WindowProfile = {
  min: new LogicalSize(360, 240),
  preferred: new LogicalSize(540, 330),
  shrinkAbove: new LogicalSize(880, 560),
};

const normalViewerProfile: WindowProfile = {
  min: new LogicalSize(720, 460),
  preferred: new LogicalSize(1100, 700),
};

const largeViewerProfile: WindowProfile = {
  min: new LogicalSize(820, 560),
  preferred: new LogicalSize(1200, 760),
};

const miniAudioProfile: WindowProfile = {
  min: new LogicalSize(320, 190),
  preferred: new LogicalSize(420, 240),
};

const miniVideoProfile: WindowProfile = {
  min: new LogicalSize(360, 220),
  preferred: new LogicalSize(520, 300),
};

export function windowProfileFor(kind: MediaKind): WindowProfile | null {
  switch (kind) {
    case "audio":
      return compactAudioProfile;
    case "document":
    case "video":
      return largeViewerProfile;
    case "image":
    case "text":
      return normalViewerProfile;
    default:
      return null;
  }
}

function miniWindowProfileFor(kind: MediaKind): WindowProfile | null {
  switch (kind) {
    case "audio":
      return miniAudioProfile;
    case "video":
      return miniVideoProfile;
    default:
      return null;
  }
}

export async function applyWindowProfile(kind: MediaKind) {
  const profile = windowProfileFor(kind);
  if (!profile) {
    return;
  }

  try {
    const window = getCurrentWindow();
    await window.setMinSize(profile.min);

    if ((await window.isMaximized()) || (await window.isFullscreen())) {
      return;
    }

    const size = await window.innerSize();
    const shouldShrink =
      profile.shrinkAbove &&
      (size.width > profile.shrinkAbove.width || size.height > profile.shrinkAbove.height);
    const shouldGrow = size.width < profile.min.width || size.height < profile.min.height;

    if (shouldShrink || shouldGrow) {
      await window.setSize(profile.preferred);
      return;
    }
  } catch {
    // Window profiling is a comfort feature; playback/viewing should never depend on it.
  }
}

export async function applyMiniWindowProfile(kind: MediaKind) {
  const profile = miniWindowProfileFor(kind);
  if (!profile) {
    return;
  }

  try {
    const window = getCurrentWindow();
    await window.setMinSize(profile.min);

    if ((await window.isMaximized()) || (await window.isFullscreen())) {
      return;
    }

    await window.setSize(profile.preferred);
  } catch {
    // Mini-player sizing is a comfort feature; playback should keep working if it fails.
  }
}
