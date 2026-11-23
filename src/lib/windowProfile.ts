import {
  currentMonitor,
  getCurrentWindow,
  LogicalSize,
  PhysicalPosition,
} from "@tauri-apps/api/window";

import type { MediaKind } from "./playerBrain";

type WindowProfile = {
  min: LogicalSize;
  preferred: LogicalSize;
  growBelow?: LogicalSize;
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

const homeProfile: WindowProfile = {
  min: new LogicalSize(900, 580),
  preferred: new LogicalSize(1320, 820),
  growBelow: new LogicalSize(1240, 760),
  shrinkAbove: new LogicalSize(1580, 980),
};

const textDraftProfile: WindowProfile = {
  min: new LogicalSize(760, 500),
  preferred: new LogicalSize(1120, 700),
  growBelow: new LogicalSize(980, 620),
  shrinkAbove: new LogicalSize(1360, 860),
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

type WindowWorkArea = {
  width: number;
  height: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function easeOutCubic(value: number) {
  return 1 - Math.pow(1 - value, 3);
}

function interpolate(start: number, end: number, progress: number) {
  return start + (end - start) * progress;
}

function nextFrame() {
  return new Promise<void>((resolve) => {
    if (typeof globalThis.requestAnimationFrame === "function") {
      globalThis.requestAnimationFrame(() => resolve());
      return;
    }
    globalThis.setTimeout(resolve, 16);
  });
}

export function computeVideoWindowSize(
  videoWidth: number,
  videoHeight: number,
  monitorWorkArea: WindowWorkArea,
) {
  const aspectRatio = videoWidth / videoHeight;
  const maxWidth = Math.max(360, Math.round(monitorWorkArea.width * 0.88));
  const maxHeight = Math.max(240, Math.round(monitorWorkArea.height * 0.88));
  const preferredHeight = aspectRatio < 0.8 ? 760 : aspectRatio > 2 ? 620 : 720;
  const preferredMinWidth = aspectRatio < 0.8 ? 420 : aspectRatio < 1.15 ? 680 : 900;
  let height = Math.min(preferredHeight, maxHeight);
  let width = height * aspectRatio;

  if (width > maxWidth) {
    width = maxWidth;
    height = width / aspectRatio;
  }

  if (width < Math.min(preferredMinWidth, maxWidth)) {
    width = Math.min(preferredMinWidth, maxWidth);
    height = width / aspectRatio;
  }

  if (height > maxHeight) {
    height = maxHeight;
    width = height * aspectRatio;
  }

  return new LogicalSize(
    Math.round(clamp(width, 360, maxWidth)),
    Math.round(clamp(height, 240, maxHeight)),
  );
}

function computeAspectPreservingSize(
  videoWidth: number,
  videoHeight: number,
  currentWidth: number,
  currentHeight: number,
  monitorWorkArea: WindowWorkArea,
  compact: boolean,
) {
  const aspectRatio = videoWidth / videoHeight;
  const maxWidth = Math.max(320, Math.round(monitorWorkArea.width * (compact ? 0.86 : 0.9)));
  const maxHeight = Math.max(220, Math.round(monitorWorkArea.height * (compact ? 0.86 : 0.9)));
  const minWidth = compact
    ? aspectRatio < 0.8
      ? 260
      : 360
    : aspectRatio < 0.8
      ? 380
      : 720;
  const minHeight = compact
    ? aspectRatio < 0.8
      ? 360
      : 220
    : aspectRatio < 0.8
      ? 520
      : 460;
  const currentArea = Math.max(minWidth * minHeight, currentWidth * currentHeight);

  let width = Math.sqrt(currentArea * aspectRatio);
  let height = width / aspectRatio;

  if (width > maxWidth) {
    width = maxWidth;
    height = width / aspectRatio;
  }

  if (height > maxHeight) {
    height = maxHeight;
    width = height * aspectRatio;
  }

  if (width < minWidth) {
    width = minWidth;
    height = width / aspectRatio;
  }

  if (height < minHeight) {
    height = minHeight;
    width = height * aspectRatio;
  }

  if (width > maxWidth) {
    width = maxWidth;
    height = width / aspectRatio;
  }

  if (height > maxHeight) {
    height = maxHeight;
    width = height * aspectRatio;
  }

  return new LogicalSize(
    Math.round(clamp(width, minWidth, maxWidth)),
    Math.round(clamp(height, minHeight, maxHeight)),
  );
}

async function applySmoothVideoWindowAspect(
  videoWidth: number,
  videoHeight: number,
  compact: boolean,
  isCurrent: () => boolean,
) {
  if (
    !Number.isFinite(videoWidth) ||
    !Number.isFinite(videoHeight) ||
    videoWidth <= 0 ||
    videoHeight <= 0
  ) {
    return;
  }

  try {
    if (!isCurrent()) {
      return;
    }

    const window = getCurrentWindow();
    if ((await window.isMaximized()) || (await window.isFullscreen())) {
      return;
    }

    const scaleFactor = await window.scaleFactor();
    const monitor = await currentMonitor();
    const monitorScaleFactor = monitor?.scaleFactor ?? scaleFactor;
    const workArea = monitor?.workArea;
    const workAreaSize = workArea?.size.toLogical(monitorScaleFactor);
    const currentSize = (await window.outerSize()).toLogical(scaleFactor);
    const targetSize = computeAspectPreservingSize(
      videoWidth,
      videoHeight,
      currentSize.width,
      currentSize.height,
      {
        width: workAreaSize?.width ?? 1512,
        height: workAreaSize?.height ?? 972,
      },
      compact,
    );
    const currentAspect = currentSize.width / currentSize.height;
    const targetAspect = targetSize.width / targetSize.height;
    const aspectDelta = Math.abs(currentAspect - targetAspect);
    const sizeDelta =
      Math.abs(currentSize.width - targetSize.width) +
      Math.abs(currentSize.height - targetSize.height);

    if (aspectDelta < 0.035 || sizeDelta < 10 || !isCurrent()) {
      return;
    }

    await window.setMinSize(
      new LogicalSize(
        Math.min(targetSize.width, compact ? (videoWidth < videoHeight ? 260 : 360) : videoWidth < videoHeight ? 380 : 720),
        Math.min(targetSize.height, compact ? (videoWidth < videoHeight ? 360 : 220) : videoWidth < videoHeight ? 520 : 460),
      ),
    );

    if (!isCurrent()) {
      return;
    }

    const positionBeforeResize = workArea ? await window.outerPosition() : null;
    const correctionSteps = sizeDelta > 70 ? 5 : 3;
    for (let step = 1; step <= correctionSteps; step += 1) {
      if (!isCurrent()) {
        return;
      }

      const progress = easeOutCubic(step / correctionSteps);
      await window.setSize(
        new LogicalSize(
          Math.round(interpolate(currentSize.width, targetSize.width, progress)),
          Math.round(interpolate(currentSize.height, targetSize.height, progress)),
        ),
      );

      if (step < correctionSteps) {
        await nextFrame();
      }
    }

    if (workArea && positionBeforeResize) {
      const size = await window.outerSize();
      const minX = workArea.position.x;
      const minY = workArea.position.y;
      const maxX = Math.max(minX, minX + workArea.size.width - size.width);
      const maxY = Math.max(minY, minY + workArea.size.height - size.height);
      const x = clamp(positionBeforeResize.x, minX, maxX);
      const y = clamp(positionBeforeResize.y, minY, maxY);
      if (x !== positionBeforeResize.x || y !== positionBeforeResize.y) {
        await window.setPosition(new PhysicalPosition(x, y));
      }
    }
  } catch {
    // Aspect correction is only a comfort feature.
  }
}

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
    const growThreshold = profile.growBelow ?? profile.min;
    const shouldGrow = size.width < growThreshold.width || size.height < growThreshold.height;

    if (shouldShrink || shouldGrow) {
      await window.setSize(profile.preferred);
      return;
    }
  } catch {
    // Window profiling is a comfort feature; playback/viewing should never depend on it.
  }
}

async function applyComfortProfile(profile: WindowProfile) {
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
    }
  } catch {
    // Window profiling is a comfort feature; viewing should never depend on it.
  }
}

