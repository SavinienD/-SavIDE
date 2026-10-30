import {
  Children,
  cloneElement,
  isValidElement,
  memo,
  type ReactElement,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { api } from "../../lib/ipc";
import { MermaidDiagram } from "./MermaidDiagram";
import { PreCopiable } from "./PreCopiable"; // axe:copier-code
import { decouperLiens, estFichier, estUrl, raccourcirUrl } from "./liensChat";

type Props = {
  text: string;
  onOpenFile: (path: string) => void;
};

type LinkifyOptions = {
  onOpenFile: (path: string) => void;
};

function isMermaidLanguage(className?: string): boolean {
  if (!className) return false;
  return className
    .split(/\s+/)
    .some((name) => name === "mermaid" || name === "language-mermaid");
}

const isFileToken = estFichier;

/** axe:liens — lien web : gras, surligné, ouvre le navigateur par défaut (Windows, macOS, Linux). */
function UrlLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className="chat-link"
      target="_blank"
      rel="noreferrer"
      title={href}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void api.openExternalUrl(href);
      }}
    >
      {children}
    </a>
  );
}

function FileLink({
  path,
  children,
  variant,
  onOpenFile,
}: {
  path: string;
  children: ReactNode;
  variant?: "code";
  onOpenFile: (path: string) => void;
}) {
  return (
    <button
      type="button"
      className="chat-file-link"
      data-variant={variant}
      title={`Ouvrir ${path}`}
      onClick={(event) => {
        event.stopPropagation();
        onOpenFile(path);
      }}
    >
      {children}
    </button>
  );
}

function linkifyText(text: string, { onOpenFile }: LinkifyOptions): ReactNode[] {
  return decouperLiens(text).map((s, i) => {
    if (s.genre === "url") {
      return (
        <UrlLink key={`${s.texte}-${i}`} href={s.texte}>
          {raccourcirUrl(s.texte)}
        </UrlLink>
      );
    }
    if (s.genre === "fichier") {
      return (
        <FileLink key={`${s.texte}-${i}`} path={s.texte} onOpenFile={onOpenFile}>
          {s.texte}
        </FileLink>
      );
    }
    return s.texte;
  });
}

function childrenToString(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => {
      if (typeof child === "string") return child;
      if (typeof child === "number") return String(child);
      if (!isValidElement(child)) return "";
      const props = child.props as { children?: ReactNode };
      return childrenToString(props.children);
    })
    .join("");
}

function linkifyChildren(children: ReactNode, options: LinkifyOptions): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") return linkifyText(child, options);
    if (!isValidElement(child)) return child;
    // axe:liens — les éléments rendus par nos composants (a, code, pre) ont pour type la
    // fonction du composant : on les reconnaît à leur nœud HAST, sinon lien dans lien.
    const tag = (child.props as { node?: { tagName?: string } }).node?.tagName;
    if (
      child.type === "a" ||
      child.type === "code" ||
      child.type === "pre" ||
      tag === "a" ||
      tag === "code" ||
      tag === "pre"
    ) {
      return child;
    }

    const props = child.props as { children?: ReactNode };
    if (props.children === undefined) return child;

    return cloneElement(
      child as ReactElement<{ children?: ReactNode }>,
      undefined,
      linkifyChildren(props.children, options),
    );
  });
}

export function FileLinkedText({ text, onOpenFile }: Props) {
  return <>{linkifyText(text, { onOpenFile })}</>;
}

/**
 * Markdown renderer tuned for chat. GFM + highlight.js. Memoized so
 * streaming token-by-token re-renders don't trash the whole tree.
 */
export const Markdown = memo(function Markdown({ text, onOpenFile }: Props) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          pre({ children }) {
            // `code` already swaps fenced ```mermaid blocks for an
            // interactive <MermaidDiagram />. Unwrap the surrounding
            // <pre> in that case so the diagram isn't boxed by code
            // styling; otherwise render a plain <pre>.
            const only =
              Children.count(children) === 1
                ? Children.toArray(children)[0]
                : null;
            if (isValidElement(only) && only.type === MermaidDiagram) {
              return only;
            }
            if (isValidElement<{ className?: string; children?: ReactNode }>(only)) {
              if (isMermaidLanguage(only.props.className)) {
                return (
                  <MermaidDiagram source={childrenToString(only.props.children)} />
                );
              }
            }
            return <PreCopiable>{children}</PreCopiable>;
          },
          p({ children }) {
            return <p>{linkifyChildren(children, { onOpenFile })}</p>;
          },
          li({ children }) {
            return <li>{linkifyChildren(children, { onOpenFile })}</li>;
          },
          h1({ children }) {
            return <h1>{linkifyChildren(children, { onOpenFile })}</h1>;
          },
          h2({ children }) {
            return <h2>{linkifyChildren(children, { onOpenFile })}</h2>;
          },
          h3({ children }) {
            return <h3>{linkifyChildren(children, { onOpenFile })}</h3>;
          },
          h4({ children }) {
            return <h4>{linkifyChildren(children, { onOpenFile })}</h4>;
          },
          code({ children, className }) {
            const value = childrenToString(children);
            if (isMermaidLanguage(className)) {
              return <MermaidDiagram source={value} />;
            }
            if (!className && isFileToken(value)) {
              return (
                <FileLink
                  path={value}
                  variant="code"
                  onOpenFile={onOpenFile}
                >
                  {value}
                </FileLink>
              );
            }
            return <code className={className}>{children}</code>;
          },
          table({ children }) {
            // Wrap the table so horizontal scrolling lives on a block-level
            // ancestor. The <table> itself stays a real display: table so
            // the auto column-width algorithm distributes space correctly
            // (otherwise display: block on the table collapses left columns).
            return (
              <div className="md-table-wrap">
                <table>{children}</table>
              </div>
            );
          },
          a({ href, children }) {
            const value = href ?? childrenToString(children);
            if (!estUrl(value) && isFileToken(value)) {
              return (
                <FileLink path={value} onOpenFile={onOpenFile}>
                  {children}
                </FileLink>
              );
            }
            if (!href) return <>{children}</>;
            // URL nue (autolien GFM) : libellé raccourci ; [texte](url) garde son texte.
            const libelle = childrenToString(children);
            return (
              <UrlLink href={href}>
                {libelle === href ? raccourcirUrl(href) : children}
              </UrlLink>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
