import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { needsContentKind, rememberContentKind, type MediaKind } from "../lib/playerBrain";

/**
 * Asks the backend whether unchecked `.ts`/`.mts` files are video or text, so
 * `mediaKind` answers correctly before the files are opened. Resolves to true
 * when at least one kind was learned.
 */
export async function resolveContentKinds(paths: string[]) {
  const pending = [...new Set(paths.filter(needsContentKind))];
  if (pending.length === 0) {
    return false;
  }
  try {
    const kinds = await invoke<MediaKind[]>("resolve_media_kinds", { paths: pending });
    pending.forEach((path, index) => rememberContentKind(path, kinds[index] ?? "unknown"));
    return true;
  } catch {
    return false;
  }
}

/** Changes once the kinds of `paths` are known; list it as a memo dependency next to `paths`. */
export function useContentKinds(paths: string[]) {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    void resolveContentKinds(paths).then((learned) => {
      if (learned && active) {
        setVersion((current) => current + 1);
      }
    });
    return () => {
      active = false;
    };
  }, [paths]);
  return version;
}
