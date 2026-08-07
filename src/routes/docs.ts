import * as express from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { sendError } from '../utils/errorResponse';
import { logger } from '../utils/Logger';

// Postman collection / OpenAPI export structural types (used by the /docs/postman/<file>
// renderer below). Postman JSON is untyped at the wire level, so these are a permissive
// "best effort" shape — enough to drop the `as any` casts that previously littered the
// extraction helpers without overstating type guarantees.
interface PMUrlObject {
  raw?: string;
  path?: string[] | string;
  query?: { key?: string; name?: string }[];
  queryParams?: { key?: string; name?: string }[];
  search?: { key?: string; name?: string }[];
}
interface PMRequest {
  method?: string;
  url?: string | PMUrlObject;
  description?: unknown;
}
interface PMItemNode {
  name?: string;
  item?: PMItemNode[];
  request?: PMRequest;
  description?: unknown;
}
interface PMCollection {
  info?: { name?: string; description?: unknown };
  item?: PMItemNode[];
}

interface OpenAPIParameter {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  schema: { type: string };
}
interface OpenAPIOperation {
  summary?: string;
  description?: string;
  parameters?: OpenAPIParameter[];
  responses: Record<string, { description: string }>;
}
interface OpenAPIDoc {
  openapi: string;
  info: { title: string; version: string; description?: string };
  paths: Record<string, Record<string, OpenAPIOperation>>;
}

// Module-scope helpers for Postman extraction (used by both index walk + per-collection
// renderer; keeping a single copy eliminates the four duplicated extractDesc helpers).
function extractPMDesc(d: unknown): string {
  if (!d) return '';
  if (typeof d === 'string') return d;
  if (typeof d === 'object' && 'content' in d) {
    const c = (d as { content?: unknown }).content;
    return typeof c === 'string' ? c : JSON.stringify(d);
  }
  return JSON.stringify(d);
}

function getPMRequestParts(request: PMRequest | undefined): {
  method: string;
  urlRaw: string;
  description: unknown;
  urlObj: PMUrlObject | undefined;
} {
  if (!request) return { method: 'GET', urlRaw: '', description: undefined, urlObj: undefined };
  const method = (request.method || 'GET').toUpperCase();
  let urlRaw = '';
  let urlObj: PMUrlObject | undefined;
  if (typeof request.url === 'string') {
    urlRaw = request.url;
  } else if (request.url && typeof request.url === 'object') {
    urlObj = request.url;
    urlRaw = urlObj.raw || (Array.isArray(urlObj.path) ? urlObj.path.join('/') : '');
  }
  return { method, urlRaw, description: request.description, urlObj };
}

/**
 * Router to serve markdown and other documentation assets under /docs.
 * Markdown files are wrapped in a minimal Tailwind-styled HTML shell for readability.
 */
