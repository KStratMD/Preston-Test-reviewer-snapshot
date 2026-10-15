/* eslint-env browser */
/* global document, location, localStorage, history, module */
(function () {
  function editDistance(a, b) {
    a = a.toLowerCase(); b = b.toLowerCase();
    const dp = Array(a.length + 1).fill(null).map(() => Array(b.length + 1).fill(0));
    for (let i = 0; i <= a.length; i++) dp[i][0] = i;
    for (let j = 0; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + cost,
        );
      }
    }
    return dp[a.length][b.length];
  }
  function scoreDoc(q, doc) {
    let score = 0;
    const terms = q.split(/\s+/).filter(Boolean);
    const lowerTitle = (doc.title || '').toLowerCase();
    const lowerContent = (doc.content || '').toLowerCase();
    for (const t of terms) {
      if (lowerContent.includes(t.toLowerCase())) score += 5;
      if (lowerTitle.includes(t.toLowerCase())) score += 3;
    }
    const dist = editDistance(q.slice(0, 40), lowerTitle.slice(0, 40));
    score += Math.max(0, 20 - dist);
    return score;
  }
  function escapeRegex(s) { return s.replace(/[-/\\^$*+?.()|{}[\]]/g, '\\$&'); }
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  // Titles and paths come from doc headings, file names and Postman collections: treat them as
  // text. Split the RAW title on the query and escape each piece, so a match can never land
  // inside an entity and no title markup reaches innerHTML.
  function highlightHtml(text, q) {
    const pattern = q.split(/\s+/).filter(Boolean).map(t => escapeRegex(t)).join('|');
    if (!pattern) return escapeHtml(text);
    return String(text).split(new RegExp(`(${pattern})`, 'ig'))
      .map((part, i) => (i % 2 === 1 ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part)))
      .join('');
  }
  // Result paths are raw file names (`a&b #1.md`, `what?.md`): encode every path segment so `#`
  // and `?` stay part of the name. Only Postman results carry a real `#folder/request` fragment,
  // and it starts right after the `.postman_collection.json` suffix — a `#` inside the
  // collection's own file name (`a#b.postman_collection.json`) is part of the name.
  function docHref(p) {
    const s = String(p || '');
    const m = /(^|\/)postman\//i.test(s) ? /\.postman_collection\.json#/i.exec(s) : null;
    const hash = m ? m.index + m[0].length - 1 : -1;
    const enc = x => x.split('/').map(encodeURIComponent).join('/');
    return hash >= 0 ? `/docs/${enc(s.slice(0, hash))}#${enc(s.slice(hash + 1))}` : `/docs/${enc(s)}`;
  }
  function renderResultsHtml(list, q) {
    return list.map(r => {
      const title = highlightHtml(r.title || '', q);
      const isPostman = /(^|\/)postman\//i.test(r.path || '');
      const badge = isPostman ? '<span class="ml-2 text-[10px] px-1 py-0.5 rounded bg-indigo-100 dark:bg-slate-700 text-indigo-700 dark:text-indigo-300">POSTMAN</span>' : '';
      const href = escapeHtml(docHref(r.path));
      return [
        '<li class="flex items-start gap-1">',
        // CRITICAL FIX: Search results link visibility (2025-09-09)
        // CHANGED: color from #1e40af (too light blue) → #1f2937 (dark readable text)
        `<a class="text-blue-800 dark:text-blue-300 hover:underline flex-1" href="${href}" style="color: #1f2937 !important;">`,
        title,
        '</a>',
        badge,
        `<span class="text-gray-400 dark:text-gray-500 ml-1 text-xs">${escapeHtml(r.score)}|${escapeHtml(r.fuzzy)}</span>`,
        '</li>',
      ].join('');
    }).join('');
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { escapeHtml, highlightHtml, renderResultsHtml };
  }
  if (typeof document === 'undefined') return;
  function build() {
    const input = document.getElementById('docSearch');
    const results = document.getElementById('searchResults');
    if (!input || !results) return;
    
    // CRITICAL FIX: JavaScript text visibility override (2025-09-09)
    // Problem: CSS cannot override JavaScript inline styles regardless of !important
    // Solution: Fix the JavaScript color values directly at the source
    // CHANGED: color from #333333 (too light) → #1f2937 (dark readable text)
    console.log('[SEARCH DEBUG] Applying dark text styles to search input');
    input.style.cssText = `
      color: #000000 !important;
      background-color: #ffffff !important;
      font-weight: 400 !important;
      font-size: 14px !important;
      border: 1px solid #6b7280 !important;
      opacity: 1 !important;
      -webkit-text-fill-color: #000000 !important;
      text-shadow: none !important;
    `;
    console.log('[SEARCH DEBUG] Search input styles applied:', input.style.cssText);
    const params = new URLSearchParams(location.search);
    const remembered = params.get('q') || localStorage.getItem('ih_docs_last_q') || '';
    if (remembered) { input.value = remembered; }
    let timer; let activeController;
    async function run() {
      const q = input.value.trim();
      console.log('[SEARCH DEBUG] Search query:', q);
      
      // VISUAL INDICATOR THAT SEARCH IS RUNNING
      results.innerHTML = '<li class="text-blue-600 italic">🔍 Searching...</li>';
      
      localStorage.setItem('ih_docs_last_q', q);
      const url = new URL(location.href);
      if (q) { url.searchParams.set('q', q); } else { url.searchParams.delete('q'); }
      history.replaceState(null, '', url.toString());
      if (!q) { 
        console.log('[SEARCH DEBUG] Empty query, clearing results');
        results.innerHTML = ''; 
        return; 
      }
      if (activeController) activeController.abort();
      activeController = new AbortController();
      
      // ADD TIMEOUT TO PREVENT HANGING
      const timeoutId = setTimeout(() => {
        console.log('[SEARCH DEBUG] Request timeout - aborting');
        activeController.abort();
      }, 5000); // 5 second timeout
      
      let res;
      const fetchUrl = `/docs/search?q=${encodeURIComponent(q)}`;
      console.log('[SEARCH DEBUG] Fetching:', fetchUrl);
      try {
        res = await fetch(fetchUrl, { 
          signal: activeController.signal,
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          }
        });
        clearTimeout(timeoutId); // Clear timeout on success
        console.log('[SEARCH DEBUG] Fetch response status:', res.status, res.ok);
        console.log('[SEARCH DEBUG] Response headers:', Object.fromEntries(res.headers.entries()));
      } catch (e) { 
        clearTimeout(timeoutId);
        console.log('[SEARCH DEBUG] Fetch error:', e);
        results.innerHTML = '<li class="text-red-600 italic">❌ Search failed - check console</li>';
        return; 
      }
      if (!res.ok) {
        console.log('[SEARCH DEBUG] Response not ok:', res.status);
        return; 
      }
      let data; 
      try { 
        const responseText = await res.text();
        console.log('[SEARCH DEBUG] Raw response text:', responseText.substring(0, 200) + '...');
        data = JSON.parse(responseText);
        console.log('[SEARCH DEBUG] Parsed response data:', data);
      } catch (e) { 
        console.log('[SEARCH DEBUG] JSON parse error:', e);
        results.innerHTML = '<li class="text-red-600 italic">❌ Invalid response format</li>';
        return; 
      }
      const list = (data.results || []);
      console.log('[SEARCH DEBUG] Results list length:', list.length);
      list.forEach(r => { r.fuzzy = scoreDoc(q, r); });
      list.sort((a, b) => b.fuzzy - a.fuzzy);
      if (list.length === 0) {
        console.log('[SEARCH DEBUG] No results found, showing no results message');
        results.innerHTML = '<li class="text-gray-500 italic">No results</li>';
        return;
      }
      const htmlResults = renderResultsHtml(list, q);
      console.log('[SEARCH DEBUG] Setting results HTML, length:', htmlResults.length);
      console.log('[SEARCH DEBUG] First few results:', htmlResults.substring(0, 200));
      results.innerHTML = htmlResults;
      console.log('[SEARCH DEBUG] Results innerHTML set successfully');
    }
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 160); });
    document.addEventListener('keydown', e => {
      if (e.key === '/' && document.activeElement !== input) { e.preventDefault(); input.focus(); }
      // FIXED: Only clear search on ESC if the search input is focused
      // This prevents conflict with document navigation ESC handling
      if (e.key === 'Escape' && document.activeElement === input) { 
        e.stopPropagation(); // Prevent other ESC handlers from running
        input.value = ''; 
        results.innerHTML = ''; 
        input.blur(); // Remove focus to let document navigation handle subsequent ESC
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); input.focus(); input.select(); }
    });
    if (input.value) { run(); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();
