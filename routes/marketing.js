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

  let html = '<div class="table-wrap"><table class="pricing-table">';

  const headerCells = lines[0].split('|').map(c => c.trim()).filter(c => c);
  html += '<thead><tr>';
  headerCells.forEach(cell => {
    html += `<th>${cell}</th>`;
  });
  html += '</tr></thead>';

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
  html += '</tbody></table></div>';

  return html;
}

// Simple markdown to HTML converter (no external dependencies)
function parseMarkdown(md) {
  // Pre-processing: Extract and process tables
  md = md.replace(/\[TABLE\]([\s\S]*?)\[\/TABLE\]/g, (match, tableContent) => {
    return parseTable(tableContent);
  });

  // Pre-processing: Convert button syntax BEFORE escaping
  md = md.replace(/\[BUTTON:([^\|]+)\|([^\]]+)\]/g, '<a href="$2" class="btn btn-primary">$1</a>');
  md = md.replace(/\[BUTTON2:([^\|]+)\|([^\]]+)\]/g, '<a href="$2" class="btn btn-secondary">$1</a>');

  // Pre-processing: Convert headings with IDs
  md = md.replace(/^(#{1,6})\s+(.+?)\s+\{#([^}]+)\}$/gm, (match, hashes, title, id) => {
    const level = hashes.length;
    return `<h${level} id="${id}" class="section-title">${title}</h${level}>`;
  });

  // Mark already-processed HTML to protect from escaping
  const protectedBlocks = [];
  md = md.replace(/<(table|div|a|h[1-6])[^>]*>[\s\S]*?<\/\1>/gi, (match) => {
    protectedBlocks.push(match);
    return `__PROTECTED_${protectedBlocks.length - 1}__`;
  });
  md = md.replace(/<(a|h[1-6])[^>]*>[^<]*<\/\1>/gi, (match) => {
    protectedBlocks.push(match);
    return `__PROTECTED_${protectedBlocks.length - 1}__`;
  });

  let html = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Headers (non-ID versions)
    .replace(/^### (.+)$/gm, '<h3 class="card-title">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Em dash
    .replace(/ — /g, ' &mdash; ')
    .replace(/—/g, '&mdash;')
    // Links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    // Horizontal rules -> section breaks
    .replace(/^---$/gm, '</section><section class="section">')
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
      if (block.startsWith('<h') || block.startsWith('</section') || block.startsWith('<div') || block.startsWith('<a class="btn')) {
        return block;
      }

      // Wrap consecutive <li> in <ul>
      if (block.includes('<li>') && !block.includes('<p>')) {
        const nonListContent = block.replace(/<li>.*?<\/li>/gs, '').trim();
        if (!nonListContent) {
          return '<ul class="feature-list">' + block + '</ul>';
        }
      }

      // Button groups
      if (block.includes('<a class="btn')) {
        return '<div class="btn-group">' + block + '</div>';
      }

      // Wrap in paragraph
      if (!block.startsWith('<')) {
        return '<p>' + block.replace(/\n/g, '<br>') + '</p>';
      }

      return block;
    })
    .join('\n');

  // Wrap in opening section
  html = '<section class="section section-hero">' + html;
  // Close final section
  if (!html.endsWith('</section>')) {
    html += '</section>';
  }

  return html;
}

