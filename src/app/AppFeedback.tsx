import { useEffect, useRef } from "react";
import type { ChoiceDialog, ConfirmDialog, PromptDialog, Toast } from "./appTypes";

type AppFeedbackProps = {
  choiceDialog: ChoiceDialog | null;
  confirmDialog: ConfirmDialog | null;
  promptDialog: PromptDialog | null;
  promptInput: string;
  settleChoiceDialog: (value: string | null) => void;
  settleConfirmDialog: (value: boolean) => void;
  settlePromptDialog: (value: string | null) => void;
  setPromptInput: (value: string) => void;
  toast: Toast | null;
};

function ChoiceDialogView({
  dialog,
  onSettle,
}: {
  dialog: ChoiceDialog;
  onSettle: (value: string | null) => void;
}) {
  const primaryRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    primaryRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onSettle(null);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onSettle]);

  const primaryIndex = Math.max(
    0,
    dialog.choices.findIndex((choice) => choice.tone === "primary"),
  );

  return (
    <div className="confirm-backdrop" data-wheel-volume="ignore" role="presentation">
      <div className="confirm-dialog choice-dialog" role="alertdialog" aria-modal="true" aria-labelledby="choice-title">
        <strong id="choice-title">{dialog.title}</strong>
        <p>{dialog.message}</p>
        <div className="confirm-actions">
          <button type="button" onClick={() => onSettle(null)}>
            {dialog.cancelLabel}
          </button>
          {dialog.choices.map((choice, index) => (
            <button
              key={choice.id}
              ref={index === primaryIndex ? primaryRef : undefined}
              type="button"
              className={choice.tone === "primary" ? "primary" : choice.tone === "danger" ? "danger" : ""}
              onClick={() => onSettle(choice.id)}
            >
              {choice.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function AppFeedback({
  choiceDialog,
  confirmDialog,
  promptDialog,
  promptInput,
  settleChoiceDialog,
  settleConfirmDialog,
  settlePromptDialog,
  setPromptInput,
  toast,
}: AppFeedbackProps) {
  return (
    <>
      {confirmDialog ? (
        <div className="confirm-backdrop" data-wheel-volume="ignore" role="presentation">
          <div
            className={`confirm-dialog ${confirmDialog.tone === "danger" ? "danger" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
          >
            <strong id="confirm-title">{confirmDialog.title}</strong>
            <p>{confirmDialog.message}</p>
            <div className="confirm-actions">
              <button type="button" onClick={() => settleConfirmDialog(false)}>
                {confirmDialog.cancelLabel}
              </button>
              <button type="button" className="primary" onClick={() => settleConfirmDialog(true)}>
                {confirmDialog.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {choiceDialog ? <ChoiceDialogView dialog={choiceDialog} onSettle={settleChoiceDialog} /> : null}

      {promptDialog ? (
        <div className="confirm-backdrop" data-wheel-volume="ignore" role="presentation">
          <form
            className="confirm-dialog prompt-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="prompt-title"
            onSubmit={(event) => {
              event.preventDefault();
              settlePromptDialog(promptInput);
            }}
          >
            <strong id="prompt-title">{promptDialog.title}</strong>
            <p>{promptDialog.message}</p>
            <input
              autoFocus
              type="text"
              value={promptInput}
              onChange={(event) => setPromptInput(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  settlePromptDialog(null);
                }
              }}
            />
            <div className="confirm-actions">
              <button type="button" onClick={() => settlePromptDialog(null)}>
                {promptDialog.cancelLabel}
              </button>
              <button type="submit" className="primary">
                {promptDialog.confirmLabel}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {toast ? <div className={`toast ${toast.tone}`}>{toast.message}</div> : null}
    </>
  );
}
