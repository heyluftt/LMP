import { Download, RefreshCw, Settings2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";

import { formatBytes } from "../lib/mediaFormat";
import type { MediaKind } from "../lib/playerBrain";
import { playbackBackendDisplay } from "./playbackEnginePolicy";
import { CacheTab } from "./settings/CacheTab";
import { CodeTab } from "./settings/CodeTab";
import { QueueTab } from "./settings/QueueTab";
import { SettingStepper } from "./settings/SettingStepper";
import { ShortcutsTab } from "./settings/ShortcutsTab";
import { TextTab } from "./settings/TextTab";
import { WritingTab } from "./settings/WritingTab";
import type { PlayerSettings } from "./settings";
import type { PlaybackBackendStatus, SettingsCacheStatus } from "./types";

export type SettingsTab =
  | "controls"
  | "playback"
  | "queue"
  | "engine"
  | "cache"
  | "audio"
  | "viewer"
  | "text"
  | "writing"
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
  { id: "queue", label: "Queue" },
  { id: "engine", label: "Engine" },
  { id: "cache", label: "Cache" },
  { id: "updates", label: "Updates" },
  { id: "shortcuts", label: "Keys" },
];

export const viewerSettingsTabs: SettingsTabDefinition[] = [
  { id: "viewer", label: "Viewer" },
  { id: "queue", label: "Queue" },
  { id: "cache", label: "Cache" },
  { id: "updates", label: "Updates" },
  { id: "shortcuts", label: "Keys" },
];

export const audioSettingsTabs: SettingsTabDefinition[] = [
  { id: "audio", label: "Audio" },
  { id: "queue", label: "Queue" },
  { id: "cache", label: "Cache" },
  { id: "updates", label: "Updates" },
  { id: "shortcuts", label: "Keys" },
];

export const textSettingsTabs: SettingsTabDefinition[] = [
  { id: "text", label: "Text" },
  { id: "writing", label: "Writing" },
  { id: "textCode", label: "Code" },
  { id: "cache", label: "Cache" },
  { id: "updates", label: "Updates" },
  { id: "shortcuts", label: "Keys" },
];

export function settingsTabsFor(kind: MediaKind) {
  if (kind === "unknown") {
    return playerSettingsTabs;
  }
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

type SettingsPanelProps = {
  activeTab: SettingsTab;
  currentPath: string | null;
  fallbackStatusLabel: string;
  gstreamerAvailable: boolean;
  libMpvAvailable: boolean;
  isAudio: boolean;
  isDocument: boolean;
  isImage: boolean;
  isStaticViewer: boolean;
  isText: boolean;
  cacheStatus: SettingsCacheStatus | null;
  onClearMediaProbeCache: () => void;
  onClearPreparedVideoCache: () => void;
  onClearPreviewCache: () => void;
  onClose: () => void;
  onOpenCurrentWithGstreamer: () => void;
  onPatchSettings: (patch: Partial<PlayerSettings>) => void;
  onPinControls: (pinned: boolean) => void;
  onReset: () => void;
  onSetPlayerSpeed: (speed: number) => void;
  onTabChange: (tab: SettingsTab) => void;
  onUpdateInstallLockChange: (locked: boolean) => void;
  playbackBackends: PlaybackBackendStatus[];
  settings: PlayerSettings;
  speed: number;
  tabs: SettingsTabDefinition[];
  updateInstallLocked: boolean;
};

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
    return formatBytes(downloadedBytes) || "Starting";
  }
  return `${Math.round((downloadedBytes / contentLength) * 100)}%`;
}