// Extract title from markdown (first H1)
function extractTitle(markdown) {
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
    { href: '#faq', label: 'FAQ' }
  ];

  const nav = navItems.map(item => {
    return `<a href="${item.href}" class="nav-link">${item.label}</a>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    /* === RESET & BASE === */
    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    :root {
      --primary: #2563eb;
      --primary-dark: #1d4ed8;
      --primary-light: #dbeafe;
      --text: #111827;
      --text-muted: #6b7280;
      --text-light: #9ca3af;
      --bg: #ffffff;
      --bg-alt: #f9fafb;
      --bg-dark: #f3f4f6;
      --border: #e5e7eb;
      --radius: 8px;
      --radius-lg: 12px;
      --shadow-sm: 0 1px 2px rgba(0,0,0,0.05);
      --shadow: 0 4px 6px -1px rgba(0,0,0,0.1);
      --shadow-lg: 0 20px 25px -5px rgba(0,0,0,0.1);
      --container: 1140px;
      --section-spacing: 80px;
    }

    html {
      scroll-behavior: smooth;
      font-size: 16px;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
      line-height: 1.6;
      color: var(--text);
      background: var(--bg);
      -webkit-font-smoothing: antialiased;
    }

    /* === STICKY NAV === */
    .navbar {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 1000;
      background: rgba(255,255,255,0.97);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border);
      padding: 0 24px;
      height: 64px;
    }

    .navbar-inner {
      max-width: var(--container);
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 100%;
    }

    .logo {
      font-size: 1.25rem;
      font-weight: 700;
      color: var(--primary);
      text-decoration: none;
      letter-spacing: -0.5px;
    }

    .nav-links {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .nav-link {
      color: var(--text-muted);
      text-decoration: none;
      padding: 8px 16px;
      border-radius: var(--radius);
      font-size: 0.9rem;
      font-weight: 500;
      transition: all 0.15s ease;
    }

    .nav-link:hover {
      color: var(--text);
      background: var(--bg-alt);
    }

    .nav-link.active {
      color: var(--primary);
      background: var(--primary-light);
    }

    .nav-cta {
      background: var(--primary);
      color: white !important;
      padding: 10px 20px;
      border-radius: var(--radius);
      font-weight: 600;
      font-size: 0.9rem;
      text-decoration: none;
      margin-left: 8px;
      transition: all 0.15s ease;
    }

    .nav-cta:hover {
      background: var(--primary-dark);
      transform: translateY(-1px);
    }

    .login-link {
      color: var(--text-muted);
      text-decoration: none;
      padding: 8px 16px;
      font-size: 0.9rem;
      margin-left: 8px;
    }

    .login-link:hover {
      color: var(--primary);
    }

    /* === MAIN CONTENT === */
    main {
      padding-top: 64px;
    }

    /* === SECTIONS === */
    .section {
      padding: var(--section-spacing) 24px;
      max-width: var(--container);
      margin: 0 auto;
    }

    .section:nth-child(even) {
      background: var(--bg-alt);
      max-width: 100%;
      padding-left: calc((100% - var(--container)) / 2 + 24px);
      padding-right: calc((100% - var(--container)) / 2 + 24px);
    }

    .section-hero {
      text-align: center;
      padding-top: 120px;
      padding-bottom: 100px;
    }

    .section-title {
      scroll-margin-top: 80px;
    }

    /* === TYPOGRAPHY === */
    h1 {
      font-size: 3.5rem;
      font-weight: 800;
      letter-spacing: -1.5px;
      line-height: 1.1;
      margin-bottom: 16px;
      color: var(--text);
    }

    h1 + h3, h1 + p {
      font-size: 1.25rem;
      color: var(--text-muted);
      font-weight: 400;
      max-width: 600px;
      margin: 0 auto 32px;
      line-height: 1.6;
    }

    h2 {
      font-size: 2rem;
      font-weight: 700;
      letter-spacing: -0.5px;
      margin-bottom: 16px;
      color: var(--text);
    }

    h2.section-title {
      font-size: 2.25rem;
      text-align: center;
      margin-bottom: 48px;
    }

    h3 {
      font-size: 1.125rem;
      font-weight: 600;
      margin-bottom: 12px;
      color: var(--text);
    }

    h3.card-title {
      font-size: 1.25rem;
      margin-bottom: 16px;
    }

    p {
      margin-bottom: 16px;
      color: var(--text-muted);
      max-width: 65ch;
    }

    .section-hero p {
      margin-left: auto;
      margin-right: auto;
    }

    strong {
      color: var(--text);
      font-weight: 600;
    }

    a {
      color: var(--primary);
      text-decoration: none;
    }

    a:hover {
      text-decoration: underline;
    }

    /* === BUTTONS === */
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 14px 28px;
      border-radius: var(--radius);
      font-weight: 600;
      font-size: 1rem;
      text-decoration: none !important;
      transition: all 0.15s ease;
      cursor: pointer;
      border: none;
    }

    .btn-primary {
      background: var(--primary);
      color: white;
      box-shadow: var(--shadow);
    }

    .btn-primary:hover {
      background: var(--primary-dark);
      transform: translateY(-2px);
      box-shadow: var(--shadow-lg);
    }

    .btn-secondary {
      background: white;
      color: var(--text);
      border: 2px solid var(--border);
    }

    .btn-secondary:hover {
      border-color: var(--primary);
      color: var(--primary);
    }

    .btn-group {
      display: flex;
      gap: 16px;
      margin: 32px 0;
      flex-wrap: wrap;
    }

    .section-hero .btn-group {
      justify-content: center;
    }

    /* === FEATURE CARDS === */
    h3.card-title {
      margin-top: 48px;
    }

    h3.card-title:first-of-type {
      margin-top: 0;
    }

    .feature-list {
      list-style: none;
      margin: 0 0 32px;
      padding: 0;
    }

    .feature-list li {
      position: relative;
      padding-left: 28px;
      margin-bottom: 12px;
      color: var(--text-muted);
    }

    .feature-list li::before {
      content: '';
      position: absolute;
      left: 0;
      top: 8px;
      width: 8px;
      height: 8px;
      background: var(--primary);
      border-radius: 50%;
    }

    /* === PRICING TABLE === */
    .table-wrap {
      overflow-x: auto;
      margin: 32px 0;
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow);
    }

    .pricing-table {
      width: 100%;
      border-collapse: collapse;
      background: white;
      min-width: 600px;
    }

    .pricing-table th,
    .pricing-table td {
      padding: 20px 24px;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }

    .pricing-table th {
      background: var(--bg-dark);
      font-weight: 600;
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
    }

    .pricing-table td.plan-name {
      font-weight: 700;
      color: var(--primary);
      font-size: 1.1rem;
    }

    .pricing-table tbody tr {
      transition: background 0.15s ease;
    }

    .pricing-table tbody tr:hover {
      background: var(--bg-alt);
    }

    .pricing-table tbody tr:last-child td {
      border-bottom: none;
    }

    /* === FAQ SECTION === */
    #faq + h3,
    h2#faq ~ h3 {
      margin-top: 32px;
      padding-top: 24px;
      border-top: 1px solid var(--border);
    }

    h2#faq ~ h3:first-of-type {
      border-top: none;
      padding-top: 0;
    }

    h2#faq ~ h3 + p {
      color: var(--text-muted);
    }

    /* === CONTACT SECTION === */
    #contact {
      text-align: center;
    }

    h2#contact ~ h3 {
      font-weight: 400;
      color: var(--text-muted);
      font-size: 1.125rem;
      text-align: center;
      border: none;
      margin-top: 8px;
    }

    h2#contact ~ p {
      text-align: center;
      margin-left: auto;
      margin-right: auto;
    }

    h2#contact ~ .btn-group {
      justify-content: center;
    }

    /* === FOOTER === */
    .section:last-child {
      text-align: center;
      padding-top: 48px;
      padding-bottom: 48px;
      border-top: 1px solid var(--border);
    }

    .section:last-child p {
      color: var(--text-muted);
      font-size: 0.9rem;
      margin: 0 auto 16px;
    }

    .section:last-child p:last-child a {
      color: var(--text-light);
      margin: 0 8px;
    }

    .section:last-child p:last-child a:hover {
      color: var(--primary);
    }

    /* === OUTCOMES/CARDS GRID === */
    #outcomes ~ .feature-list,
    h2#outcomes + .feature-list {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 24px;
      margin-top: 32px;
    }

    #outcomes ~ .feature-list li,
    h2#outcomes + .feature-list li {
      background: white;
      padding: 24px;
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-sm);
      border: 1px solid var(--border);
    }

    #outcomes ~ .feature-list li::before,
    h2#outcomes + .feature-list li::before {
      display: none;
    }

    /* === HOW IT WORKS === */
    h2#how ~ h3 {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    /* === RESPONSIVE === */
    @media (max-width: 768px) {
      :root {
        --section-spacing: 56px;
      }

      .navbar {
        padding: 0 16px;
      }

      .nav-links {
        display: none;
      }

      h1 {
        font-size: 2.25rem;
      }

      h2 {
        font-size: 1.75rem;
      }

      h2.section-title {
        font-size: 1.75rem;
        margin-bottom: 32px;
      }

      .section {
        padding-left: 16px;
        padding-right: 16px;
      }

      .section:nth-child(even) {
        padding-left: 16px;
        padding-right: 16px;
      }

      .section-hero {
        padding-top: 100px;
        padding-bottom: 64px;
      }

      .btn-group {
        flex-direction: column;
        align-items: stretch;
      }

      .btn {
        width: 100%;
      }

      .pricing-table th,
      .pricing-table td {
        padding: 16px;
        font-size: 0.9rem;
      }
    }

    /* === PRINT === */
    @media print {
      .navbar { display: none; }
      main { padding-top: 0; }
      .section { padding: 32px 0; }
    }
  </style>
</head>
<body>
  <nav class="navbar">
    <div class="navbar-inner">
      <a href="/marketing" class="logo">ServiFlow</a>
      <div class="nav-links">
        ${nav}
        <a href="#contact" class="nav-cta">Request demo</a>
        <a href="/" class="login-link">Login</a>
      </div>
    </div>
  </nav>

  <main>
    ${content}
  </main>

  <script>
    // Smooth scroll for anchor links
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
      anchor.addEventListener('click', function(e) {
        const targetId = this.getAttribute('href');
        const target = document.querySelector(targetId);
        if (target) {
          e.preventDefault();
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          history.pushState(null, null, targetId);
        }
      });
    });

    // Highlight active nav on scroll
    const sections = document.querySelectorAll('[id]');
    const navLinks = document.querySelectorAll('.nav-link');

    const observerOptions = {
      rootMargin: '-20% 0px -80% 0px'
    };

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const id = entry.target.getAttribute('id');
          navLinks.forEach(link => {
            link.classList.remove('active');
            if (link.getAttribute('href') === '#' + id) {
              link.classList.add('active');
            }
          });
        }
      });
    }, observerOptions);

    sections.forEach(section => observer.observe(section));
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

  res.set('Cache-Control', 'public, max-age=3600');
  res.send(renderHTML(html, title, page || 'home'));
});

module.exports = router;
