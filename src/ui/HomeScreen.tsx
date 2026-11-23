import {
  Clock3,
  Code2,
  Disc3,
  FileAudio,
  FilePlus2,
  FileText,
  FileVideo,
  FolderOpen,
  History,
  ImageIcon,
  Settings2,
  Trash2,
} from "lucide-react";
import {
  extension as mediaExtension,
  fileName,
  mediaKind,
} from "../lib/playerBrain";
import { mediaKindBadge } from "../lib/mediaFormat";
import { formatDraftTime, type TextDraftSummary } from "../viewers/text/textDrafts";
import { isWordDocumentExtension } from "../viewers/word";

export type HomeOpenTarget = "text" | "video" | "audio" | "image" | "pdf" | "word";

export function homeOpenTargetLabel(target: HomeOpenTarget) {
  switch (target) {
    case "text":
      return "text or code file";
    case "video":
      return "video file";
    case "audio":
      return "audio file";
    case "image":
      return "image or GIF";
    case "pdf":
      return "PDF";
    case "word":
      return "Word document";
  }
  return "file";
}

export function pathMatchesHomeTarget(path: string, target: HomeOpenTarget) {
  const kind = mediaKind(path);
  const ext = mediaExtension(path);
  switch (target) {
    case "text":
      return kind === "text";
    case "video":
      return kind === "video";
    case "audio":
      return kind === "audio";
    case "image":
      return kind === "image";
    case "pdf":
      return kind === "document" && ext === "pdf";
    case "word":
      return kind === "document" && isWordDocumentExtension(ext);
  }
  return false;
}

type HomeScreenProps = {
  drafts: TextDraftSummary[];
  onDiscardDraft: (id: string) => void;
  onNewText: () => void;
  onOpen: (target: HomeOpenTarget) => void;
  onOpenGeneric: () => void;
  onOpenSettings: () => void;
  onPlayRecent: (path: string) => void;
  onRestoreDraft: (id: string) => void;
  recent: string[];
  showRecentFiles: boolean;
};

export function HomeScreen({
  drafts,
  onDiscardDraft,
  onNewText,
  onOpen,
  onOpenGeneric,
  onOpenSettings,
  onPlayRecent,
  onRestoreDraft,
  recent,
  showRecentFiles,
}: HomeScreenProps) {
  const quickActions = [
    {
      description: "Start a blank editor draft.",
      icon: <FilePlus2 size={22} />,
      label: "New Text",
      onClick: onNewText,
    },
    {
      description: "Open notes, configs, scripts, or source files.",
      icon: <Code2 size={22} />,
      label: "Open Text / Code",
      onClick: () => onOpen("text"),
    },
    {
      description: "Use LMP playback and queue behavior.",
      icon: <FileVideo size={22} />,
      label: "Open Video",
      onClick: () => onOpen("video"),
    },
    {
      description: "Open music, recordings, or audio clips.",
      icon: <FileAudio size={22} />,
      label: "Open Audio",
      onClick: () => onOpen("audio"),
    },
    {
      description: "View images and animated GIF files.",
      icon: <ImageIcon size={22} />,
      label: "Open Image / GIF",
      onClick: () => onOpen("image"),
    },
    {
      description: "Open documents in the built-in viewer.",
      icon: <FileText size={22} />,
      label: "Open PDF",
      onClick: () => onOpen("pdf"),
    },
  ];

  return (
    <div className="home-screen" data-wheel-volume="ignore">
      <section className="home-hero" aria-label="LMP home">
        <div className="home-brand">
          <div className="home-brand-mark" aria-hidden="true">
            <Disc3 size={26} />
          </div>
          <div>
            <h1>LMP</h1>
            <span>Local media suite</span>
          </div>
        </div>
        <div className="home-hero-copy">
          <strong>Start with a file or a blank draft.</strong>
          <p>Play media, view documents, or write text without switching apps first.</p>
        </div>
        <div className="home-primary-actions">
          <button type="button" className="home-primary-button" onClick={onNewText}>
            <FilePlus2 size={19} />
            <span>New Text</span>
          </button>
          <button type="button" className="home-secondary-button" onClick={onOpenGeneric}>
            <FolderOpen size={19} />
            <span>Open File</span>
          </button>
        </div>
      </section>

      <section className="home-action-panel" aria-label="Quick open">
        <div className="home-section-heading">
          <span>Start</span>
          <strong>Choose what you want to open</strong>
        </div>
        <div className="home-action-grid">
          {quickActions.map((action) => (
            <button key={action.label} type="button" className="home-action" onClick={action.onClick}>
              {action.icon}
              <span>
                <strong>{action.label}</strong>
                <small>{action.description}</small>
              </span>
            </button>
          ))}
          <button type="button" className="home-action" onClick={() => onOpen("word")}>
            <FileText size={22} />
            <span>
              <strong>Open Word / DOCX</strong>
              <small>Extract an editable text copy.</small>
            </span>
          </button>
          <button type="button" className="home-action" onClick={onOpenSettings}>
            <Settings2 size={22} />
            <span>
              <strong>Settings</strong>
              <small>Adjust updates, cache, playback, and text behavior.</small>
            </span>
          </button>
        </div>
      </section>

      {drafts.length > 0 ? (
        <section className="home-drafts-panel" aria-label="Unsaved drafts">
          <div className="home-section-heading">
            <span>Unsaved Drafts</span>
            <strong>
              {drafts.length === 1 ? "One text draft was kept for you" : `${drafts.length} text drafts were kept for you`}
            </strong>
          </div>
          <div className="home-draft-list">
            {drafts.slice(0, 6).map((draft) => (
              <div key={draft.id} className="home-draft" title={draft.path ?? draft.title}>
                <button type="button" className="home-draft-open" onClick={() => onRestoreDraft(draft.id)}>
                  <History size={16} />
                  <span>
                    <strong>{draft.title}</strong>
                    <small>
                      {formatDraftTime(draft.updatedAt)} · {draft.charCount.toLocaleString()} chars
                      {draft.sourceType === "untitled" ? " · never saved" : ""}
                    </small>
                    {draft.preview ? <em>{draft.preview}</em> : null}
                  </span>
                </button>
                <button
                  type="button"
                  className="home-draft-discard"
                  onClick={() => onDiscardDraft(draft.id)}
                  aria-label={`Discard draft ${draft.title}`}
                  title="Discard draft"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {showRecentFiles ? (
        <section className="home-recent-panel" aria-label="Recent files">
          <div className="home-section-heading">
            <span>Recent Files</span>
            <strong>{recent.length > 0 ? "Continue where you left off" : "No recent files yet"}</strong>
          </div>
          <div className="home-recent-list">
            {recent.length > 0 ? (
              recent.slice(0, 4).map((path) => (
                <button key={path} type="button" onClick={() => onPlayRecent(path)} title={path}>
                  <Clock3 size={16} />
                  <span>
                    <strong>{fileName(path)}</strong>
                    <small>{mediaKindBadge(path)}</small>
                  </span>
                </button>
              ))
            ) : (
              <p>Files you open will appear here when recent files are enabled.</p>
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}
