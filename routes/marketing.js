const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

// Redirect mappings for old pages to anchors
const REDIRECTS = {
  'pricing': '#pricing',
  'features-sla': '#features',
  'features-cmdb': '#features',
  'customer-portal': '#features',
  'msp': '#pricing',
  'security': '#security'
};

// Marketing pages - index.md is the single-page site
const PAGES = {
  '': 'index.md',
  'home': 'index.md'
};

const MARKETING_DIR = path.join(__dirname, '..', 'marketing');

// Parse markdown table to HTML
function parseTable(tableContent) {
  const lines = tableContent.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return '';

  let html = '<table class="pricing-table">';

  // Header row
  const headerCells = lines[0].split('|').map(c => c.trim()).filter(c => c);
  html += '<thead><tr>';
  headerCells.forEach(cell => {
    html += `<th>${cell}</th>`;
  });
  html += '</tr></thead>';

  // Skip separator row (index 1)
  // Body rows
  html += '<tbody>';
  for (let i = 2; i < lines.length; i++) {
    const cells = lines[i].split('|').map(c => c.trim()).filter(c => c);
    html += '<tr>';
    cells.forEach((cell, idx) => {
      const className = idx === 0 ? ' class="plan-name"' : '';
      html += `<td${className}>${cell}</td>`;
    });
    html += '</tr>';
  }
  html += '</tbody></table>';

  return html;
}

// Simple markdown to HTML converter (no external dependencies)
function parseMarkdown(md) {
  // Pre-processing: Extract and process tables
  md = md.replace(/\[TABLE\]([\s\S]*?)\[\/TABLE\]/g, (match, tableContent) => {
    return parseTable(tableContent);
  });

  // Pre-processing: Convert button syntax BEFORE escaping
  // [BUTTON:text|url] -> primary button
  // [BUTTON2:text|url] -> secondary button
  md = md.replace(/\[BUTTON:([^\|]+)\|([^\]]+)\]/g, '<a href="$2" class="btn primary">$1</a>');
  md = md.replace(/\[BUTTON2:([^\|]+)\|([^\]]+)\]/g, '<a href="$2" class="btn secondary">$1</a>');

  // Pre-processing: Convert headings with IDs
  // ## Title {#id} -> <h2 id="id">Title</h2>
  md = md.replace(/^(#{1,6})\s+(.+?)\s+\{#([^}]+)\}$/gm, (match, hashes, title, id) => {
    const level = hashes.length;
    return `<h${level} id="${id}">${title}</h${level}>`;
  });

  // Mark already-processed HTML to protect from escaping
  const protectedBlocks = [];
  md = md.replace(/<(table|a|h[1-6])[^>]*>[\s\S]*?<\/\1>/gi, (match) => {
    protectedBlocks.push(match);
    return `__PROTECTED_${protectedBlocks.length - 1}__`;
  });
  md = md.replace(/<(a|h[1-6])[^>]*>[^<]*<\/\1>/gi, (match) => {
    protectedBlocks.push(match);
    return `__PROTECTED_${protectedBlocks.length - 1}__`;
  });

  let html = md
    // Escape remaining HTML (but not our protected blocks)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Headers (non-ID versions)
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Em dash
    .replace(/ — /g, ' &mdash; ')
    .replace(/—/g, '&mdash;')
    // Links (that weren't already processed as buttons)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    // Horizontal rules
    .replace(/^---$/gm, '<hr>')
    // List items
    .replace(/^- (.+)$/gm, '<li>$1</li>');

  // Restore protected blocks
  protectedBlocks.forEach((block, i) => {
    html = html.replace(`__PROTECTED_${i}__`, block);
  });

  // Process blocks for paragraphs and list wrapping
  html = html
    .split('\n\n')
    .map(block => {
      block = block.trim();
      if (!block) return '';

      // Already tagged content
      if (block.startsWith('<h') || block.startsWith('<hr') || block.startsWith('<table') || block.startsWith('<a class="btn')) {
        return block;
      }

      // Wrap consecutive <li> in <ul>
      if (block.includes('<li>')) {
        // Check if it's ONLY list items
        const nonListContent = block.replace(/<li>.*?<\/li>/g, '').trim();
        if (!nonListContent) {
          return '<ul>' + block + '</ul>';
        }
        // Mixed content - wrap list portion
        return block.replace(/(<li>[\s\S]*<\/li>)/g, '<ul>$1</ul>');
      }

      // Button groups
      if (block.includes('<a class="btn')) {
        return '<div class="btn-group">' + block + '</div>';
      }

      // Wrap in paragraph if not already tagged
      return '<p>' + block.replace(/\n/g, '<br>') + '</p>';
    })
    .join('\n');

  return html;
}

// Extract title from markdown (first H1)
function extractTitle(markdown) {
  // Check for {#id} style first
  const matchWithId = markdown.match(/^#\s+(.+?)\s+\{#[^}]+\}$/m);
  if (matchWithId) return matchWithId[1];

  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1] : 'ServiFlow';
}

