import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function Markdown({ children, className = '' }: { children: string; className?: string }) {
  return (
    <div
      // code とコードブロックの地と文字色は index.css の .prose-slate でまとめて決める
      className={`prose prose-slate max-w-none ${className}`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
