import type { PlayerSettings } from "../settings";

type CodeTabProps = {
  onPatchSettings: (patch: Partial<PlayerSettings>) => void;
  settings: PlayerSettings;
};

export function CodeTab({ onPatchSettings, settings }: CodeTabProps) {
  const patchCodeSetting = (patch: Partial<PlayerSettings>) => {
    onPatchSettings(patch);
  };

  return (
    <div className="settings-grid compact-settings-grid">
      <div className="settings-switches viewer-switches">
        <label className="switch-field">
          <input
            type="checkbox"
            checked={settings.textSyntaxHighlighting}
            onChange={(event) =>
              patchCodeSetting({ textSyntaxHighlighting: event.currentTarget.checked })
            }
          />
          <span>Syntax colors</span>
        </label>

        <label className="switch-field">
          <input
            type="checkbox"
            checked={settings.textAutoCloseBrackets}
            onChange={(event) =>
              patchCodeSetting({ textAutoCloseBrackets: event.currentTarget.checked })
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
  );
}
