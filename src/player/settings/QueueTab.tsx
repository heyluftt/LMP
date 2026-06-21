import type { PlayerSettings } from "../settings";

type QueueTabProps = {
  onPatchSettings: (patch: Partial<PlayerSettings>) => void;
  settings: PlayerSettings;
};

export function QueueTab({ onPatchSettings, settings }: QueueTabProps) {
  return (
    <div className="settings-grid compact-settings-grid queue-settings-grid">
      <div className="settings-switches queue-settings-switches">
        <label className="switch-field stacked">
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
          <span>
            <strong>Autoplay next</strong>
            <small>Continue into the next queued item after media ends.</small>
          </span>
        </label>

        <label className="switch-field stacked">
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
          <span>
            <strong>Repeat current</strong>
            <small>Replay the current item and ignore autoplay next.</small>
          </span>
        </label>

        <label className="switch-field stacked">
          <input
            type="checkbox"
            checked={settings.autoQueueFolder}
            onChange={(event) => onPatchSettings({ autoQueueFolder: event.currentTarget.checked })}
          />
          <span>
            <strong>Folder queue</strong>
            <small>When one media file opens, queue compatible siblings nearby.</small>
          </span>
        </label>

        <label className="switch-field stacked">
          <input
            type="checkbox"
            checked={settings.audioMultiWindow}
            onChange={(event) => onPatchSettings({ audioMultiWindow: event.currentTarget.checked })}
          />
          <span>
            <strong>Multiple audio windows</strong>
            <small>Open separate audio windows instead of replacing the current song.</small>
          </span>
        </label>

        <label className="switch-field stacked">
          <input
            type="checkbox"
            checked={settings.rememberRecentMedia}
            onChange={(event) => onPatchSettings({ rememberRecentMedia: event.currentTarget.checked })}
          />
          <span>
            <strong>Remember recents</strong>
            <small>Keep recently opened items available from Home and the shelf.</small>
          </span>
        </label>
      </div>
    </div>
  );
}