function AppUpdatePanel({
  onInstallLockChange,
}: {
  onInstallLockChange: (locked: boolean) => void;
}) {
  const updateRef = useRef<Update | null>(null);
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [details, setDetails] = useState<UpdateDetails | null>(null);
  const [message, setMessage] = useState("Check manually when you want to look for a new LMP build.");
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [contentLength, setContentLength] = useState<number | null>(null);

  const busy = status === "checking" || status === "installing" || status === "restarting";
  const installReady = status === "available" && updateRef.current !== null;
  const installLocked = status === "installing" || status === "restarting";
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
      onInstallLockChange(false);
      if (updateRef.current) {
        void updateRef.current.close().catch(() => undefined);
        updateRef.current = null;
      }
    };
  }, [onInstallLockChange]);

  useEffect(() => {
    onInstallLockChange(installLocked);
  }, [installLocked, onInstallLockChange]);

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
      const notes = nextUpdate.body?.trim();
      setDetails({
        currentVersion: nextUpdate.currentVersion,
        date: nextUpdate.date,
        notes: notes || undefined,
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
            {details.notes ? (
              <div className="update-notes" aria-label="Update notes">
                {details.notes}
              </div>
            ) : null}
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
  cacheStatus,
  currentPath,
  fallbackStatusLabel,
  gstreamerAvailable,
  libMpvAvailable,
  isAudio,
  isDocument,
  isImage,
  isStaticViewer,
  isText,
  onClearMediaProbeCache,
  onClearPreparedVideoCache,
  onClearPreviewCache,
  onClose,
  onOpenCurrentWithGstreamer,
  onPatchSettings,
  onPinControls,
  onReset,
  onSetPlayerSpeed,
  onTabChange,
  onUpdateInstallLockChange,
  playbackBackends,
  settings,
  speed,
  tabs,
  updateInstallLocked,
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
          <button onClick={onReset} disabled={updateInstallLocked}>
            Reset
          </button>
          <button
            className="shelf-close"
            onClick={onClose}
            disabled={updateInstallLocked}
            title={updateInstallLocked ? "Update installation is running" : "Close settings"}
            aria-label="Close settings"
          >
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
            disabled={updateInstallLocked}
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
              description="Hover controls"
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
                  checked={settings.centerVideoWindowAfterResize}
                  onChange={(event) =>
                    onPatchSettings({ centerVideoWindowAfterResize: event.currentTarget.checked })
                  }
                />
                <span>Center after resize</span>
              </label>
            </div>
          </div>
        ) : null}

        {activeTab === "queue" ? <QueueTab onPatchSettings={onPatchSettings} settings={settings} /> : null}

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
          </div>
        ) : null}

        {activeTab === "cache" ? (
          <CacheTab
            cacheStatus={cacheStatus}
            onClearMediaProbeCache={onClearMediaProbeCache}
            onClearPreparedVideoCache={onClearPreparedVideoCache}
            onClearPreviewCache={onClearPreviewCache}
          />
        ) : null}

        {activeTab === "engine" ? (
          <div className="settings-engine-view">
            <div className="backend-panel" aria-label="Playback backend">
              <div className="backend-panel-title">
                <strong>Playback path</strong>
                <span>{fallbackStatusLabel}</span>
              </div>
              <div className="backend-summary-card">
                <strong>Default</strong>
                <span>Native WebView stays primary. Other engines are fallback paths.</span>
              </div>
              <div className="backend-choice">
                <div className="backend-choice-group" aria-label="Playback path mode">
                  {[
                    { value: "auto", label: "Auto" },
                    {
                      value: "embedded-mpv",
                      label: "Embedded MPV",
                      disabled: !libMpvAvailable,
                      title: libMpvAvailable
                        ? "Use the embedded MPV render path for videos."
                        : "Embedded MPV runtime is not available.",
                    },
                    { value: "gstreamer", label: "GStreamer" },
                    { value: "off", label: "Native only" },
                  ].map(({ value, label, disabled, title }) => (
                    <button
                      key={value}
                      className={`backend-mode-button ${settings.fallbackEngine === value ? "active" : ""}`}
                      disabled={disabled && settings.fallbackEngine !== value}
                      title={title}
                      onClick={() =>
                        onPatchSettings({
                          fallbackEngine: value as PlayerSettings["fallbackEngine"],
                        })
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="backend-action-group" aria-label="Playback test actions">
                  <button
                    className="backend-test-button"
                    onClick={onOpenCurrentWithGstreamer}
                    disabled={!currentPath || isStaticViewer || !gstreamerAvailable}
                    title="Open current media through the external GStreamer fallback"
                  >
                    Test current file with GStreamer
                  </button>
                </div>
              </div>
            </div>

            <div className="backend-card-grid">
              {playbackBackends.map((backend) => {
                const display = playbackBackendDisplay(backend);
                return (
                  <div
                    key={backend.id}
                    className={`backend-card ${backend.available ? "ready" : ""}`}
                    title={display.title}
                  >
                    <strong>{backend.name}</strong>
                    <span>{display.role}</span>
                    <small>{display.status}</small>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {activeTab === "viewer" ? (
          <div className="settings-grid compact-settings-grid">
            <div className="settings-switches viewer-switches">
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
          </div>
        ) : null}

        {activeTab === "text" ? (
          <TextTab
            onPatchSettings={onPatchSettings}
            settings={settings}
          />
        ) : null}

        {activeTab === "writing" ? (
          <WritingTab
            onPatchSettings={onPatchSettings}
            settings={settings}
          />
        ) : null}

        {activeTab === "textCode" ? (
          <CodeTab onPatchSettings={onPatchSettings} settings={settings} />
        ) : null}

        {activeTab === "shortcuts" ? (
          <ShortcutsTab
            isAudio={isAudio}
            isDocument={isDocument}
            isImage={isImage}
            isText={isText}
          />
        ) : null}

        {activeTab === "updates" ? <AppUpdatePanel onInstallLockChange={onUpdateInstallLockChange} /> : null}
      </div>
    </div>
  );
}
