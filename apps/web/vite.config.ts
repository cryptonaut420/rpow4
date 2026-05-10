import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const SITEMAP_ROUTES: Array<{ path: string; priority: string; changefreq: string }> = [
  { path: '/', priority: '1.0', changefreq: 'daily' },
  { path: '/#/ledger', priority: '0.8', changefreq: 'weekly' },
  { path: '/#/stats', priority: '0.8', changefreq: 'daily' },
  { path: '/#/explorer', priority: '0.8', changefreq: 'daily' },
  { path: '/#/faucet', priority: '0.7', changefreq: 'weekly' },
  { path: '/#/trollbox', priority: '0.6', changefreq: 'hourly' },
  { path: '/#/history', priority: '0.7', changefreq: 'monthly' },
  { path: '/#/docs', priority: '0.8', changefreq: 'monthly' },
  { path: '/#/ecosystem', priority: '0.6', changefreq: 'monthly' },
];

function sitemapPlugin(appUrl: string): Plugin {
  return {
    name: 'rpow-sitemap',
    apply: 'build',
    generateBundle() {
      if (!appUrl) return;
      const base = appUrl.replace(/\/$/, '');
      const today = new Date().toISOString().split('T')[0];

      const urlEntries = SITEMAP_ROUTES.map(
        (r) =>
          `  <url>\n    <loc>${base}${r.path}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${r.changefreq}</changefreq>\n    <priority>${r.priority}</priority>\n  </url>`,
      ).join('\n');

      const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urlEntries}\n</urlset>\n`;
      const robots = `User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`;

      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: sitemap });
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: robots });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), sitemapPlugin(env.VITE_APP_URL ?? '')],
    server: { port: 5173 },
    worker: { format: 'es' },
  };
});
