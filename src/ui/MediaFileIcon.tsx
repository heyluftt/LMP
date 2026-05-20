import { FileText, FileVideo, ImageIcon, Music2 } from "lucide-react";

import { mediaKind } from "../lib/playerBrain";

type MediaFileIconProps = {
  path: string;
  size?: number;
};

export function MediaFileIcon({ path, size = 15 }: MediaFileIconProps) {
  const kind = mediaKind(path);
  if (kind === "audio") {
    return <Music2 size={size} />;
  }
  if (kind === "image") {
    return <ImageIcon size={size} />;
  }
  if (kind === "document" || kind === "text") {
    return <FileText size={size} />;
  }
  return <FileVideo size={size} />;
}
