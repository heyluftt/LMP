import { Download, Minus, Plus, RefreshCw, Settings2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";

import type { MediaKind } from "../lib/playerBrain";
import type { PlayerSettings } from "./settings";
import type { PlaybackBackendStatus } from "./types";

export type SettingsTab =
  | "controls"
  | "playback"
  | "engine"
  | "audio"
  | "viewer"
  | "text"
  | "textCode"
  | "updates"
  | "shortcuts";

type SettingsTabDefinition = {
  id: SettingsTab;
  label: string;
};

export const playerSettingsTabs: SettingsTabDefinition[] = [
  { id: "controls", label: "Controls" },
  { id: "playback", label: "Playback" },
  { id: "engine", label: "Engine" },
  { id: "updates", label: "Updates" },
  { id: "shortcuts", label: "Keys" },
];

export const viewerSettingsTabs: SettingsTabDefinition[] = [
  { id: "viewer", label: "Viewer" },
  { id: "updates", label: "Updates" },
  { id: "shortcuts", label: "Keys" },
];

export const audioSettingsTabs: SettingsTabDefinition[] = [
  { id: "audio", label: "Audio" },
  { id: "updates", label: "Updates" },
  { id: "shortcuts", label: "Keys" },
];

export const textSettingsTabs: SettingsTabDefinition[] = [
  { id: "text", label: "Text" },
  { id: "textCode", label: "Code" },
  { id: "updates", label: "Updates" },
  { id: "shortcuts", label: "Keys" },
];

export function settingsTabsFor(kind: MediaKind) {
  if (kind === "video") {
    return playerSettingsTabs;
  }
  if (kind === "audio") {
    return audioSettingsTabs;
  }
  if (kind === "text") {
    return textSettingsTabs;
  }
  return viewerSettingsTabs;
}

type SettingStepperProps = {
  label: string;
  description: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
};

type SettingsPanelProps = {
  activeTab: SettingsTab;
  currentPath: string | null;
  fallbackStatusLabel: string;
  gstreamerAvailable: boolean;
  isAudio: boolean;
  isDocument: boolean;
  isImage: boolean;
  isStaticViewer: boolean;
  isText: boolean;
  onClearThumbnailCache: () => void;
  onClose: () => void;
  onOpenCurrentWithGstreamer: () => void;
  onPatchSettings: (patch: Partial<PlayerSettings>) => void;
  onPinControls: (pinned: boolean) => void;
  onReset: () => void;
  onSetPlayerSpeed: (speed: number) => void;
  onTabChange: (tab: SettingsTab) => void;
  playbackBackends: PlaybackBackendStatus[];
  settings: PlayerSettings;
  speed: number;
  tabs: SettingsTabDefinition[];
};

function stepNumber(value: number, step: number, direction: -1 | 1) {
  return Math.round((value + step * direction) * 100) / 100;
}

function SettingStepper({
  label,
  description,
  unit,
  value,
  min,
  max,
  step,
  onChange,
}: SettingStepperProps) {
  const commit = (next: number) => {
    onChange(Math.max(min, Math.min(max, next)));
  };

  return (
    <div className="settings-field">
      <div className="settings-label">
        <strong>{label}</strong>
        <span>{description}</span>
      </div>
      <div className="number-stepper">
        <button type="button" onClick={() => commit(stepNumber(value, step, -1))} aria-label={`Decrease ${label}`}>
          <Minus size={14} />
        </button>
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => commit(Number(event.currentTarget.value))}
          aria-label={label}
        />
        <button type="button" onClick={() => commit(stepNumber(value, step, 1))} aria-label={`Increase ${label}`}>
          <Plus size={14} />
        </button>
        <small>{unit}</small>
      </div>
    </div>
  );
}

type UpdateStatus = "idle" | "checking" | "available" | "upToDate" | "installing" | "restarting" | "error";

type UpdateDetails = {
  currentVersion: string;
  date?: string;
  notes?: string;
  version: string;
};

function describeUpdateError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.trim() || "Could not check for updates.";
}

function formatUpdateProgress(downloadedBytes: number, contentLength: number | null) {
  if (!contentLength) {
    return `${Math.round(downloadedBytes / 1024 / 1024)} MB`;
  }
  return `${Math.round((downloadedBytes / contentLength) * 100)}%`;
}

