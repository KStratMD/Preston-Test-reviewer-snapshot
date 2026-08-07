/* global document, location, history */
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
    const lowerTitle = doc.title.toLowerCase();
    for (const t of terms) {
      if (doc.content.includes(t)) score += 5;
      if (lowerTitle.includes(t)) score += 3;
    }
    const dist = editDistance(q.slice(0, 40), lowerTitle.slice(0, 40));
    score += Math.max(0, 20 - dist);
    return score;
  }
  function escapeRegex(s) { return s.replace(/[-/\\^$*+?.()|{}[\]]/g, '\\$&'); }
  function build() {
    const input = document.getElementById('docSearch');
    const results = document.getElementById('searchResults');
    if (!input || !results) return;
    
    // FORCE TEXT VISIBILITY WITH JAVASCRIPT - BALANCED APPROACH
    console.log('[SEARCH DEBUG] Applying balanced styles to search input');
    input.style.cssText = `
      color: #1f2937 !important;
      background-color: #ffffff !important;
      font-weight: 500 !important;
      font-size: 14px !important;
      border: 1px solid #6b7280 !important;
      opacity: 1 !important;
      -webkit-text-fill-color: #1f2937 !important;
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
      const pattern = q.split(/\s+/).filter(Boolean).map(t => escapeRegex(t)).join('|');
      const re = new RegExp(`(${pattern})`, 'ig');
      const htmlResults = list.map(r => {
        const title = r.title.replace(re, '<mark>$1</mark>');
        const isPostman = /(^|\/)postman\//i.test(r.path);
        const badge = isPostman ? '<span class="ml-2 text-[10px] px-1 py-0.5 rounded bg-indigo-100 dark:bg-slate-700 text-indigo-700 dark:text-indigo-300">POSTMAN</span>' : '';
        return [
          '<li class="flex items-start gap-1">',
          `<a class="text-indigo-600 dark:text-indigo-400 hover:underline flex-1" href="/docs/${r.path}">`,
          title,
          '</a>',
          badge,
          `<span class="text-gray-400 dark:text-gray-500 ml-1 text-xs">${r.score}|${r.fuzzy}</span>`,
          '</li>',
        ].join('');
      }).join('');
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