export function createDocsRouter(): express.Router {
  const router = express.Router();
  const docsRoot = path.join(__dirname, '../../docs');
  // Postman collections root (choose first existing)
  const postmanFirst = path.join(__dirname, '../postman');
  const postmanSecond = path.join(__dirname, '../../postman');
  const postmanRoot = fs.existsSync(postmanFirst) ? postmanFirst : (fs.existsSync(postmanSecond) ? postmanSecond : postmanFirst);

  // Lazy-load ESM-only 'marked' to avoid Jest import-time failures; provide a tiny fallback renderer
  type MarkedLike = { parse: (src: string) => string | Promise<string>; setOptions?: (opts: unknown) => void };
  let markedInstance: MarkedLike | null = null;
  let markedLoadAttempted = false;
  const simpleFallback: MarkedLike = {
    parse: (src: string) => {
      const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      let out = esc(src)
        .replace(/^###\s+(.*)$/gm, '<h3>$1</h3>')
        .replace(/^##\s+(.*)$/gm, '<h2>$1</h2>')
        .replace(/^#\s+(.*)$/gm, '<h1>$1</h1>')
        .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/^\s*\*\s+(.*)$/gm, '<ul>\n<li>$1</li>\n</ul>');
      out = out
        .split(/\n{2,}/)
        .map(block => (/^<h[1-6]|<pre|<ul|<table|<blockquote/.test(block) ? block : `<p>${block.replace(/\n/g, '<br/>')}</p>`))
        .join('\n');
      return out;
    },
    setOptions: () => {}
  };
  async function loadMarked(): Promise<MarkedLike> {
    if (markedInstance) return markedInstance;
    if (markedLoadAttempted) return simpleFallback;
    markedLoadAttempted = true;
    try {
      const mod: unknown = await import('marked');
      const modObj = (mod && typeof mod === 'object') ? (mod as { marked?: MarkedLike; default?: MarkedLike }) : undefined;
      const m: MarkedLike = modObj?.marked || modObj?.default || (mod as MarkedLike);
      if (m?.setOptions) m.setOptions({ gfm: true, breaks: false });
      markedInstance = m;
      return m;
    } catch (_e) {
      markedInstance = simpleFallback;
      return simpleFallback;
    }
  }

  // Simple in-memory cache { key: { html, mtimeMs } }
  interface CacheEntry { html: string; mtimeMs: number; }
  const renderCache = new Map<string, CacheEntry>();
  const CACHE_TTL_MS = 5 * 60 * 1000;

  // In-memory search corpus
  interface SearchDoc { path: string; title: string; content: string; }
  let searchDocs: SearchDoc[] = [];
  let docsVersion = 1; // increments on reindex (dev hot-reload aid)

  function walk(dir: string, baseDir: string = docsRoot) {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const rel = path.relative(baseDir, full).replace(/\\/g, '/');
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        walk(full, baseDir);
      } else if (entry.endsWith('.md')) {
        try {
          const raw = fs.readFileSync(full, 'utf8');
          const title = (raw.match(/^#\s+(.+)$/m)?.[1] || entry).trim();
          searchDocs.push({ path: rel, title, content: raw.toLowerCase() });
        } catch (err) { logger.debug(`Skipping unreadable doc file: ${rel}`, { error: err }); }
      }
    }
  }

  function loadSearchDocs(): void {
    searchDocs = [];
    
    // Index docs directory
    if (fs.existsSync(docsRoot)) {
      walk(docsRoot);
    }
    
    // Also index root directory markdown files
    const rootDir = path.join(__dirname, '../../');
    if (fs.existsSync(rootDir)) {
      for (const entry of fs.readdirSync(rootDir)) {
        if (entry.endsWith('.md')) {
          try {
            const full = path.join(rootDir, entry);
            const stat = fs.statSync(full);
            if (stat.isFile()) {
              const raw = fs.readFileSync(full, 'utf8');
              const title = (raw.match(/^#\s+(.+)$/m)?.[1] || entry).trim();
              searchDocs.push({ path: entry, title, content: raw.toLowerCase() });
            }
          } catch (err) { logger.debug('Skipping file during doc scan', { error: err }); }
        }
      }
    }
    // Include Postman collection requests in search index (method, url, name, description)
    try {
      if (fs.existsSync(postmanRoot)) {
        const pFiles = fs.readdirSync(postmanRoot).filter(f => f.toLowerCase().endsWith('.postman_collection.json'));
        for (const f of pFiles) {
          const abs = path.join(postmanRoot, f);
            try {
              const raw = fs.readFileSync(abs, 'utf8');
              const json: PMCollection = JSON.parse(raw);
              const items: { path: string; title: string; content: string }[] = [];
              const walkPM = (arr: PMItemNode[], prefix: string[] = []) => {
                for (const it of arr) {
                  const segs = [...prefix, it.name || '(unnamed)'];
                  if (it.request) {
                    const { method, urlRaw, description } = getPMRequestParts(it.request);
                    const desc = extractPMDesc(description || it.description || '');
                    const content = [method, urlRaw, segs.join(' / '), desc].join('\n').toLowerCase();
                    items.push({ path: `postman/${f}#${segs.join('/')}`, title: `${method} ${urlRaw}`, content });
                  }
                  if (it.item && Array.isArray(it.item)) walkPM(it.item, segs);
                }
              };
              if (Array.isArray(json.item)) walkPM(json.item);
              for (const it of items) searchDocs.push(it);
            } catch (err) { logger.debug('Skipping broken Postman file', { error: err }); }
        }
      }
    } catch (err) { logger.debug('Postman indexing error', { error: err }); }
    docsVersion++;
  }

  loadSearchDocs();

  // Development: watch docs directory for changes and auto-reindex (debounced)
  // Disable in tests or when DOCS_DISABLE_WATCH=1 to prevent open handles and late logs
  const DOCS_WATCH_DISABLED = process.env.DOCS_DISABLE_WATCH === '1' || !!process.env.JEST_WORKER_ID;
  if (process.env.NODE_ENV !== 'production' && !DOCS_WATCH_DISABLED) {
    try {
      const docsRoot = path.join(__dirname, '../../docs');
      if (fs.existsSync(docsRoot)) {
        let timer: NodeJS.Timeout | null = null;
        const watchers: fs.FSWatcher[] = [];
        const watcher = fs.watch(docsRoot, { recursive: true }, (_event, filename) => {
          if (!filename || !filename.endsWith('.md')) return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            loadSearchDocs();
            // Avoid noisy logs in automated test runners
            if (!process.env.JEST_WORKER_ID) {
              logger.info('[docs] Reindexed after change: ' + filename);
            }
          }, 150);
        });
        watchers.push(watcher);
        const cleanup = () => {
          if (timer) {
            try { clearTimeout(timer); } catch (_e) { /* ignore */ }
          }
          for (const w of watchers) {
            try { w.close(); } catch (_e) { /* ignore */ }
          }
        };
        // Best-effort cleanup on process shutdown in dev
        process.once('exit', cleanup);
        process.once('SIGINT', cleanup);
        process.once('SIGTERM', cleanup);
      }
    } catch { /* ignore watcher errors */ }
  }

  // Simple slugify with duplicate handling
  function slugify(text: string, existing: Set<string>): string {
    let base = text.toLowerCase().trim()
      .replace(/<[^>]+>/g, '')
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-');
    if (!base) base = 'section';
    let slug = base;
    let i = 2;
    while (existing.has(slug)) { slug = `${base}-${i++}`; }
    existing.add(slug);
    return slug;
  }

  function addHeadingIds(html: string): string {
    const existing = new Set<string>();
    return html.replace(/<h([1-3])>([\s\S]*?)<\/h\1>/g, (_m, level, inner) => {
      const plain = inner.replace(/<[^>]+>/g, '');
      const id = slugify(plain, existing);
      return `<h${level} id="${id}">${inner}</h${level}>`;
    });
  }

  function buildTOC(html: string): string {
    const headingRegex = /<h([1-3]) id="(.*?)"[^>]*>(.*?)<\/h\1>/g; // h1-h3
    const items: { level: number; id: string; text: string }[] = [];
    let match: RegExpExecArray | null;
    while ((match = headingRegex.exec(html)) !== null) {
      if (match && match[1] && match[2] && match[3]) {
        const level = parseInt(match[1], 10);
        const id = match[2];
        const text = match[3].replace(/<[^>]+>/g, '');
        if (text.toLowerCase().includes('table of contents')) continue; // skip existing TOC headings
        items.push({ level, id, text });
      }
    }
    if (!items.length) return '';
    const listItems = items
      .map(i => {
        const pad = (i.level - 1) * 3;
        return `
          <li class="pl-${pad}">
            <a class="text-indigo-600 dark:text-indigo-400 hover:underline" href="#${i.id}">
              ${i.text}
            </a>
          </li>`;
      })
      .join('');
    return `
      <nav class="hidden lg:block lg:w-64 flex-shrink-0 pr-6" aria-label="Table of contents">
        <div class="sticky top-4 max-h-[80vh] overflow-auto">
          <h2 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">On this page</h2>
          <ul class="text-sm space-y-1">${listItems}</ul>
        </div>
      </nav>
    `;
  }

  function renderPage(title: string, bodyHtml: string, tocHtml = '', filePath = ''): string {
    const head = `<!DOCTYPE html><html lang=\"en\" class=\"h-full\"><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\"><title>${title} - Integration Hub Docs</title><link href=\"https://cdnjs.cloudflare.com/ajax/libs/tailwindcss/2.2.19/tailwind.min.css\" rel=\"stylesheet\"><link rel=\"stylesheet\" href=\"/vendor/fontawesome-6.0.0.min.css\" onerror=\"this.remove();(function(){var l=document.createElement('link');l.rel='stylesheet';l.href='https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css';l.crossOrigin='anonymous';l.integrity='';document.head.appendChild(l);})();\">`;
    const styles = `<style>
      :root { color-scheme: light dark; }
      body{background:#f9fafb;color:#111827;}
      .dark body,.dark{background:#0f172a;color:#e2e8f0;}
      .container{max-width:78rem;margin:0 auto;padding:2rem}
      pre code{white-space:pre-wrap}
      code{background:rgba(100,116,139,.15);padding:2px 4px;border-radius:4px;font-size:.85rem}
      h1,h2,h3{font-weight:600;margin-top:1.75rem}
      table{width:100%;border-collapse:collapse}
      th,td{border:1px solid #e5e7eb;padding:.5rem;text-align:left}
      .dark th,.dark td{border-color:#334155}
      blockquote{border-left:4px solid #6366f1;padding:.5rem 1rem;background:#eef2ff;margin:.75rem 0}
      .dark blockquote{background:#1e293b}
      a{color:#4f46e5} a:hover{text-decoration:underline}
      .dark a{color:#818cf8}
      .theme-toggle{border:1px solid #6366f1;padding:4px 10px;border-radius:4px;font-size:.75rem;color:#4f46e5}
      .dark .theme-toggle{color:#a5b4fc;border-color:#818cf8}
      
      /* COMPREHENSIVE SEARCH TEXT VISIBILITY FIX - 2025-09-09 */
      /* NOTE: JavaScript inline styles override CSS regardless of !important */
      /* Main fixes are in public/docs-search.js - this provides backup CSS coverage */
      body label[for="docSearch"],
      body .search-label,
      body .search-docs-label,
      body #docSearch,
      body input#docSearch,
      body #searchResults a,
      body #searchResults li a,
      body ul#searchResults a,
      body .search-results a,
      body .search-area label,
      body div label[for="docSearch"] {
        color: #1f2937 !important;
        font-weight: 500 !important;
        -webkit-text-fill-color: #1f2937 !important;
        text-shadow: none !important;
      }
      
      /* Extra specificity for search input text */
      body input#docSearch::-webkit-input-placeholder,
      body input#docSearch::placeholder {
        color: #6b7280 !important;
      }
      input[type="text"]#docSearch,
      input[id="docSearch"][type="text"],
      input[placeholder*="search"]#docSearch,
      [id="docSearch"],
      html body div input#docSearch,
      html body input[id="docSearch"],
      .container input#docSearch,
      input#docSearch.w-full,
      input#docSearch.p-2,
      input#docSearch.border,
      input#docSearch.rounded,
      input#docSearch,
      #docSearch,
      div #docSearch,
      .bg-gray-50 #docSearch,
      .dark\\:bg-slate-900 #docSearch {
        color: #374151 !important;
        background-color: #ffffff !important;
        border: 3px solid #374151 !important;
        font-weight: 400 !important;
        opacity: 1 !important;
        -webkit-text-fill-color: #374151 !important;
        text-shadow: none !important;
        font-size: 18px !important;
        line-height: 1.5 !important;
        -webkit-appearance: none !important;
        appearance: none !important;
        text-rendering: optimizeLegibility !important;
      }
      html.dark body div input#docSearch,
      html.dark body input[id="docSearch"],
      .dark .container input#docSearch,
      .dark input#docSearch.w-full,
      .dark input#docSearch,
      .dark #docSearch,
      .dark div #docSearch,
      html.dark #docSearch {
        color: #ffffff !important;
        background-color: #1f2937 !important;
        border: 3px solid #9ca3af !important;
        font-weight: 400 !important;
        opacity: 1 !important;
        -webkit-text-fill-color: #ffffff !important;
        text-shadow: 1px 1px 0px #000000 !important;
        font-size: 16px !important;
        line-height: 1.5 !important;
        -webkit-appearance: none !important;
        appearance: none !important;
      }
      /* PLACEHOLDER TEXT FIXES */
      html body input#docSearch::placeholder,
      input#docSearch.w-full::placeholder,
      #docSearch::placeholder {
        color: #9ca3af !important;
        opacity: 0.7 !important;
        font-weight: 400 !important;
        -webkit-text-fill-color: #9ca3af !important;
      }
      html.dark body input#docSearch::placeholder,
      .dark input#docSearch.w-full::placeholder,
      html.dark #docSearch::placeholder {
        color: #6b7280 !important;
        opacity: 0.7 !important;
        font-weight: 400 !important;
        -webkit-text-fill-color: #6b7280 !important;
      }
      
      /* Print styles */
      @media print {
        body { background: white !important; color: black !important; }
        .bg-white, .bg-slate-800 { background: white !important; }
        .shadow-sm, .border-b { display: none; }
        .container { max-width: none; padding: 1rem; }
        nav[aria-label="Table of contents"] { display: none !important; }
        article { max-width: none !important; }
        button { display: none !important; }
        .theme-toggle, #themeToggle, #printBtn, #pdfBtn, #back-to-dashboard-btn { display: none !important; }
        pre { background: #f5f5f5 !important; border: 1px solid #ddd; padding: 1rem; }
        code { background: #f5f5f5 !important; color: black !important; }
        a { color: black !important; text-decoration: underline; }
        .text-indigo-600, .text-indigo-400 { color: black !important; }
        .dark .prose-invert { color: black !important; }
        h1, h2, h3, h4, h5, h6 { page-break-after: avoid; color: black !important; }
        table, pre, blockquote { page-break-inside: avoid; }
        tr { page-break-inside: avoid; page-break-after: auto; }
      }
    </style>`;
    const themeInit = `<script>(function(){
      const m=localStorage.getItem('ih_docs_theme');
      const prefers=window.matchMedia('(prefers-color-scheme: dark)').matches;
      if(m==='dark'||(!m&&prefers)){
        document.documentElement.classList.add('dark');
      }
    })();</script>`;

    const headerBar = `
      <div class="bg-white dark:bg-slate-800 shadow-sm border-b border-slate-200 dark:border-slate-700">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div class="flex justify-between items-center py-3 gap-4 flex-wrap">
            <div class="flex items-center gap-4">
              <!-- Safer fallback: real href plus JS override when available -->
              <button id="back-to-dashboard-btn" class="text-indigo-600 dark:text-indigo-400 hover:underline text-sm cursor-pointer bg-transparent border-none" onclick="document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));">
                <i class="fas fa-arrow-left mr-2"></i>Back to Dashboard
              </button>
              ${filePath.includes('tutorials') ? '<a href="/docs/tutorials/" class="text-indigo-600 dark:text-indigo-400 hover:underline text-sm"><i class="fas fa-folder-open mr-2"></i>Back to Tutorials</a>' : ''}
              <a href="/docs" class="text-indigo-600 dark:text-indigo-400 hover:underline text-sm">Docs Index</a>
            </div>
            <div class="flex items-center gap-2">
              <button id="printBtn" class="text-indigo-600 dark:text-indigo-400 hover:underline text-sm px-2 py-1 border border-indigo-300 rounded" title="Print document">
                <i class="fas fa-print mr-1"></i>Print
              </button>
              <button id="pdfBtn" class="text-indigo-600 dark:text-indigo-400 hover:underline text-sm px-2 py-1 border border-indigo-300 rounded" title="Save as PDF">
                <i class="fas fa-file-pdf mr-1"></i>PDF
              </button>
              <button id="themeToggle" class="theme-toggle" title="Toggle dark mode">
                <i class="fas fa-moon"></i><span class="ml-1">Theme</span>
              </button>
              <div class="text-xs text-gray-500 dark:text-gray-400">${title}</div>
            </div>
          </div>
        </div>
      </div>`;
    const main = `
      <main class="container flex flex-col lg:flex-row gap-8">
        ${tocHtml}
        <article class="prose prose-indigo dark:prose-invert max-w-none flex-1">${bodyHtml}</article>
      </main>`;
    const scripts = `
      <script>
        // Simple debug function to test JavaScript execution
        // Note: Client-side console.log intentionally kept for browser debugging

        // Ensure session storage is set for this documentation page (new tab safety)
        try {
          // If opened from the dashboard (target=_blank), prefer the referrer
          const ref = document.referrer || '';
          const sameOrigin = ref.startsWith(window.location.origin);
          const isDashboardRef = sameOrigin && !ref.includes('/docs/');
          if (isDashboardRef) {
            sessionStorage.setItem('dashboardUrl', ref);
            sessionStorage.setItem('returnToDashboard', 'true');
          } else if (!sessionStorage.getItem('dashboardUrl')) {
            sessionStorage.setItem('dashboardUrl', window.location.origin + '/');
            sessionStorage.setItem('returnToDashboard', 'true');
          }
        } catch (_) { /* sessionStorage may be unavailable in some modes */ }

        // showClosePrompt function removed - using header button with ESC key dispatch instead

        // Define goBackToDashboard for header button (uniform behavior for all docs)
        window.goBackToDashboard = function() {
          try {
            // Prefer dashboard URL captured on open; fallback to root
            let target = sessionStorage.getItem('dashboardUrl') || '/';
            if (target.includes('/docs/')) target = '/';

            // Prefer messaging opener so it can close this tab reliably
            try {
              if (window.opener) {
                // Post a message the dashboard listens for; opener will navigate + close us
                var params = new URLSearchParams(window.location.search);
                var token = params.get('ih_win') || '';
                window.opener.postMessage({ type: 'ih:backToDashboard', targetUrl: target, ih_win: token }, window.location.origin);
                // Fallback close attempts for Edge
                setTimeout(function(){
                  try { window.close(); } catch(_) {}
                  try { window.open('', '_self'); window.close(); } catch(_) {}
                  // Overlay prompt disabled - using header button instead
                  // try { if (!window.closed) showClosePrompt(target); } catch(_) {}
                }, 150);
                // Also broadcast to any dashboard tabs (in case opener was lost)
                try { var bc1 = new BroadcastChannel('ih-dashboard'); bc1.postMessage({ type: 'ih:backToDashboard', targetUrl: target }); } catch(_) {}
                return;
              }
            } catch (_) { /* ignore and fallback */ }

            // No opener: broadcast to any listening dashboard tab
            try { var bc2 = new BroadcastChannel('ih-dashboard'); bc2.postMessage({ type: 'ih:backToDashboard', targetUrl: target }); } catch(_) {}

            // Fallback: navigate this tab
            window.location.href = target || '/';
          } catch (_e) {
            window.location.href = '/';
          }
        };

        document.getElementById('themeToggle')?.addEventListener('click', () => {
          const de = document.documentElement;
          const dark = de.classList.toggle('dark');
          localStorage.setItem('ih_docs_theme', dark ? 'dark' : 'light');
        });

        // Print functionality
        document.getElementById('printBtn')?.addEventListener('click', () => {
          window.print();
        });

        // PDF functionality (uses browser's print to PDF)
        document.getElementById('pdfBtn')?.addEventListener('click', () => {
          // Create a custom print experience optimized for PDF
          const originalTitle = document.title;
          document.title = '${title}'.replace(/[^a-zA-Z0-9\\s-_]/g, '');
          
          // Trigger print dialog (user can select "Save as PDF")
          window.print();
          
          // Restore original title
          setTimeout(() => {
            document.title = originalTitle;
          }, 100);
        });
        const hash = location.hash;
        if (hash) {
          setTimeout(() => {
            const el = document.querySelector(hash);
            if (el) el.scrollIntoView();
          }, 50);
        }
      </script>
      <!-- Also include the universal back-to-dashboard helper to render a floating button consistently -->
      <script src="/back-to-dashboard.js"></script>
      <!-- Embedded back button functionality as fallback -->
      <script>
        // Note: Client-side console.log intentionally kept for browser debugging
        
        // Embedded goBackToDashboard function
        window.goBackToDashboard = function(source) {
          console.log('📄 Document back to dashboard from:', source || 'embedded');
          
          try {
            // Try to close tab first
            if (window.opener && !window.opener.closed) {
              console.log('📄 Found opener, closing tab and focusing opener');
              window.opener.focus();
              window.close();
              return;
            }
            
            // Try direct close
            console.log('📄 Attempting to close tab directly');
            const closed = window.close();
            if (closed !== false) {
              console.log('📄 Tab closed successfully');
              return;
            }
            
            // Fallback navigation
            console.log('📄 Using fallback navigation');
            window.location.href = '/';
          } catch (e) {
            console.error('📄 Navigation error:', e);
            window.location.href = '/';
          }
        };
        
        // Set up back button when DOM loads
        document.addEventListener('DOMContentLoaded', function() {
          console.log('📄 Setting up embedded back button...');
          
          const backBtn = document.getElementById('back-to-dashboard-btn');
          if (backBtn) {
            console.log('📄 Found back button, adding click handler');
            backBtn.addEventListener('click', function(e) {
              console.log('📄 BACK BUTTON CLICKED!');
              e.preventDefault();
              window.goBackToDashboard('EMBEDDED_HANDLER');
              return false;
            });
          } else {
            console.log('📄 Back button not found');
          }
        });
        
        // Also set up ESC key
        document.addEventListener('keydown', function(e) {
          if (e.key === 'Escape') {
            console.log('📄 ESC key pressed');
            e.preventDefault();
            window.goBackToDashboard('ESC_EMBEDDED');
          }
        });
        
        console.log('📄 Embedded script setup complete');
      </script>
    `;
    return `${head}${styles}</head><body class="min-h-full" id="doc-body">` +
      `${themeInit}${headerBar}${main}${scripts}</body></html>`;
  }

  // Reindex endpoint (non-production) and version endpoint for dev hot-reload polling
  router.post('/reindex', (req, res) => {
    if (process.env.NODE_ENV === 'production') {
      return sendError(res, 403, { code: 'DOCS_DISABLED', message: 'Disabled in production' }, req);
    }
    loadSearchDocs();
    return res.json({ ok: true, count: searchDocs.length, version: docsVersion });
  });
  if (process.env.NODE_ENV !== 'production') {
    router.get('/version', (_req, res) => res.json({ version: docsVersion }));
  }

  // Debug route to test if router is working
  router.get('/test', (_req, res) => {
    res.json({ message: 'Docs router is working', timestamp: new Date().toISOString() });
  });

  // Index page: list key docs and quick links
  router.get('/', (_req, res) => {
    try {
      // Dynamic index generation
      // Get files from docs directory
      const docsRoot = path.join(__dirname, '../../docs');
      const docsFiles = fs.existsSync(docsRoot) ? fs.readdirSync(docsRoot).filter(f => f.endsWith('.md')) : [];
      
      // Get markdown files from root directory  
      const rootDir = path.join(__dirname, '../../');
      const rootFiles = fs.existsSync(rootDir) ? fs.readdirSync(rootDir).filter(f => f.endsWith('.md')) : [];
      
      const important = ['ARCHITECTURE.md', 'AI_IMPLEMENTATION_GUIDE.md', 'INDEX.md', 'README.md', 'GETTING-STARTED.md', 'API-REFERENCE.md'];
      
      const docsList = docsFiles.sort().map(f => {
        const star = important.includes(f) ? '⭐ ' : '';
        return `<li class="mb-1"><a class="text-indigo-600 hover:underline" href="/docs/${f}">${star}${f}</a></li>`;
      }).join('');
      
      const rootList = rootFiles.sort().map(f => {
        const star = important.includes(f) ? '⭐ ' : '';
        return `<li class="mb-1"><a class="text-indigo-600 hover:underline" href="/docs/${f}">${star}${f}</a></li>`;
      }).join('');
      
      const core = [
        ['Root README', '/README.md'],
        ['Getting Started', '/GETTING-STARTED.md'],
        ['API Reference', '/API-REFERENCE.md'],
        ['Template Admin', '/admin-templates.html'],
        ['Changelog', '/docs/CHANGELOG.md'],
      ].map(([label, href]) => `<li class="mb-1"><a class="text-indigo-600 hover:underline" href="${href}">${label}</a></li>`).join('');
      // Postman collection list (if directory exists and has .json)
      let postmanSection = '';
      try {
        if (fs.existsSync(postmanRoot)) {
          const pFiles = fs.readdirSync(postmanRoot).filter(f => f.toLowerCase().endsWith('.postman_collection.json'));
          if (pFiles.length) {
            const pList = pFiles.map(f => `<li class=\"mb-1\"><a class=\"text-indigo-600 hover:underline\" href=\"/docs/postman/${encodeURIComponent(f)}\">${f}</a></li>`).join('');
            postmanSection = `<h2 class=\"mt-8\">Postman Collections</h2><ul>${pList}</ul>`;
          }
        }
      } catch (err) { logger.debug('Postman listing error', { error: err }); }
      const html = `
        <h1>Documentation Index</h1>
        <p>Browse project documentation. Markdown is rendered dynamically.</p>
        <div class="my-6 p-4 border rounded bg-gray-50 dark:bg-slate-900">
          <!-- SEARCH DOCS LABEL VISIBILITY FIX (2025-09-09) - Aggressive inline styles for maximum visibility -->
          <label for="docSearch" class="block text-sm font-semibold mb-1 text-gray-900 dark:text-white search-docs-label" style="color: #000000 !important; font-weight: 700 !important; -webkit-text-fill-color: #000000 !important; text-shadow: none !important; opacity: 1 !important;">Search Docs</label>
          <input
            id="docSearch"
            type="text"
            placeholder="Type to search... ( / focus, Esc clear )"
            class="w-full p-2 border rounded bg-white dark:bg-slate-800 dark:border-slate-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400"
            style="color: #374151 !important; background-color: #ffffff !important; font-weight: 400 !important; font-size: 16px !important; -webkit-text-fill-color: #374151 !important;"
          />
          <ul id="searchResults" class="mt-3 space-y-1 text-sm"></ul>
          <script>
            // INLINE SEARCH TEST - BYPASS ALL CSP ISSUES
            console.log('🔍 INLINE search test starting...');
            
            window.addEventListener('DOMContentLoaded', function() {
              console.log('🔍 DOM loaded, setting up search...');
              
              const input = document.getElementById('docSearch');
              const results = document.getElementById('searchResults');
              
              if (!input || !results) {
                console.log('❌ Elements missing:', {input: !!input, results: !!results});
                return;
              }
              
              console.log('✅ Elements found, applying styles...');
              
              // Force visible text with maximum contrast
              input.style.cssText = 'color: #000000 !important; background: #ffffff !important; font-weight: 400 !important; font-size: 14px !important; -webkit-text-fill-color: #000000 !important; text-shadow: none !important;';
              
              console.log('✅ Styles applied');
              
              // Simple search function
              window.doSearch = function(query) {
                console.log('🔍 Search called with:', query);
                results.innerHTML = '<li style="color: blue;">Testing search for: ' + query + '</li>';
                
                fetch('/docs/search?q=' + encodeURIComponent(query))
                  .then(function(response) {
                    console.log('📡 Got response:', response.status);
                    return response.text();
                  })
                  .then(function(text) {
                    console.log('📄 Got text:', text.substring(0, 100));
                    const data = JSON.parse(text);
                    
                    if (data.results && data.results.length > 0) {
                      const html = data.results.slice(0, 3).map(function(r) {
                        return '<li><a href="/docs/' + r.path + '">' + r.title + '</a></li>';
                      }).join('');
                      results.innerHTML = html;
                      console.log('✅ Results shown:', data.results.length);
                    } else {
                      results.innerHTML = '<li style="color: gray;">No results</li>';
                    }
                  })
                  .catch(function(error) {
                    console.log('❌ Error:', error);
                    results.innerHTML = '<li style="color: red;">Error: ' + error.message + '</li>';
                  });
              };
              
              // Auto search on input
              input.addEventListener('input', function() {
                const query = this.value.trim();
                if (query) {
                  console.log('⌨️ Input:', query);
                  window.doSearch(query);
                } else {
                  results.innerHTML = '';
                }
              });
              
              console.log('🎯 Search setup complete! Type in box or call doSearch("test")');
            });
          </script>
          <script src="/docs-search.js?v=${Date.now()}"></script>
        </div>
        <h2>Core Docs</h2>
        <ul>${core}</ul>
        <h2>Root Directory</h2>
        <ul>${rootList}</ul>
        <h2>/docs Directory</h2>
        <ul>${docsList}</ul>
        ${postmanSection}
      `;
      res.type('html').send(renderPage('Documentation', html, ''));
    } catch (_err) {
      sendError(res, 500, { code: 'DOCS_INDEX_FAILED', message: 'Failed to build docs index' });
    }
  });

  // Search endpoint
  router.get('/search', (req, res) => {
    const q = (req.query.q as string || '').toLowerCase().trim();
    if (!q) return res.json({ results: [] });
    const terms = q.split(/\s+/).filter(Boolean);
    const scored = searchDocs.map(d => {
      let score = 0;
      for (const t of terms) if (d.content.includes(t)) score++;
      return { path: d.path, title: d.title, score };
    }).filter(r => r.score > 0).sort((a,b) => b.score - a.score).slice(0, 25);
    return res.json({ results: scored });
  });

  // Highlight endpoint (snippet excerpts with term highlighting)
  router.get('/highlight', (req, res) => {
    const q = (req.query.q as string || '').toLowerCase().trim();
    if (!q) return res.json({ results: [] });
    const terms = q.split(/\s+/).filter(Boolean);
    const escapedTerms = terms.map(t => t.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'));
    const regex = new RegExp(`(${escapedTerms.join('|')})`, 'ig');
    const out = searchDocs.slice(0, 500).map(d => {
      const idx = terms
        .map(t => d.content.indexOf(t))
        .filter(i => i >= 0)
        .sort((a, b) => a - b)[0];
      if (idx === undefined) return null;
      const start = Math.max(0, idx - 50);
      const end = Math.min(d.content.length, idx + 150);
      const raw = d.content.slice(start, end);
      const esc = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const snippet = esc.replace(regex, '<mark>$1</mark>');
      return {
        path: d.path,
        title: d.title,
        snippet: (start > 0 ? '...' : '') + snippet + (end < d.content.length ? '...' : ''),
      };
    }).filter(Boolean).slice(0, 25);
    return res.json({ results: out });
  });

  // Wildcard dynamic docs route (supports nested directories)
  async function sendMarkdown(res: express.Response, safePath: string, req: express.Request) {
    const stat = fs.statSync(safePath);
    const cacheKey = safePath;
    const now = Date.now();
    const etag = `W/"${stat.size}-${stat.mtimeMs}"`;
    const ifNoneMatch = req.headers['if-none-match'];
    const ifModifiedSince = req.headers['if-modified-since'];
    if (ifNoneMatch === etag || (ifModifiedSince && new Date(ifModifiedSince).getTime() >= stat.mtimeMs)) {
      res.status(304).end();
      return;
    }
    const cached = renderCache.get(cacheKey);
    if (cached && (now - cached.mtimeMs) < CACHE_TTL_MS && cached.mtimeMs === stat.mtimeMs) {
      res.setHeader('ETag', etag);
      res.setHeader('Last-Modified', new Date(stat.mtimeMs).toUTCString());
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.type('html').send(cached.html);
      return;
    }
    const content = fs.readFileSync(safePath, 'utf8');
    const filename = path.basename(safePath);
    const humanName = filename.replace(/[-_]/g, ' ');
    const safeContent = content.replace(/<script/gi, '&lt;script').replace(/<\/script>/gi, '&lt;/script>');
  const marked = await loadMarked();
  let rendered = await marked.parse(safeContent) as string;
    rendered = addHeadingIds(rendered);
    const toc = buildTOC(rendered);
    const copyEnhancer = [
      '<script>(function(){',
      '  const blocks = document.querySelectorAll(\'pre > code\');',
      '  blocks.forEach(function(code){',
      '    const pre = code.parentElement; if(!pre) return; pre.style.position = \'relative\';',
      '    const btn = document.createElement(\'button\');',
      '    btn.textContent = \'Copy\';',
      '    btn.className = \'absolute top-1 right-1 text-xs px-2 py-1 bg-indigo-600 text-white rounded\';',
      '    btn.addEventListener(\'click\', function(){',
      '      try { navigator.clipboard.writeText(code.textContent||\'\'); } catch {}',
      '      btn.textContent = \'Copied\';',
      '      setTimeout(function(){ btn.textContent = \'Copy\'; }, 2000);',
      '    });',
      '    pre.appendChild(btn);',
      '  });',
      '})();</script>',
    ].join('\n');
    rendered += `\n${copyEnhancer}`;
    const full = renderPage(humanName, rendered, toc, safePath);
    renderCache.set(cacheKey, { html: full, mtimeMs: stat.mtimeMs });
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', new Date(stat.mtimeMs).toUTCString());
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.type('html').send(full);
  }

  function buildNotFound(rel: string): string {
    const qBox = [
      '<div class="my-6 p-4 border rounded bg-gray-50 dark:bg-slate-900">',
      '<label class="block text-sm font-semibold mb-1" for="docSearch404">Search Docs</label>',
      '<input id="docSearch" type="text" class="w-full p-2 border rounded bg-white dark:bg-slate-800 dark:border-slate-700" placeholder="Search..." />',
      '<ul id="searchResults" class="mt-3 space-y-1 text-sm"></ul>',
      `<script src="/docs-search.js?v=${Date.now()}"></script>`,
      '</div>',
    ].join('');
    return [
      '<h1>Not Found</h1>',
      `<p>The documentation path <code>${rel}</code> was not found.</p>`,
      qBox,
      '<p class="mt-4"><a class="text-indigo-600 hover:underline" href="/docs">Back to index</a></p>',
    ].join('');
  }

  async function renderDirectory(rel: string, absPath: string): Promise<string> {
    const entriesAll = fs.readdirSync(absPath).filter(e => !e.startsWith('.'));
    const dirs = entriesAll.filter(e => fs.statSync(path.join(absPath, e)).isDirectory()).sort();
    const files = entriesAll.filter(e => e.endsWith('.md') && !fs.statSync(path.join(absPath, e)).isDirectory()).sort();
    const entries = [...dirs, ...files];
    const readmeName = files.find(f => /^readme\.md$/i.test(f));
    const items = entries.map(e => {
      const full = path.join(absPath, e);
      const isDir = fs.statSync(full).isDirectory();
      const label = isDir ? `${e}/` : e;
      const normalizedRel = rel.replace(/\\/g, '/');
      // Fix: Only add slash between path components if normalizedRel doesn't already end with one
      const separator = normalizedRel && !normalizedRel.endsWith('/') ? '/' : '';
      const href = `/docs/${normalizedRel}${separator}${e}`;
      if (!isDir && !e.endsWith('.md')) return null;
      return `<li><a class="text-indigo-600 hover:underline" href="${href}">${label}</a></li>`;
    }).filter(Boolean).join('');
    const upLink = rel ? `<a class="text-indigo-600 hover:underline text-sm" href="/docs/${rel.split('/').slice(0,-1).join('/')}">⬅ Up</a>` : '';
    let preface = '';
    if (readmeName) {
      try {
        const raw = fs.readFileSync(path.join(absPath, readmeName), 'utf8');
        const safeContent = raw.replace(/<script/gi, '&lt;script').replace(/<\/script>/gi, '&lt;/script>');
        const marked = await loadMarked();
        let rendered = await marked.parse(safeContent) as string;
        rendered = addHeadingIds(rendered);
        preface = `<div class="mb-8 border-b pb-4">${rendered}</div>`;
      } catch (err) { logger.debug('Failed to render directory preface markdown', { error: err }); }
    }
    return `<h1>Directory: /${rel || ''}</h1>${upLink}${preface}<h2 class="mt-6">Contents</h2><ul class="mt-4 space-y-1">${items || '<li class="text-gray-500">(empty)</li>'}</ul>`;
  }

  // Use a regex instead of '*' to avoid path-to-regexp edge cases in production build
  // function handleRootFallback(rel: string, req: express.Request, res: express.Response): boolean { return false; }

  router.get(/^(.*)$/, async (req, res, next) => {
    logger.debug('[docs] Route handler invoked', { path: req.path, url: req.url });
    if (
      req.path === '/' ||
      req.path === '/test' ||
      req.path.startsWith('/search') ||
      req.path.startsWith('/highlight') ||
      req.path.startsWith('/reindex')
    ) return next();

    // Handle Postman collection rendering under /docs/postman/<file>
    if (req.path.startsWith('/postman/')) {
      const file = req.path.replace(/^\/postman\//, '');
      if (!file || file.includes('..')) return sendError(res, 400, { code: 'INVALID_PATH', message: 'Invalid path' }, req);
      const abs = path.join(postmanRoot, file);
      if (!abs.startsWith(postmanRoot)) return sendError(res, 400, { code: 'INVALID_PATH', message: 'Invalid path' }, req);
      if (!fs.existsSync(abs)) {
        const body404 = buildNotFound(`postman/${file}`);
        return res.status(404).type('html').send(renderPage('Not Found', body404));
      }
  if (!file.toLowerCase().endsWith('.postman_collection.json')) {
        return res.redirect(302, `/postman/${file}`); // delegate to raw static serve via app static route
      }
      try {
        const stat = fs.statSync(abs);
        const cacheKey = `postman:${abs}`;
        const now = Date.now();
        const etag = `W/\"${stat.size}-${stat.mtimeMs}\"`;
        const ifNoneMatch = req.headers['if-none-match'];
        if (ifNoneMatch === etag) return res.status(304).end();
        const cached = renderCache.get(cacheKey);
        if (cached && (now - cached.mtimeMs) < CACHE_TTL_MS && cached.mtimeMs === stat.mtimeMs) {
          res.setHeader('ETag', etag);
          res.setHeader('Cache-Control', 'public, max-age=60');
          return res.type('html').send(cached.html);
        }
        const raw = fs.readFileSync(abs, 'utf8');
        const data: PMCollection = JSON.parse(raw);
        // OpenAPI export (basic, inferred) if requested
        if (req.query.export === 'openapi') {
          const openapi: OpenAPIDoc = {
            openapi: '3.0.0',
            info: {
              title: data.info?.name || file,
              version: '1.0.0',
              description: typeof data.info?.description === 'string' ? data.info.description : undefined,
            },
            paths: {},
          };
          const addPath = (method: string, rawUrl: string, itemName: string, desc: string, urlObj?: PMUrlObject) => {
            if (!rawUrl) return;
            try {
              // Extract path (strip protocol/host if present)
              let pathPart = rawUrl;
              try { const u = new URL(rawUrl); pathPart = u.pathname || '/'; } catch { /* raw may not be absolute */ }
              if (!pathPart.startsWith('/')) pathPart = '/' + pathPart;
              // Replace Postman style params :id or {{var}} with {id}
              pathPart = pathPart
                .replace(/:\w+/g, m => `{${m.slice(1)}}`)
                .replace(/{{\s*([^}]+)\s*}}/g, '{$1}');
              const lowerMethod = method.toLowerCase();
              openapi.paths[pathPart] = openapi.paths[pathPart] || {};
              const op: OpenAPIOperation = openapi.paths[pathPart][lowerMethod] || { responses: { '200': { description: 'OK' } } };
              op.summary = op.summary || itemName;
              if (desc) op.description = (op.description ? op.description + '\n' : '') + desc;
              // Basic parameter inference: collect tokens inside {...}
              const paramNames = Array.from(pathPart.matchAll(/\{([^}]+)\}/g)).map(m => m[1]).filter(Boolean);
              if (paramNames.length) {
                op.parameters = op.parameters || [];
                for (const pName of paramNames) {
                  if (!op.parameters.find((p) => p.name === pName)) {
                    op.parameters.push({ name: pName, in: 'path', required: true, schema: { type: 'string' } });
                  }
                }
              }
              // Query param inference from Postman url object (if available)
              try {
                if (urlObj && typeof urlObj === 'object') {
                  const queries = urlObj.query || urlObj.queryParams || urlObj.search || [];
                  const arr = Array.isArray(queries) ? queries : [];
                  if (arr.length) {
                    op.parameters = op.parameters || [];
                    for (const q of arr) {
                      const qName = q?.key || q?.name;
                      if (!qName) continue;
                      if (!op.parameters.find((p) => p.name === qName)) {
                        op.parameters.push({ name: qName, in: 'query', required: false, schema: { type: 'string' } });
                      }
                    }
                  }
                }
              } catch (err) { logger.debug('Query parsing issue in Postman item', { error: err }); }
              openapi.paths[pathPart][lowerMethod] = op;
            } catch (err) { logger.debug('Path error in Postman conversion', { error: err }); }
          };
          const walk = (arr: PMItemNode[]) => {
            for (const it of arr) {
              if (it.request) {
                const { method, urlRaw, description, urlObj } = getPMRequestParts(it.request);
                const desc = extractPMDesc(description || it.description || '');
                addPath(method, urlRaw, it.name || '(unnamed)', desc, urlObj);
              }
              if (it.item && Array.isArray(it.item)) walk(it.item);
            }
          };
          if (Array.isArray(data.item)) walk(data.item);
          const wantsYaml = (typeof req.query.format === 'string' && req.query.format.toLowerCase() === 'yaml') || ('yaml' in req.query);
          if (wantsYaml) {
            try {
              // Lazy require to avoid mandatory dependency at runtime if unused
              const YAML = require('yaml');
              const doc = YAML.stringify(openapi);
              res.type('application/yaml').send(doc);
              return;
            } catch {
              // fallback to JSON if yaml lib missing
            }
          }
          res.type('application/json').send(JSON.stringify(openapi, null, 2));
          return;
        }
        // Markdown export if requested
        if (req.query.export === 'md') {
          const lines: string[] = [];
          lines.push(`# ${data.info?.name || file}`);
          if (data.info?.description) lines.push('', typeof data.info.description === 'string' ? data.info.description : JSON.stringify(data.info.description), '');
          const walkExport = (arr: PMItemNode[], depth = 2) => {
            for (const it of arr) {
              const name = it.name || '(unnamed)';
              if (it.request) {
                const { method, urlRaw, description } = getPMRequestParts(it.request);
                const desc = extractPMDesc(description || it.description || '');
                lines.push(`${'#'.repeat(depth)} ${method} ${urlRaw}`, '', desc ? `${desc}\n` : '', '```http', `${method} ${urlRaw}`, '```', '');
              } else {
                lines.push(`${'#'.repeat(depth)} ${name}`, '');
              }
              if (it.item && Array.isArray(it.item)) walkExport(it.item, depth + 1);
            }
          };
          if (Array.isArray(data.item)) walkExport(data.item);
          const mdOut = lines.join('\n').replace(/\n{3,}/g, '\n\n');
          res.type('text/markdown').send(mdOut);
          return;
        }
        const rows: string[] = [];
        const esc = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;');
        const walk = (items: PMItemNode[], prefix: string[] = []) => {
          for (const it of items) {
            const segs = [...prefix, it.name || '(unnamed)'];
            if (it.request) {
              try {
                const parts = getPMRequestParts(it.request);
                const method = esc(parts.method);
                const urlRaw = parts.urlRaw;
                const desc = esc(extractPMDesc(parts.description || it.description || ''));
                rows.push(`<tr class=\"align-top\"><td class=\"py-1 px-2 font-mono text-xs text-indigo-600\">${method}</td><td class=\"py-1 px-2 break-all\">${esc(urlRaw)}</td><td class=\"py-1 px-2\">${esc(segs.join(' / '))}</td><td class=\"py-1 px-2 text-xs text-slate-600\">${desc}</td></tr>`);
              } catch (err) { logger.debug('Skipping unparseable Postman item', { error: err }); }
            }
            if (it.item && Array.isArray(it.item)) walk(it.item, segs);
          }
        };
        if (Array.isArray(data.item)) walk(data.item);
        const title = esc(data.info?.name || file);
        const body = [
          `<h1>${title}</h1>`,
          `<p class=\"text-sm text-slate-600 dark:text-slate-400 mb-4\">Postman collection with ${rows.length} request${rows.length === 1 ? '' : 's'}.` +
          ` <a class=\\"text-indigo-600 hover:underline\\" href=\\"${encodeURIComponent(file)}?export=md\\">Export Markdown</a>` +
          ` <span class=\\"mx-1 text-gray-400\\">|</span> <a class=\\"text-indigo-600 hover:underline\\" href=\\"${encodeURIComponent(file)}?export=openapi\\">Export OpenAPI</a>` +
          ` <span class=\\"mx-1 text-gray-400\\">|</span> <a class=\\"text-indigo-600 hover:underline\\" href=\\"/postman/${encodeURIComponent(file)}\\" download>Download JSON</a>` +
          `</p>`,
          '<table class="text-sm w-full border-collapse">\n<thead><tr><th class="py-1 px-2 border">Method</th><th class="py-1 px-2 border">URL</th><th class="py-1 px-2 border">Folder Path</th><th class="py-1 px-2 border">Description</th></tr></thead><tbody>',
          rows.join('') || '<tr><td colspan="4" class="py-2 px-2 text-center text-slate-500">(no requests found)</td></tr>',
          '</tbody></table>',
          '<details class="mt-6"><summary class="cursor-pointer text-indigo-600">Raw JSON</summary>',
          `<pre class=\"mt-2 p-3 bg-slate-800 text-slate-100 overflow-auto text-xs rounded\"><code>${esc(raw)}</code></pre>` ,
          '</details>',
        ].join('\n');
        const full = renderPage(`Postman ${title}`, body, '');
        renderCache.set(cacheKey, { html: full, mtimeMs: stat.mtimeMs });
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'public, max-age=60');
        return res.type('html').send(full);
      } catch (e) {
        return res.status(500).type('html').send(renderPage('Error', `<h1>Failed to render collection</h1><pre>${(e as Error).message}</pre>`));
      }
    }

    // Since router is mounted at /docs, req.path should already be relative
    const rel = req.path.replace(/^\//, '').replace(/\\/g, '/');
    if (!rel || rel.includes('..')) return res.status(400).json({ error: 'Invalid path' });

    const docsRootLocal = path.join(__dirname, '../../docs');
    const safePath = path.normalize(path.join(docsRootLocal, rel));
    if (!safePath.startsWith(docsRootLocal)) return res.status(400).json({ error: 'Invalid path' });

    try {
      let actualPath = safePath;
      
      // If file not found in docs directory, try root directory for markdown files
      if (!fs.existsSync(safePath)) {
        const rootPath = path.join(__dirname, '../../', rel);
        if (fs.existsSync(rootPath) && rootPath.endsWith('.md')) {
          actualPath = rootPath;
        } else {
          const body404 = buildNotFound(rel);
          return res.status(404).type('html').send(renderPage('Not Found', body404));
        }
      }

      const stat = fs.statSync(actualPath);
      if (stat.isDirectory()) {
        const body = await renderDirectory(rel, actualPath);
        return res.type('html').send(renderPage(`Dir ${rel}`, body));
      }

      if (actualPath.endsWith('.md')) {
        const isExportReq = req.query.export === 'md';
        const isRawReq = req.query.raw === 'true';
        if (isExportReq || isRawReq) {
          // If a download override is explicitly asked for, use res.download
          if (isExportReq) {
            return res.download(actualPath, (err: NodeJS.ErrnoException | null) => {
              if (!err) return;
              if (res.headersSent) {
                // Transfer already started — cannot write a second response, return safely
                logger.warn('[docs] download error after headers sent', {
                  path: rel,
                  error: err.message,
                });
                return;
              }
              if (err.code === 'ENOENT') {
                return res.status(404).json({ error: 'File not found' });
              }
              return res.status(500).json({ error: 'Failed to export documentation' });
            });
          }
          // Otherwise, stream exactly as raw text file
          return res.sendFile(actualPath, (err: NodeJS.ErrnoException | null) => {
            if (!err) return;
            if (res.headersSent) {
              // Transfer already started — cannot write a second response, return safely
              logger.warn('[docs] sendFile error after headers sent', {
                path: rel,
                error: err.message,
              });
              return;
            }
            if (err.code === 'ENOENT') {
              return res.status(404).json({ error: 'File not found' });
            }
            return res.status(500).json({ error: 'Failed to load documentation' });
          });
        }
        return await sendMarkdown(res, actualPath, req);
      }

      return res.sendFile(actualPath, (err: unknown) => {
        if (err) res.status(404).json({ error: 'File not found' });
      });
    } catch (_err) {
      return res.status(500).json({ error: 'Failed to load documentation' });
    }
  });

  // Root-level markdown shortcuts handled in app.ts for clarity; no '/../' shadow routes here.

  return router;
}
