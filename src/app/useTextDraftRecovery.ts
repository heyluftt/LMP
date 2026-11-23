import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

import type { TextDraftSnapshot, TextDraftSummary } from "../viewers/text/textDrafts";

const draftWriteDelayMs = 700;

type UseTextDraftRecoveryOptions = {
  /** Builds the snapshot to store, or null when the document should not be kept. */
  buildSnapshot: () => TextDraftSnapshot | null;
};

/**
 * Keeps crash-safe drafts of unsaved text documents. Writes are debounced and
 * driven by `notifyChange`, so typing never re-renders the app.
 */
export function useTextDraftRecovery({ buildSnapshot }: UseTextDraftRecoveryOptions) {
  const [drafts, setDrafts] = useState<TextDraftSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const timerRef = useRef<number | null>(null);
  const buildSnapshotRef = useRef(buildSnapshot);
  const writtenIdsRef = useRef(new Set<string>());
  buildSnapshotRef.current = buildSnapshot;

  const refreshDrafts = useCallback(async () => {
    try {
      const next = await invoke<TextDraftSummary[]>("list_text_drafts");
      setDrafts(next);
      return next;
    } catch {
      return [];
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refreshDrafts();
  }, [refreshDrafts]);

  const cancelScheduledWrite = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const writeNow = useCallback(async () => {
    cancelScheduledWrite();
    const snapshot = buildSnapshotRef.current();
    if (!snapshot) {
      return;
    }
    writtenIdsRef.current.add(snapshot.id);
    await invoke("write_text_draft", { snapshot }).catch(() => undefined);
  }, [cancelScheduledWrite]);

  /** Call after every edit of a dirty document; the write happens once typing pauses. */
  const notifyChange = useCallback(() => {
    cancelScheduledWrite();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void writeNow();
    }, draftWriteDelayMs);
  }, [cancelScheduledWrite, writeNow]);

  const clearDraft = useCallback(
    async (id: string) => {
      cancelScheduledWrite();
      writtenIdsRef.current.delete(id);
      setDrafts((current) => current.filter((draft) => draft.id !== id));
      await invoke("clear_text_draft", { id }).catch(() => undefined);
    },
    [cancelScheduledWrite],
  );

  /** Clears the draft only if this window wrote it, e.g. after the document became clean. */
  const releaseDraft = useCallback(
    async (id: string) => {
      cancelScheduledWrite();
      if (writtenIdsRef.current.has(id)) {
        await clearDraft(id);
      }
    },
    [cancelScheduledWrite, clearDraft],
  );

  const readDraft = useCallback(async (id: string) => {
    try {
      const snapshot = await invoke<TextDraftSnapshot | null>("read_text_draft", { id });
      if (snapshot) {
        writtenIdsRef.current.add(id);
      }
      return snapshot;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => cancelScheduledWrite, [cancelScheduledWrite]);

  return {
    cancelScheduledWrite,
    clearDraft,
    drafts,
    loaded,
    notifyChange,
    readDraft,
    refreshDrafts,
    releaseDraft,
    writeNow,
  };
}
