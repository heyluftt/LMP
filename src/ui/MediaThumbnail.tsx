import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

import { mediaKind, type MediaKind } from "../lib/playerBrain";
import type { MediaThumbnail as MediaThumbnailResult } from "../player/types";
import { MediaFileIcon } from "./MediaFileIcon";

type MediaThumbnailProps = {
  path: string;
  kind?: MediaKind | "folder";
  size?: number;
};

export function MediaThumbnail({ path, kind = mediaKind(path), size = 17 }: MediaThumbnailProps) {
  const [visible, setVisible] = useState(false);
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const rootRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }

    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
        }
      },
      { rootMargin: "180px" },
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setThumbnailUrl(null);
    if (!visible || kind === "folder") {
      return;
    }

    let cancelled = false;
    invoke<MediaThumbnailResult>("get_media_thumbnail", { path })
      .then((thumbnail) => {
        if (cancelled) {
          return;
        }
        setThumbnailUrl(thumbnail.path ? convertFileSrc(thumbnail.path) : null);
      })
      .catch(() => {
        if (!cancelled) {
          setThumbnailUrl(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [kind, path, visible]);

  return (
    <span ref={rootRef} className={`media-thumb ${thumbnailUrl ? "has-preview" : ""}`} aria-hidden="true">
      {thumbnailUrl ? (
        <img src={thumbnailUrl} alt="" loading="lazy" draggable={false} />
      ) : (
        <MediaFileIcon path={path} size={size} />
      )}
    </span>
  );
}
