import { useEffect } from 'react';

export function usePageMeta(title: string, description: string): void {
  useEffect(() => {
    document.title = `${title} | RPOW4`;
    document.querySelector('meta[name="description"]')?.setAttribute('content', description);
  }, [title, description]);
}
