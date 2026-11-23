import type { ReactNode } from "react";
import { X } from "lucide-react";

type ShelfHeaderProps = {
  actions?: ReactNode;
  icon: ReactNode;
  meta?: ReactNode;
  metaTitle?: string;
  title: string;
};

export function ShelfHeader({ actions, icon, meta, metaTitle, title }: ShelfHeaderProps) {
  return (
    <div className="shelf-header">
      {icon}
      <strong>{title}</strong>
      {meta ? (
        <span className="shelf-meta" title={metaTitle}>
          {meta}
        </span>
      ) : (
        <span className="shelf-meta" aria-hidden="true" />
      )}
      {actions ? <div className="shelf-actions">{actions}</div> : null}
    </div>
  );
}

export function ShelfCloseButton({
  label,
  onClose,
}: {
  label: string;
  onClose: () => void;
}) {
  return (
    <button type="button" className="shelf-close" onClick={onClose} title={label} aria-label={label}>
      <X size={16} />
    </button>
  );
}
