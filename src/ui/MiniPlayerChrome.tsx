import { Maximize2 } from "lucide-react";

type MiniPlayerChromeProps = {
  onExitMiniPlayer: () => void;
};

export function MiniPlayerChrome({ onExitMiniPlayer }: MiniPlayerChromeProps) {
  return (
    <div
      className="window-controls mini-window-controls"
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        onClick={onExitMiniPlayer}
        title="Exit mini player"
        aria-label="Exit mini player"
      >
        <Maximize2 size={13} />
      </button>
    </div>
  );
}
