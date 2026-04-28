import fs from 'node:fs';
import path from 'node:path';
import Markdown from '../components/Markdown/Markdown';

export const metadata = { title: 'Prome Engine · 产品策划书' };

export default function ProductDocPage() {
  const md = fs.readFileSync(path.join(process.cwd(), 'product.md'), 'utf8');
  return (
    <main
      style={{
        maxWidth: 820,
        margin: '0 auto',
        padding: '48px 24px 96px',
        fontSize: 15,
        lineHeight: 1.65,
      }}
    >
      <Markdown>{md}</Markdown>
    </main>
  );
}