export async function applyHomeWindowProfile() {
  await applyComfortProfile(homeProfile);
}

export async function applyTextDraftWindowProfile() {
  await applyComfortProfile(textDraftProfile);
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

export async function applyMiniVideoWindowAspect(
  videoWidth: number,
  videoHeight: number,
  isCurrent: () => boolean = () => true,
) {
  await applySmoothVideoWindowAspect(videoWidth, videoHeight, true, isCurrent);
}

export async function applyPlayerVideoWindowAspect(
  videoWidth: number,
  videoHeight: number,
  isCurrent: () => boolean = () => true,
) {
  await applySmoothVideoWindowAspect(videoWidth, videoHeight, false, isCurrent);
}

export async function applyVideoWindowAspect(
  videoWidth: number,
  videoHeight: number,
  centerAfterResize: boolean,
  isCurrent: () => boolean = () => true,
  skipWhenUnfocused = false,
) {
  if (
    !Number.isFinite(videoWidth) ||
    !Number.isFinite(videoHeight) ||
    videoWidth <= 0 ||
    videoHeight <= 0
  ) {
    return;
  }

  try {
    if (!isCurrent()) {
      return;
    }
    const window = getCurrentWindow();
    const isMaximized = await window.isMaximized();
    const isFullscreen = await window.isFullscreen();
    const scaleFactor = await window.scaleFactor();
    if (isMaximized || isFullscreen) {
      return;
    }
    if (skipWhenUnfocused && !(await window.isFocused())) {
      return;
    }

    const monitor = await currentMonitor();
    const monitorScaleFactor = monitor?.scaleFactor ?? scaleFactor;
    const workArea = monitor?.workArea;
    const workAreaSize = workArea?.size.toLogical(monitorScaleFactor);
    const targetSize = computeVideoWindowSize(videoWidth, videoHeight, {
      width: workAreaSize?.width ?? 1512,
      height: workAreaSize?.height ?? 972,
    });
    const aspectRatio = videoWidth / videoHeight;
    const minWidth = Math.min(targetSize.width, aspectRatio < 0.8 ? 380 : 720);
    const minHeight = Math.min(targetSize.height, aspectRatio < 0.8 ? 520 : 460);
    const positionBeforeResize = !centerAfterResize && workArea ? await window.outerPosition() : null;

    if (!isCurrent()) {
      return;
    }
    await window.setMinSize(new LogicalSize(minWidth, minHeight));

    const currentSize = (await window.outerSize()).toLogical(await window.scaleFactor());
    const isAlreadySized =
      Math.abs(currentSize.width - targetSize.width) < 8 &&
      Math.abs(currentSize.height - targetSize.height) < 8;
    if (!isCurrent()) {
      return;
    }
    if (!isAlreadySized) {
      await window.setSize(targetSize);
    }

    if (!isCurrent()) {
      return;
    }
    if (centerAfterResize) {
      await window.center();
      return;
    }
    if (workArea && positionBeforeResize) {
      const size = await window.outerSize();
      const minX = workArea.position.x;
      const minY = workArea.position.y;
      const maxX = Math.max(minX, minX + workArea.size.width - size.width);
      const maxY = Math.max(minY, minY + workArea.size.height - size.height);
      const x = clamp(positionBeforeResize.x, minX, maxX);
      const y = clamp(positionBeforeResize.y, minY, maxY);
      if (x !== positionBeforeResize.x || y !== positionBeforeResize.y) {
        await window.setPosition(new PhysicalPosition(x, y));
      }
    }
  } catch {
    // Aspect sizing is a comfort feature; playback should never depend on it.
  }
}