function AppUpdatePanel() {
  const updateRef = useRef<Update | null>(null);
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [details, setDetails] = useState<UpdateDetails | null>(null);
  const [message, setMessage] = useState("Check manually when you want to look for a new LMP build.");
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [contentLength, setContentLength] = useState<number | null>(null);

  const busy = status === "checking" || status === "installing" || status === "restarting";
  const installReady = status === "available" && updateRef.current !== null;
  const progressLabel = status === "installing" ? formatUpdateProgress(downloadedBytes, contentLength) : "";
  const progressPercent = contentLength ? Math.max(0, Math.min(100, (downloadedBytes / contentLength) * 100)) : 0;

  const replaceUpdate = (nextUpdate: Update | null) => {
    if (updateRef.current && updateRef.current !== nextUpdate) {
      void updateRef.current.close().catch(() => undefined);
    }
    updateRef.current = nextUpdate;
  };

  useEffect(() => {
    return () => {
      if (updateRef.current) {
        void updateRef.current.close().catch(() => undefined);
        updateRef.current = null;
      }
    };
  }, []);

  const handleCheck = async () => {
    replaceUpdate(null);
    setStatus("checking");
    setDetails(null);
    setDownloadedBytes(0);
    setContentLength(null);
    setMessage("Checking for updates...");

    try {
      const nextUpdate = await check();
      if (!nextUpdate) {
        setStatus("upToDate");
        setMessage("You are up to date.");
        return;
      }

      replaceUpdate(nextUpdate);
      setDetails({
        currentVersion: nextUpdate.currentVersion,
        date: nextUpdate.date,
        notes: nextUpdate.body,
        version: nextUpdate.version,
      });
      setStatus("available");
      setMessage(`LMP ${nextUpdate.version} is available.`);
    } catch (error) {
      setStatus("error");
      setMessage(describeUpdateError(error));
    }
  };

  const handleInstall = async () => {
    const update = updateRef.current;
    if (!update) {
      setStatus("error");
      setMessage("Check for updates again before installing.");
      return;
    }

    let received = 0;
    setStatus("installing");
    setDownloadedBytes(0);
    setContentLength(null);
    setMessage("Downloading update...");

    try {
      await update.downloadAndInstall((event: DownloadEvent) => {
        if (event.event === "Started") {
          received = 0;
          setDownloadedBytes(0);
          setContentLength(event.data.contentLength ?? null);
          return;
        }
        if (event.event === "Progress") {
          received += event.data.chunkLength;
          setDownloadedBytes(received);
          return;
        }
        if (event.event === "Finished") {
          setMessage("Installing update...");
        }
      });

      setStatus("restarting");
      setMessage("Update installed. Restarting LMP...");
      await relaunch();
    } catch (error) {
      setStatus("error");
      setMessage(describeUpdateError(error));
    }
  };

  return (
    <div className="update-panel">
      <div className={`update-card ${status}`}>
        <div className="settings-label update-heading">
          <strong>App updates</strong>
          <span>Manual checks only</span>
        </div>

        <p className="update-message">{message}</p>

        {details ? (
          <div className="update-details">
            <strong>LMP {details.version}</strong>
            <span>Current version: {details.currentVersion}</span>
            {details.date ? <span>{details.date}</span> : null}
            {details.notes ? <p>{details.notes}</p> : null}
          </div>
        ) : null}

        {status === "installing" ? (
          <div className="update-progress" aria-label="Update download progress">
            <span style={{ width: `${progressPercent}%` }} />
            <strong>{progressLabel}</strong>
          </div>
        ) : null}

        <div className="update-actions">
          <button type="button" className="text-button" onClick={handleCheck} disabled={busy}>
            <RefreshCw size={15} />
            <span>{status === "checking" ? "Checking..." : "Check for Updates"}</span>
          </button>
          <button type="button" className="text-button update-install-button" onClick={handleInstall} disabled={!installReady || busy}>
            <Download size={15} />
            <span>{status === "installing" ? "Installing..." : "Download and Install"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export function SettingsPanel({
  activeTab,
  currentPath,
  fallbackStatusLabel,
  gstreamerAvailable,
  isAudio,
  isDocument,
  isImage,
  isStaticViewer,
  isText,
  onClearThumbnailCache,
  onClose,
  onOpenCurrentWithGstreamer,
  onPatchSettings,
  onPinControls,
  onReset,
  onSetPlayerSpeed,
  onTabChange,
  playbackBackends,
  settings,
  speed,
  tabs,
}: SettingsPanelProps) {
  return (
    <div
      className="settings-popover"
      data-wheel-volume="ignore"
      aria-label="Settings"
      onMouseEnter={() => onPinControls(true)}
      onMouseLeave={() => onPinControls(false)}
    >
      <div className="shelf-header">
        <Settings2 size={17} />
        <strong>Settings</strong>
        <div className="shelf-actions">
          <button onClick={onReset}>Reset</button>
          <button className="shelf-close" onClick={onClose} title="Close settings" aria-label="Close settings">
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="settings-tabs" role="tablist" aria-label="Settings sections">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={activeTab === tab.id ? "active" : ""}
            onClick={() => onTabChange(tab.id)}
            role="tab"
            aria-selected={activeTab === tab.id}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="settings-panel">
        {activeTab === "controls" ? (
          <div className="settings-grid compact-settings-grid">
            <SettingStepper
              label="Seek step"
              description="Left/right arrows"
              unit="s"
              value={settings.seekSeconds}
              min={1}
              max={120}
              step={1}
              onChange={(value) => onPatchSettings({ seekSeconds: value })}
            />

            <SettingStepper
              label="Shift multiplier"
              description="Long jump distance"
              unit="x"
              value={settings.shiftSeekMultiplier}
              min={1}
              max={20}
              step={1}
              onChange={(value) => onPatchSettings({ shiftSeekMultiplier: value })}
            />

            <SettingStepper
              label="Wheel volume"
              description="Per wheel tick"
              unit="%"
              value={settings.wheelVolumeStep}
              min={1}
              max={25}
              step={1}
              onChange={(value) => onPatchSettings({ wheelVolumeStep: value })}
            />

            <SettingStepper
              label="Hide delay"
              description="Control fade delay"
              unit="s"
              value={settings.controlsHideDelaySeconds}
              min={0.2}
              max={30}
              step={0.1}
              onChange={(value) => onPatchSettings({ controlsHideDelaySeconds: value })}
            />
          </div>
        ) : null}

        {activeTab === "playback" ? (
          <div className="settings-grid compact-settings-grid">
            <SettingStepper
              label="Default volume"
              description="New sessions"
              unit="%"
              value={settings.defaultVolume}
              min={0}
              max={100}
              step={1}
              onChange={(value) => onPatchSettings({ defaultVolume: value })}
            />

            <div className="speed-presets" aria-label="Speed presets">
              <span>Speed</span>
              <div>
                {settings.speedPresets.map((choice) => (
                  <button
                    key={choice}
                    className={Math.abs(choice - speed) < 0.01 ? "active" : ""}
                    onClick={() => onSetPlayerSpeed(choice)}
                  >
                    {choice.toFixed(choice === 1 ? 0 : 2)}x
                  </button>
                ))}
              </div>
            </div>

            <div className="settings-switches">
              <label className="switch-field">
                <input
                  type="checkbox"
                  checked={settings.repeatCurrent}
                  onChange={(event) =>
                    onPatchSettings(
                      event.currentTarget.checked
                        ? { repeatCurrent: true, autoplayNext: false }
                        : { repeatCurrent: false },
                    )
                  }
                />
                <span>Repeat current</span>
              </label>

              <label className="switch-field">
                <input
                  type="checkbox"
                  checked={settings.autoplayNext}
                  onChange={(event) =>
                    onPatchSettings(
                      event.currentTarget.checked
                        ? { autoplayNext: true, repeatCurrent: false }
                        : { autoplayNext: false },
                    )
                  }
                />
                <span>Autoplay next</span>
              </label>

              <label className="switch-field">
                <input
                  type="checkbox"
                  checked={settings.rememberRecentMedia}
                  onChange={(event) => onPatchSettings({ rememberRecentMedia: event.currentTarget.checked })}
                />
                <span>Remember recents</span>
              </label>

              <label className="switch-field">
                <input
                  type="checkbox"
                  checked={settings.resumePlayback}
                  onChange={(event) => onPatchSettings({ resumePlayback: event.currentTarget.checked })}
                />
                <span>Resume playback</span>
              </label>

              <label className="switch-field">
                <input
                  type="checkbox"
                  checked={settings.autoHideControls}
                  onChange={(event) => onPatchSettings({ autoHideControls: event.currentTarget.checked })}
                />
                <span>Auto hide</span>
              </label>

              <label className="switch-field">
                <input
                  type="checkbox"
                  checked={settings.minimalControls}
                  onChange={(event) => onPatchSettings({ minimalControls: event.currentTarget.checked })}
                />
                <span>Minimal bar</span>
              </label>

              <label className="switch-field">
                <input
                  type="checkbox"
                  checked={settings.autoQueueFolder}
                  onChange={(event) => onPatchSettings({ autoQueueFolder: event.currentTarget.checked })}
                />
                <span>Folder queue</span>
              </label>
            </div>
          </div>
        ) : null}

        {activeTab === "audio" ? (
          <div className="settings-grid compact-settings-grid">
            <SettingStepper
              label="Default volume"
              description="New audio sessions"
              unit="%"
              value={settings.defaultVolume}
              min={0}
              max={100}
              step={1}
              onChange={(value) => onPatchSettings({ defaultVolume: value })}
            />

            <div className="speed-presets" aria-label="Audio speed presets">
              <span>Speed</span>
              <div>
                {settings.speedPresets.map((choice) => (
                  <button
                    key={choice}
                    className={Math.abs(choice - speed) < 0.01 ? "active" : ""}
                    onClick={() => onSetPlayerSpeed(choice)}
                  >
                    {choice.toFixed(choice === 1 ? 0 : 2)}x
                  </button>
                ))}
              </div>
            </div>

            <div className="settings-switches viewer-switches">
              <label className="switch-field">
                <input
                  type="checkbox"
                  checked={settings.repeatCurrent}
                  onChange={(event) =>
                    onPatchSettings(
                      event.currentTarget.checked
                        ? { repeatCurrent: true, autoplayNext: false }
                        : { repeatCurrent: false },
                    )
                  }
                />
                <span>Repeat current</span>
              </label>

              <label className="switch-field">
                <input
                  type="checkbox"
                  checked={settings.autoplayNext}
                  onChange={(event) =>
                    onPatchSettings(
                      event.currentTarget.checked
                        ? { autoplayNext: true, repeatCurrent: false }
                        : { autoplayNext: false },
                    )
                  }
                />
                <span>Autoplay next</span>
              </label>

              <label className="switch-field">
                <input
                  type="checkbox"
                  checked={settings.rememberRecentMedia}
                  onChange={(event) => onPatchSettings({ rememberRecentMedia: event.currentTarget.checked })}
                />
                <span>Remember recents</span>
              </label>

              <label className="switch-field">
                <input
                  type="checkbox"
                  checked={settings.autoHideControls}
                  onChange={(event) => onPatchSettings({ autoHideControls: event.currentTarget.checked })}
                />
                <span>Auto hide controls</span>
              </label>

              <label className="switch-field">
                <input
                  type="checkbox"
                  checked={settings.audioMultiWindow}
                  onChange={(event) => onPatchSettings({ audioMultiWindow: event.currentTarget.checked })}
                />
                <span>Multiple audio windows</span>
              </label>
            </div>

            <div className="viewer-note">
              <strong>Audio viewer</strong>
              <span>New audio files replace the current song unless multiple audio windows are enabled.</span>
            </div>

            <div className="viewer-note settings-cache-note">
              <strong>Thumbnail cache</strong>
              <span>Cover-art and media previews share the same cache root.</span>
              <button type="button" onClick={onClearThumbnailCache}>Clear thumbnail cache</button>
            </div>
          </div>
        ) : null}

        {activeTab === "engine" ? (
          <div className="settings-engine-view">
            <div className="backend-panel" aria-label="Playback backend">
              <div className="backend-panel-title">
                <strong>Fallback engine</strong>
                <span>{fallbackStatusLabel}</span>
              </div>
              <div className="backend-choice">
                {[
                  ["auto", "Auto"],
                  ["gstreamer", "GStreamer"],
                  ["off", "Off"],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    className={settings.fallbackEngine === value ? "active" : ""}
                    onClick={() =>
                      onPatchSettings({
                        fallbackEngine: value as PlayerSettings["fallbackEngine"],
                      })
                    }
                  >
                    {label}
                  </button>
                ))}
                <button
                  onClick={onOpenCurrentWithGstreamer}
                  disabled={!currentPath || isStaticViewer || !gstreamerAvailable}
                  title="Open current media through the external GStreamer fallback"
                >
                  Test
                </button>
              </div>
            </div>

            <div className="backend-card-grid">
              {playbackBackends.map((backend) => (
                <div key={backend.id} className={`backend-card ${backend.available ? "ready" : ""}`}>
                  <strong>{backend.name}</strong>
                  <span>{backend.role}</span>
                  <small>{backend.available ? backend.version ?? "ready" : "missing"}</small>
                </div>
              ))}
            </div>

            <div className="viewer-note settings-cache-note">
              <strong>Thumbnail cache</strong>
              <span>Reserved for LMP previews under AppData/LMP/cache/thumbnails.</span>
              <button type="button" onClick={onClearThumbnailCache}>Clear thumbnail cache</button>
            </div>
          </div>
        ) : null}

        {activeTab === "viewer" ? (
          <div className="settings-grid compact-settings-grid">
            <div className="settings-switches viewer-switches">
              <label className="switch-field">
                <input
                  type="checkbox"
                  checked={settings.rememberRecentMedia}
                  onChange={(event) => onPatchSettings({ rememberRecentMedia: event.currentTarget.checked })}
                />
                <span>Remember recents</span>
              </label>

              <label className="switch-field">
                <input
                  type="checkbox"
                  checked={settings.autoHideControls}
                  onChange={(event) => onPatchSettings({ autoHideControls: event.currentTarget.checked })}
                />
                <span>Auto hide controls</span>
              </label>

              <label className="switch-field">
                <input
                  type="checkbox"
                  checked={settings.minimalControls}
                  onChange={(event) => onPatchSettings({ minimalControls: event.currentTarget.checked })}
                />
                <span>Minimal bar</span>
              </label>

              <label className="switch-field">
                <input
                  type="checkbox"
                  checked={settings.autoQueueFolder}
                  onChange={(event) => onPatchSettings({ autoQueueFolder: event.currentTarget.checked })}
                />
                <span>Folder queue</span>
              </label>
            </div>

            <div className="viewer-note">
              <strong>{isDocument ? "PDF viewer" : isText ? "Text viewer" : "Image viewer"}</strong>
              <span>
                {isDocument
                  ? "Video playback settings are hidden for documents."
                  : isText
                    ? "Video playback settings are hidden for text files."
                  : "Video playback settings are hidden for images."}
              </span>
            </div>

            <div className="viewer-note settings-cache-note">
              <strong>Thumbnail cache</strong>
              <span>Clears LMP-generated previews without touching source files.</span>
              <button type="button" onClick={onClearThumbnailCache}>Clear thumbnail cache</button>
            </div>
          </div>
        ) : null}

        {activeTab === "text" ? (
          <div className="settings-grid compact-settings-grid">
            <SettingStepper
              label="Font size"
              description="Editor text"
              unit="px"
              value={settings.textFontSize}
              min={10}
              max={24}
              step={1}
              onChange={(value) => onPatchSettings({ textFontSize: value })}
            />

            <SettingStepper
              label="Tab size"
              description="Indent width"
              unit="sp"
              value={settings.textTabSize}
              min={1}
              max={8}
              step={1}
              onChange={(value) => onPatchSettings({ textTabSize: value })}
            />

            <div className="speed-presets font-presets" aria-label="Text editor font">
              <span>Font</span>
              <div>
                {[
                  ["mono", "Mono"],
                  ["system", "System"],
                  ["sans", "Sans"],
                  ["serif", "Serif"],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    className={settings.textFontFamily === value ? "active" : ""}
                    onClick={() =>
                      onPatchSettings({
                        textFontFamily: value as PlayerSettings["textFontFamily"],
                      })
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="speed-presets font-presets" aria-label="Word document extraction format">
              <span>DOCX</span>
              <div>
                {[
                  ["structured", "Structured"],
                  ["plain", "Plain"],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    className={settings.textWordExtractionFormat === value ? "active" : ""}
                    onClick={() =>
                      onPatchSettings({
                        textWordExtractionFormat:
                          value as PlayerSettings["textWordExtractionFormat"],
                      })
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="settings-switches viewer-switches">
              <label className="switch-field">
                <input
                  type="checkbox"
                  checked={settings.textLineNumbers}
                  onChange={(event) => onPatchSettings({ textLineNumbers: event.currentTarget.checked })}
                />
                <span>Line numbers</span>
              </label>

              <label className="switch-field">
                <input
                  type="checkbox"
                  checked={settings.textWordWrap}
                  onChange={(event) => onPatchSettings({ textWordWrap: event.currentTarget.checked })}
                />
                <span>Word wrap</span>
              </label>

              <label className="switch-field">
                <input
                  type="checkbox"
                  checked={settings.rememberRecentMedia}
                  onChange={(event) => onPatchSettings({ rememberRecentMedia: event.currentTarget.checked })}
                />
                <span>Remember recents</span>
              </label>

              <label className="switch-field">
                <input
                  type="checkbox"
                  checked={settings.autoHideControls}
                  onChange={(event) => onPatchSettings({ autoHideControls: event.currentTarget.checked })}
                />
                <span>Auto hide controls</span>
              </label>
            </div>

            <div className="viewer-note">
              <strong>Text module</strong>
              <span>Plain files and editable Word extractions stay in the same editor flow.</span>
            </div>
          </div>
        ) : null}

        {activeTab === "textCode" ? (
          <div className="settings-grid compact-settings-grid">
            <div className="settings-switches viewer-switches">
              <label className="switch-field">
                <input
                  type="checkbox"
                  checked={settings.textSyntaxHighlighting}
                  onChange={(event) =>
                    onPatchSettings({ textSyntaxHighlighting: event.currentTarget.checked })
                  }
                />
                <span>Syntax colors</span>
              </label>

              <label className="switch-field">
                <input
                  type="checkbox"
                  checked={settings.textAutoCloseBrackets}
                  onChange={(event) =>
                    onPatchSettings({ textAutoCloseBrackets: event.currentTarget.checked })
                  }
                />
                <span>Auto pairs</span>
              </label>

              <label className="switch-field stacked">
                <input
                  type="checkbox"
                  checked={settings.enableIntegratedTerminal}
                  onChange={(event) =>
                    onPatchSettings({ enableIntegratedTerminal: event.currentTarget.checked })
                  }
                />
                <span>
                  <strong>Integrated terminal</strong>
                  <small>Show an optional terminal panel for running local scripts.</small>
                </span>
              </label>
            </div>

            <div className="viewer-note">
              <strong>Programming helpers</strong>
              <span>Optional code-focused behavior such as colors, pairs, and local script tools.</span>
            </div>
          </div>
        ) : null}

        {activeTab === "shortcuts" ? (
          <div className="shortcut-strip expanded" aria-label="Keyboard shortcuts">
            <span>F Fullscreen</span>
            {isText ? (
              <>
                <span>Ctrl+S Save</span>
                <span>Ctrl+Shift+S Save As</span>
                <span>Ctrl+O Open</span>
                <span>Ctrl+F Find</span>
                <span>Ctrl+H Replace</span>
                <span>Ctrl+G Go to line</span>
                <span>Ctrl+Z Undo</span>
                <span>Ctrl+Y Redo</span>
              </>
            ) : isImage ? (
              <>
                <span>Left/Right Previous/Next</span>
                <span>R Rotate</span>
                <span>+/- Zoom</span>
                <span>0 Reset image</span>
              </>
            ) : isDocument ? (
              <>
                <span>Left/Right Page</span>
                <span>PageUp/PageDown Page</span>
                <span>Wheel Zoom</span>
                <span>Drag Pan</span>
                <span>Ctrl+P Print</span>
                <span>+/- Zoom</span>
                <span>0 Reset PDF</span>
                <span>Ctrl+O Open</span>
              </>
            ) : isAudio ? (
              <>
                <span>Space Play/Pause</span>
                <span>Left/Right Seek</span>
                <span>Shift+Arrow Long seek</span>
                <span>Wheel Volume</span>
              </>
            ) : (
              <>
                <span>Space Play/Pause</span>
                <span>Left/Right Seek</span>
                <span>Shift+Arrow Long seek</span>
                <span>L Loop point</span>
                <span>Shift+L Clear loop</span>
                <span>C Captions</span>
              </>
            )}
          </div>
        ) : null}

        {activeTab === "updates" ? <AppUpdatePanel /> : null}
      </div>
    </div>
  );
}
