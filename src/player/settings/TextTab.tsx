import type { PlayerSettings } from "../settings";
import { SettingStepper } from "./SettingStepper";

type TextTabProps = {
  onPatchSettings: (patch: Partial<PlayerSettings>) => void;
  settings: PlayerSettings;
};

export function TextTab({
  onPatchSettings,
  settings,
}: TextTabProps) {
  const patchTextSetting = (patch: Partial<PlayerSettings>) => {
    onPatchSettings(patch);
  };

  return (
    <div className="settings-grid compact-settings-grid">
      <SettingStepper
        label="Font size"
        description="Editor text"
        unit="px"
        value={settings.textFontSize}
        min={10}
        max={24}
        step={1}
        onChange={(value) => patchTextSetting({ textFontSize: value })}
      />

      <SettingStepper
        label="Tab size"
        description="Indent width"
        unit="sp"
        value={settings.textTabSize}
        min={1}
        max={8}
        step={1}
        onChange={(value) => patchTextSetting({ textTabSize: value })}
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
                patchTextSetting({
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
                patchTextSetting({
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
            onChange={(event) => patchTextSetting({ textLineNumbers: event.currentTarget.checked })}
          />
          <span>Line numbers</span>
        </label>

        <label className="switch-field">
          <input
            type="checkbox"
            checked={settings.textWordWrap}
            onChange={(event) => patchTextSetting({ textWordWrap: event.currentTarget.checked })}
          />
          <span>Word wrap</span>
        </label>

        <label className="switch-field">
          <input
            type="checkbox"
            checked={settings.autoHideControls}
            onChange={(event) =>
              patchTextSetting({ autoHideControls: event.currentTarget.checked })
            }
          />
          <span>Auto hide controls</span>
        </label>
      </div>

      <div className="viewer-note text-module-note">
        <strong>Text module</strong>
        <span>Plain files and editable Word extractions stay in the same editor flow.</span>
      </div>
    </div>
  );
}
