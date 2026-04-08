'use client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import s from './Markdown.module.css';

export default function Markdown({ children }) {
  if (!children) return null;
  return (
    <div className={s.root}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
