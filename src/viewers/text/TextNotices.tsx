import { FileWarning, History, Info, Lock, RotateCcw, TriangleAlert, X } from "lucide-react";
import type { ReactNode } from "react";

import { fileName } from "../../lib/playerBrain";
import { textEncodingLabel } from "./textEncodings";
import { textLineEndingLabel, type TextDocument } from "./textModel";

export type TextNoticeAction = {
  label: string;
  onSelect: () => void;
  primary?: boolean;
};

export type TextNotice = {
  id: string;
  tone: "info" | "warning" | "danger";
  icon: ReactNode;
  title: string;
  message: string;
  actions: TextNoticeAction[];
  dismissible: boolean;
};

export type TextNoticeHandlers = {
  dirty: boolean;
  onDiscardRestoredDraft: () => void;
  onDismissRestored: () => void;
  onKeepLocal: () => void;
  onPickEncoding: () => void;
  onReload: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onUnlock: () => void;
};

function formatTime(timestamp: number) {
  const date = new Date(timestamp);
  const sameDay = new Date().toDateString() === date.toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function textNoticesFor(doc: TextDocument, handlers: TextNoticeHandlers): TextNotice[] {
  const notices: TextNotice[] = [];

  if (doc.externalChange === "changed") {
    notices.push({
      id: "external-changed",
      tone: "danger",
      icon: <TriangleAlert size={15} />,
      title: "Changed on disk",
      message: handlers.dirty
        ? "Another program changed this file. Reload to see its version, or keep yours and overwrite it on save."
        : "Another program changed this file.",
      actions: [
        { label: "Reload", onSelect: handlers.onReload, primary: !handlers.dirty },
        { label: "Keep mine", onSelect: handlers.onKeepLocal, primary: handlers.dirty },
      ],
      dismissible: false,
    });
  }

  if (doc.externalChange === "deleted") {
    notices.push({
      id: "external-deleted",
      tone: "danger",
      icon: <FileWarning size={15} />,
      title: "File missing",
      message: "The file was deleted, renamed or moved. Save to write it again.",
      actions: [
        { label: "Save", onSelect: handlers.onSave, primary: true },
        { label: "Save As…", onSelect: handlers.onSaveAs },
      ],
      dismissible: true,
    });
  }

  if (doc.restoredDraftAt !== null) {
    notices.push({
      id: `restored-${doc.restoredDraftAt}`,
      tone: "info",
      icon: <History size={15} />,
      title: "Draft restored",
      message: `These are the unsaved changes from ${formatTime(doc.restoredDraftAt)}. Save to keep them.`,
      actions: [
        { label: "Save", onSelect: handlers.onSave, primary: true },
        { label: "Discard draft", onSelect: handlers.onDiscardRestoredDraft },
      ],
      dismissible: false,
    });
  }

  if (doc.sourceType === "word-extract") {
    notices.push({
      id: "word-extract",
      tone: "info",
      icon: <Info size={15} />,
      title: "Editable extracted copy",
      message: `Original: ${doc.originalPath ? fileName(doc.originalPath) : "Word document"}. Saving creates a new text file; the Word document stays unchanged.`,
      actions: [{ label: "Save As…", onSelect: handlers.onSaveAs }],
      dismissible: true,
    });
  }

  if (doc.locked && doc.binary) {
    notices.push({
      id: "binary",
      tone: "warning",
      icon: <FileWarning size={15} />,
      title: "Binary data",
      message: "This file does not look like text. Editing and saving it can damage it.",
      actions: [{ label: "Edit anyway", onSelect: handlers.onUnlock }],
      dismissible: true,
    });
  } else if (doc.locked && doc.readOnly) {
    notices.push({
      id: "read-only",
      tone: "warning",
      icon: <Lock size={15} />,
      title: "Read-only file",
      message: "Windows marks this file as read-only. You can still edit it and decide how to save.",
      actions: [
        { label: "Edit anyway", onSelect: handlers.onUnlock, primary: true },
        { label: "Save As…", onSelect: handlers.onSaveAs },
      ],
      dismissible: true,
    });
  }

  if (doc.decodeErrors && !doc.binary) {
    notices.push({
      id: `decode-${doc.encoding}`,
      tone: "warning",
      icon: <TriangleAlert size={15} />,
      title: "Unreadable characters",
      message: `Some bytes are not valid ${textEncodingLabel(doc.encoding)} and show as \u{fffd}. Saving would replace them.`,
      actions: [{ label: "Reopen with encoding…", onSelect: handlers.onPickEncoding, primary: true }],
      dismissible: true,
    });
  } else if (doc.encodingSource === "fallback" && !doc.binary) {
    notices.push({
      id: `fallback-${doc.encoding}`,
      tone: "info",
      icon: <Info size={15} />,
      title: textEncodingLabel(doc.encoding),
      message: "This file is not valid UTF-8, so LMP opened it with the Windows default encoding.",
      actions: [{ label: "Choose encoding…", onSelect: handlers.onPickEncoding }],
      dismissible: true,
    });
  }

  if (doc.mixedLineEndings) {
    notices.push({
      id: "mixed-line-endings",
      tone: "info",
      icon: <RotateCcw size={15} />,
      title: "Mixed line endings",
      message: `Saving converts every line ending to ${textLineEndingLabel(doc.lineEnding)}.`,
      actions: [],
      dismissible: true,
    });
  }

  if (doc.large) {
    notices.push({
      id: "large-file",
      tone: "info",
      icon: <Info size={15} />,
      title: "Large file",
      message: "Syntax highlighting, folding and draft recovery are off to keep editing smooth.",
      actions: [],
      dismissible: true,
    });
  }

  return notices;
}

type TextNoticesProps = {
  dismissed: Set<string>;
  notices: TextNotice[];
  onDismiss: (id: string) => void;
};

export function TextNotices({ dismissed, notices, onDismiss }: TextNoticesProps) {
  const visible = notices.filter((notice) => !dismissed.has(notice.id));
  if (visible.length === 0) {
    return null;
  }
  return (
    <div className="text-notices" data-wheel-volume="ignore">
      {visible.map((notice) => (
        <div key={notice.id} className={`text-notice tone-${notice.tone}`} role={notice.tone === "danger" ? "alert" : "status"}>
          <span className="text-notice-icon">{notice.icon}</span>
          <span className="text-notice-copy">
            <strong>{notice.title}</strong>
            <span>{notice.message}</span>
          </span>
          <span className="text-notice-actions">
            {notice.actions.map((action) => (
              <button
                key={action.label}
                type="button"
                className={action.primary ? "primary" : ""}
                onClick={action.onSelect}
              >
                {action.label}
              </button>
            ))}
            {notice.dismissible ? (
              <button type="button" className="text-notice-dismiss" onClick={() => onDismiss(notice.id)} aria-label="Dismiss" title="Dismiss">
                <X size={14} />
              </button>
            ) : null}
          </span>
        </div>
      ))}
    </div>
  );
}
