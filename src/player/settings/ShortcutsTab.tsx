type ShortcutGroup = {
  items: Array<{
    keys: string;
    label: string;
  }>;
  title: string;
};

type ShortcutsTabProps = {
  isAudio: boolean;
  isDocument: boolean;
  isImage: boolean;
  isText: boolean;
};

const commonShortcuts: ShortcutGroup = {
  title: "Common",
  items: [
    { keys: "Ctrl O", label: "Open file" },
    { keys: "F", label: "Fullscreen" },
    { keys: "Esc", label: "Close panel" },
  ],
};

const playbackShortcuts: ShortcutGroup = {
  title: "Playback",
  items: [
    { keys: "Space / K", label: "Play or pause" },
    { keys: "Left / Right", label: "Seek" },
    { keys: "Shift Arrow", label: "Long seek" },
    { keys: "Wheel", label: "Volume" },
    { keys: ", / .", label: "Frame seek" },
  ],
};

const videoShortcuts: ShortcutGroup = {
  title: "Video",
  items: [
    { keys: "L", label: "Set loop point" },
    { keys: "Shift L", label: "Clear loop" },
    { keys: "C", label: "Captions" },
    { keys: "M", label: "Mark moment" },
    { keys: "Q", label: "Queue" },
    { keys: "I", label: "Info" },
  ],
};

const imageShortcuts: ShortcutGroup = {
  title: "Image",
  items: [
    { keys: "Left / Right", label: "Previous or next" },
    { keys: "+ / -", label: "Zoom" },
    { keys: "0", label: "Reset view" },
    { keys: "R", label: "Rotate" },
    { keys: "Q", label: "Queue" },
    { keys: "I", label: "Info" },
  ],
};

const documentShortcuts: ShortcutGroup = {
  title: "PDF",
  items: [
    { keys: "Left / Right", label: "Page" },
    { keys: "Page Up / Down", label: "Page" },
    { keys: "Home / End", label: "First or last page" },
    { keys: "+ / -", label: "Zoom" },
    { keys: "0", label: "Reset view" },
    { keys: "Ctrl P", label: "Print" },
  ],
};

const textShortcuts: ShortcutGroup = {
  title: "Text",
  items: [
    { keys: "Ctrl S", label: "Save" },
    { keys: "Ctrl Shift S", label: "Save as" },
    { keys: "Ctrl F", label: "Find" },
    { keys: "Ctrl H", label: "Replace" },
    { keys: "Ctrl G", label: "Go to line" },
    { keys: "Ctrl Z / Y", label: "Undo or redo" },
  ],
};

export function ShortcutsTab({ isAudio, isDocument, isImage, isText }: ShortcutsTabProps) {
  const groups = [
    commonShortcuts,
    isText
      ? textShortcuts
      : isImage
        ? imageShortcuts
        : isDocument
          ? documentShortcuts
          : isAudio
            ? playbackShortcuts
            : playbackShortcuts,
    !isText && !isImage && !isDocument && !isAudio ? videoShortcuts : null,
  ].filter(Boolean) as ShortcutGroup[];

  return (
    <div className="shortcut-settings" aria-label="Keyboard shortcuts">
      {groups.map((group) => (
        <section key={group.title} className="shortcut-group">
          <strong>{group.title}</strong>
          <div>
            {group.items.map((item) => (
              <span key={`${group.title}-${item.keys}-${item.label}`} className="shortcut-item">
                <kbd>{item.keys}</kbd>
                <small>{item.label}</small>
              </span>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
