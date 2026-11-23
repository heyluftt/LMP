export function SubtitleOverlay({ text }: { text: string | null }) {
  if (!text) {
    return null;
  }
  return (
    <div className="av-subtitle-overlay" aria-live="polite" data-wheel-volume="ignore">
      <span>{text}</span>
    </div>
  );
}
