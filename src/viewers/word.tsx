export type WordDocumentBlock = {
  kind: "heading" | "list" | "notice" | "paragraph" | string;
  text: string;
};

export type WordDocumentContent = {
  title: string;
  blockCount: number;
  wordCount: number;
  blocks: WordDocumentBlock[];
};

const wordExtensions = new Set(["doc", "docx", "docm", "dotx", "dotm"]);

export function isWordDocumentExtension(extension: string) {
  return wordExtensions.has(extension.toLowerCase());
}

type WordDocumentSurfaceProps = {
  document: WordDocumentContent;
  title: string;
};

export function WordDocumentSurface({ document, title }: WordDocumentSurfaceProps) {
  const displayTitle = document.title || title;

  return (
    <article className="word-document-surface" aria-label={title}>
      <header className="word-document-header">
        <span>Document preview</span>
        <h1>{displayTitle}</h1>
        <p>
          {document.wordCount.toLocaleString()} words - {document.blockCount.toLocaleString()} sections
        </p>
      </header>
      <div className="word-document-body">
        {document.blocks.length > 0 ? (
          document.blocks.map((block, index) => {
            if (block.kind === "heading" || block.kind.startsWith("heading")) {
              return <h2 key={`${index}-${block.text}`}>{block.text}</h2>;
            }
            if (block.kind === "list") {
              return (
                <p className="word-list-item" key={`${index}-${block.text}`}>
                  {block.text}
                </p>
              );
            }
            if (block.kind === "notice") {
              return (
                <p className="word-document-notice" key={`${index}-${block.text}`}>
                  {block.text}
                </p>
              );
            }
            return <p key={`${index}-${block.text}`}>{block.text}</p>;
          })
        ) : (
          <p className="word-document-empty">No previewable text was found in this Word document.</p>
        )}
      </div>
    </article>
  );
}