// HTML template with navigation and styling for single-page site
function renderHTML(content, title, currentPage) {
  const navItems = [
    { href: '#features', label: 'Features' },
    { href: '#pricing', label: 'Pricing' },
    { href: '#how', label: 'How it works' },
    { href: '#security', label: 'Security' },
    { href: '#faq', label: 'FAQ' },
    { href: '#contact', label: 'Contact', cta: true }
  ];

  const nav = navItems.map(item => {
    const className = item.cta ? 'nav-cta' : '';
    return `<a href="${item.href}" class="${className}">${item.label}</a>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    :root {
      --primary: #2563eb;
      --primary-dark: #1d4ed8;
      --primary-light: #3b82f6;
      --text: #1f2937;
      --text-muted: #6b7280;
      --text-light: #9ca3af;
      --bg: #ffffff;
      --bg-alt: #f9fafb;
      --bg-dark: #111827;
      --border: #e5e7eb;
      --radius: 8px;
      --shadow: 0 1px 3px rgba(0,0,0,0.1);
      --shadow-lg: 0 10px 40px rgba(0,0,0,0.1);
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    html {
      scroll-behavior: smooth;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.6;
      color: var(--text);
      background: var(--bg);
    }

    /* Header */
    header {
      background: rgba(255,255,255,0.95);
      backdrop-filter: blur(10px);
      border-bottom: 1px solid var(--border);
      padding: 0.75rem 2rem;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 100;
    }

    .header-inner {
      max-width: 1200px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
    }

    .logo {
      font-size: 1.25rem;
      font-weight: 700;
      color: var(--primary);
      text-decoration: none;
    }

    nav {
      display: flex;
      gap: 0.25rem;
      align-items: center;
    }

    nav a {
      color: var(--text-muted);
      text-decoration: none;
      padding: 0.5rem 0.75rem;
      border-radius: var(--radius);
      font-size: 0.875rem;
      transition: all 0.2s;
    }

    nav a:hover {
      color: var(--primary);
      background: var(--bg-alt);
    }

    nav a.nav-cta {
      background: var(--primary);
      color: white;
      margin-left: 0.5rem;
    }

    nav a.nav-cta:hover {
      background: var(--primary-dark);
    }

    .login-btn {
      color: var(--text-muted);
      text-decoration: none;
      padding: 0.5rem 1rem;
      font-size: 0.875rem;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      margin-left: 0.5rem;
    }

    .login-btn:hover {
      border-color: var(--primary);
      color: var(--primary);
    }

    /* Main content */
    main {
      padding-top: 60px;
    }

    /* Sections */
    .section {
      padding: 64px 24px;
    }

    .section:nth-child(even) {
      background: var(--bg-alt);
    }

    .container {
      max-width: 900px;
      margin: 0 auto;
    }

    /* Hero section */
    main > h1:first-of-type {
      font-size: 3rem;
      font-weight: 800;
      margin-bottom: 0.5rem;
      padding-top: 80px;
      text-align: center;
    }

    main > h1:first-of-type + h3,
    main > h1:first-of-type + p {
      font-size: 1.25rem;
      color: var(--text-muted);
      font-weight: 400;
      text-align: center;
      max-width: 700px;
      margin: 0 auto 1rem;
    }

    main > h1:first-of-type ~ p:first-of-type {
      text-align: center;
      max-width: 700px;
      margin: 0 auto 2rem;
    }

    main > h1:first-of-type ~ .btn-group:first-of-type {
      text-align: center;
      margin-bottom: 3rem;
    }

    /* Typography */
    h1, h2, h3 {
      color: var(--text);
      line-height: 1.3;
    }

    h1 { font-size: 2.5rem; margin: 2rem 0 1rem; }
    h2 { font-size: 1.75rem; margin: 3rem 0 1rem; padding-top: 1rem; }
    h3 { font-size: 1.25rem; margin: 2rem 0 0.75rem; }

    h2[id] {
      scroll-margin-top: 80px;
    }

    p {
      margin-bottom: 1rem;
      max-width: 900px;
    }

    hr {
      border: none;
      border-top: 1px solid var(--border);
      margin: 3rem auto;
      max-width: 900px;
    }

    strong {
      color: var(--text);
    }

    a {
      color: var(--primary);
      text-decoration: none;
    }

    a:hover {
      text-decoration: underline;
    }

    /* Lists */
    ul {
      margin: 1rem 0 1.5rem 1.25rem;
      max-width: 900px;
    }

    li {
      margin-bottom: 0.5rem;
      color: var(--text);
    }

    /* Buttons */
    .btn {
      display: inline-block;
      padding: 0.75rem 1.5rem;
      border-radius: var(--radius);
      font-weight: 500;
      font-size: 1rem;
      text-decoration: none;
      transition: all 0.2s;
      margin: 0.25rem;
    }

    .btn.primary {
      background: var(--primary);
      color: white;
      box-shadow: var(--shadow);
    }

    .btn.primary:hover {
      background: var(--primary-dark);
      text-decoration: none;
      transform: translateY(-1px);
      box-shadow: var(--shadow-lg);
    }

    .btn.secondary {
      background: white;
      color: var(--text);
      border: 1px solid var(--border);
    }

    .btn.secondary:hover {
      border-color: var(--primary);
      color: var(--primary);
      text-decoration: none;
    }

    .btn-group {
      margin: 1.5rem 0;
    }

    /* Pricing table */
    .pricing-table {
      width: 100%;
      border-collapse: collapse;
      margin: 1.5rem 0 2rem;
      background: white;
      border-radius: var(--radius);
      overflow: hidden;
      box-shadow: var(--shadow);
    }

    .pricing-table th,
    .pricing-table td {
      padding: 1rem 1.25rem;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }

    .pricing-table th {
      background: var(--bg-alt);
      font-weight: 600;
      font-size: 0.875rem;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
    }

    .pricing-table td.plan-name {
      font-weight: 600;
      color: var(--primary);
    }

    .pricing-table tbody tr:hover {
      background: var(--bg-alt);
    }

    .pricing-table tbody tr:last-child td {
      border-bottom: none;
    }

    /* FAQ styling */
    h2#faq ~ h3 {
      color: var(--text);
      font-weight: 600;
    }

    h2#faq ~ h3 + p {
      color: var(--text-muted);
      margin-bottom: 2rem;
    }

    /* Contact section */
    h2#contact {
      text-align: center;
    }

    h2#contact ~ h3 {
      text-align: center;
      font-weight: 400;
      color: var(--text-muted);
    }

    h2#contact ~ p {
      text-align: center;
    }

    h2#contact ~ .btn-group {
      text-align: center;
    }

    /* Footer area */
    main > hr:last-of-type ~ p {
      text-align: center;
      color: var(--text-muted);
      font-size: 0.875rem;
    }

    main > hr:last-of-type ~ p:last-of-type {
      margin-top: 1rem;
    }

    main > hr:last-of-type ~ p:last-of-type a {
      color: var(--text-muted);
      margin: 0 0.25rem;
    }

    main > hr:last-of-type ~ p:last-of-type a:hover {
      color: var(--primary);
    }

    /* Responsive */
    @media (max-width: 768px) {
      header {
        padding: 0.75rem 1rem;
      }

      nav {
        display: none;
      }

      .login-btn {
        margin-left: auto;
      }

      main > h1:first-of-type {
        font-size: 2rem;
        padding-top: 60px;
      }

      h1 { font-size: 1.75rem; }
      h2 { font-size: 1.5rem; }

      .section {
        padding: 48px 16px;
      }

      .pricing-table {
        font-size: 0.875rem;
      }

      .pricing-table th,
      .pricing-table td {
        padding: 0.75rem;
      }

      .btn {
        display: block;
        text-align: center;
        margin: 0.5rem 0;
      }
    }

    /* Print */
    @media print {
      header { display: none; }
      main { padding-top: 0; }
    }
  </style>
</head>
<body>
  <header>
    <div class="header-inner">
      <a href="/marketing" class="logo">ServiFlow</a>
      <nav>
        ${nav}
      </nav>
      <a href="/" class="login-btn">Login</a>
    </div>
  </header>

  <main class="container">
    ${content}
  </main>

  <script>
    // Smooth scroll for anchor links and update URL
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
      anchor.addEventListener('click', function(e) {
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
          e.preventDefault();
          target.scrollIntoView({ behavior: 'smooth' });
          history.pushState(null, null, this.getAttribute('href'));
        }
      });
    });

    // Highlight active nav on scroll
    const sections = document.querySelectorAll('h2[id]');
    const navLinks = document.querySelectorAll('nav a[href^="#"]');

    window.addEventListener('scroll', () => {
      let current = '';
      sections.forEach(section => {
        const rect = section.getBoundingClientRect();
        if (rect.top <= 100) {
          current = section.getAttribute('id');
        }
      });

      navLinks.forEach(link => {
        link.classList.remove('active');
        if (link.getAttribute('href') === '#' + current) {
          link.classList.add('active');
        }
      });
    });
  </script>
</body>
</html>`;
}

// Serve marketing pages
router.get('/:page?', (req, res) => {
  const page = req.params.page || '';

  // Check for redirects (old pages -> anchors)
  if (REDIRECTS[page]) {
    const queryString = req.originalUrl.includes('?')
      ? req.originalUrl.substring(req.originalUrl.indexOf('?'))
      : '';
    return res.redirect(302, '/marketing' + REDIRECTS[page] + queryString);
  }

  // Check if valid page
  const filename = PAGES[page];
  if (!filename) {
    return res.redirect(302, '/marketing');
  }

  const filepath = path.join(MARKETING_DIR, filename);

  if (!fs.existsSync(filepath)) {
    return res.status(404).send(renderHTML('<h1>Page Not Found</h1><p>The page you requested does not exist.</p>', 'Not Found', ''));
  }

  const markdown = fs.readFileSync(filepath, 'utf8');
  const title = extractTitle(markdown);
  const html = parseMarkdown(markdown);

  // Cache for 1 hour in production
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(renderHTML(html, title, page || 'home'));
});

module.exports = router;
