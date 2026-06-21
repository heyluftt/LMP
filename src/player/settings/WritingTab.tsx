import type { PlayerSettings } from "../settings";
type WritingTabProps = {
  onPatchSettings: (patch: Partial<PlayerSettings>) => void;
  settings: PlayerSettings;
};

export function WritingTab({
  onPatchSettings,
  settings,
}: WritingTabProps) {
  const patchWritingSetting = (patch: Partial<PlayerSettings>) => {
    onPatchSettings(patch);
  };

  return (
    <div className="settings-grid compact-settings-grid writing-settings-grid">
      <label className="switch-field writing-mode-switch">
        <input
          type="checkbox"
          checked={settings.textWritingMode}
          onChange={(event) =>
            patchWritingSetting({ textWritingMode: event.currentTarget.checked })
          }
        />
        <div>
          <strong>Writing mode</strong>
          <span>Centered long-form layout for reading and drafting.</span>
        </div>
      </label>
    </div>
  );
}
