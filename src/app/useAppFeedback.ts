import { useCallback, useEffect, useRef, useState } from "react";
import type { ChoiceDialog, ConfirmDialog, PromptDialog, Toast, ToastTone } from "./appTypes";

type PromptRequest = Partial<PromptDialog> & {
  initialValue?: string;
};

export function useAppFeedback() {
  const [toast, setToast] = useState<Toast | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialog | null>(null);
  const [promptDialog, setPromptDialog] = useState<PromptDialog | null>(null);
  const [promptInput, setPromptInput] = useState("");
  const [choiceDialog, setChoiceDialog] = useState<ChoiceDialog | null>(null);

  const toastTimerRef = useRef<number | null>(null);
  const confirmDialogResolverRef = useRef<((value: boolean) => void) | null>(null);
  const promptDialogResolverRef = useRef<((value: string | null) => void) | null>(null);
  const choiceDialogResolverRef = useRef<((value: string | null) => void) | null>(null);

  const showToast = useCallback((message: string, tone: ToastTone = "info") => {
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }

    setToast({ message, tone });
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 4400);
  }, []);

  const settleConfirmDialog = useCallback((value: boolean) => {
    const resolver = confirmDialogResolverRef.current;
    confirmDialogResolverRef.current = null;
    setConfirmDialog(null);
    resolver?.(value);
  }, []);

  const requestConfirm = useCallback((dialog: Partial<ConfirmDialog>) => {
    confirmDialogResolverRef.current?.(false);
    return new Promise<boolean>((resolve) => {
      confirmDialogResolverRef.current = resolve;
      setConfirmDialog({
        cancelLabel: dialog.cancelLabel ?? "Cancel",
        confirmLabel: dialog.confirmLabel ?? "Discard",
        message: dialog.message ?? "Continue?",
        title: dialog.title ?? "Confirm",
        tone: dialog.tone ?? "normal",
      });
    });
  }, []);

  const settleChoiceDialog = useCallback((value: string | null) => {
    const resolver = choiceDialogResolverRef.current;
    choiceDialogResolverRef.current = null;
    setChoiceDialog(null);
    resolver?.(value);
  }, []);

  const requestChoice = useCallback((dialog: Partial<ChoiceDialog> & Pick<ChoiceDialog, "choices">) => {
    choiceDialogResolverRef.current?.(null);
    return new Promise<string | null>((resolve) => {
      choiceDialogResolverRef.current = resolve;
      setChoiceDialog({
        cancelLabel: dialog.cancelLabel ?? "Cancel",
        choices: dialog.choices,
        message: dialog.message ?? "",
        title: dialog.title ?? "Choose",
      });
    });
  }, []);

  const settlePromptDialog = useCallback((value: string | null) => {
    const resolver = promptDialogResolverRef.current;
    promptDialogResolverRef.current = null;
    setPromptDialog(null);
    resolver?.(value);
  }, []);

  const requestPrompt = useCallback((dialog: PromptRequest) => {
    promptDialogResolverRef.current?.(null);
    return new Promise<string | null>((resolve) => {
      promptDialogResolverRef.current = resolve;
      setPromptInput(dialog.initialValue ?? "");
      setPromptDialog({
        cancelLabel: dialog.cancelLabel ?? "Cancel",
        confirmLabel: dialog.confirmLabel ?? "Go",
        message: dialog.message ?? "",
        title: dialog.title ?? "Input",
      });
    });
  }, []);

  useEffect(
    () => () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
      confirmDialogResolverRef.current?.(false);
      promptDialogResolverRef.current?.(null);
      choiceDialogResolverRef.current?.(null);
    },
    [],
  );

  return {
    choiceDialog,
    confirmDialog,
    promptDialog,
    promptInput,
    requestChoice,
    requestConfirm,
    requestPrompt,
    setPromptInput,
    settleChoiceDialog,
    settleConfirmDialog,
    settlePromptDialog,
    showToast,
    toast,
  };
}
