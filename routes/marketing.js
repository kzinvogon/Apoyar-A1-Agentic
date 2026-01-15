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
function parseTable(tableContent, isMatrix = false) {
  const lines = tableContent.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return '';

  const tableClass = isMatrix ? 'matrix-table' : 'pricing-table';
  let html = `<div class="table-wrap"><table class="${tableClass}">`;

  const headerCells = lines[0].split('|').map(c => c.trim()).filter(c => c);
  html += '<thead><tr>';
  headerCells.forEach((cell, idx) => {
    const className = idx > 0 && isMatrix ? ' class="tier-col"' : '';
    html += `<th${className}>${cell}</th>`;
  });
  html += '</tr></thead>';

  html += '<tbody>';
  for (let i = 2; i < lines.length; i++) {
    const cells = lines[i].split('|').map(c => c.trim()).filter(c => c);
    html += '<tr>';
    cells.forEach((cell, idx) => {
      let className = '';
      if (idx === 0) {
        className = ' class="row-label"';
      } else if (isMatrix) {
        if (cell === 'Yes') {
          className = ' class="yes"';
          cell = '<span class="check">✓</span>';
        } else if (cell === '—') {
          className = ' class="no"';
          cell = '<span class="dash">—</span>';
        }
      }
      html += `<td${className}>${cell}</td>`;
    });
    html += '</tr>';
  }
  html += '</tbody></table></div>';

  return html;
}

// Parse cards block to HTML grid
function parseCards(cardsContent) {
  const cards = cardsContent.trim().split(/\n\n+/).filter(c => c.trim());
  let html = '<div class="integration-grid">';

  cards.forEach(card => {
    const lines = card.trim().split('\n');
    if (lines.length === 0) return;

    // First line is the title (bold)
    const titleMatch = lines[0].match(/^\*\*(.+?)\*\*$/);
    const title = titleMatch ? titleMatch[1] : lines[0];
    const items = lines.slice(1).filter(l => l.trim());

    html += '<div class="integration-card">';
    html += `<div class="card-header">${title}</div>`;
    html += '<div class="card-items">';
    items.forEach(item => {
      const isPlanned = item.toLowerCase().includes('planned');
      const isMsp = item.toLowerCase().includes('msp');
      let badges = '';
      if (isPlanned) badges += '<span class="badge badge-planned">Planned</span>';
      if (isMsp && !isPlanned) badges += '<span class="badge badge-msp">MSP</span>';
      html += `<div class="card-item">${item.replace(/\(planned\)/gi, '').replace(/\(MSP, planned\)/gi, '').replace(/\(MSP\)/gi, '').replace(/\(available\)/gi, '').replace(/\(all plans\)/gi, '').trim()}${badges}</div>`;
    });
    html += '</div></div>';
  });

  html += '</div>';
  return html;
}

// Simple markdown to HTML converter (no external dependencies)
function parseMarkdown(md) {
  // Protected blocks array - populated during pre-processing
  const protectedBlocks = [];

  // Helper to protect HTML from escaping
  function protect(html) {
    protectedBlocks.push(html);
    return `__PROTECTED_${protectedBlocks.length - 1}__`;
  }

  // Pre-processing: Extract and process cards (protect immediately)
  md = md.replace(/\[CARDS\]([\s\S]*?)\[\/CARDS\]/g, (match, content) => {
    return protect(parseCards(content));
  });

  // Pre-processing: Extract and process tables (protect immediately)
  // Detect if it's a matrix table (has Yes/— patterns)
  md = md.replace(/\[TABLE\]([\s\S]*?)\[\/TABLE\]/g, (match, tableContent) => {
    const isMatrix = tableContent.includes('| Yes |') || tableContent.includes('| — |');
    return protect(parseTable(tableContent, isMatrix));
  });

  // Pre-processing: Convert button syntax BEFORE escaping (protect immediately)
  md = md.replace(/\[BUTTON:([^\|]+)\|([^\]]+)\]/g, (match, text, href) => {
    return protect(`<a href="${href}" class="btn btn-primary">${text}</a>`);
  });
  md = md.replace(/\[BUTTON2:([^\|]+)\|([^\]]+)\]/g, (match, text, href) => {
    return protect(`<a href="${href}" class="btn btn-secondary">${text}</a>`);
  });

  // Pre-processing: Convert headings with IDs (protect immediately)
  md = md.replace(/^(#{1,6})\s+(.+?)\s+\{#([^}]+)\}$/gm, (match, hashes, title, id) => {
    const level = hashes.length;
    return protect(`<h${level} id="${id}" class="section-title">${title}</h${level}>`);
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
    { href: '#built', label: 'Built by operators' },
    { href: '#features', label: 'Features' },
    { href: '#integrations', label: 'Integrations' },
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
      --success: #059669;
      --success-light: #d1fae5;
      --warning: #d97706;
      --warning-light: #fef3c7;
      --purple: #7c3aed;
      --purple-light: #ede9fe;
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
      gap: 4px;
    }

    .nav-link {
      color: var(--text-muted);
      text-decoration: none;
      padding: 8px 12px;
      border-radius: var(--radius);
      font-size: 0.875rem;
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
      font-size: 0.875rem;
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
      padding: 8px 12px;
      font-size: 0.875rem;
      margin-left: 4px;
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

    /* === INTEGRATION CARDS GRID === */
    .integration-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 24px;
      margin: 32px 0 40px;
    }

    .integration-card {
      background: white;
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      overflow: hidden;
      transition: all 0.2s ease;
    }

    .integration-card:hover {
      box-shadow: var(--shadow);
      border-color: var(--primary-light);
    }

    .integration-card .card-header {
      background: var(--bg-dark);
      padding: 16px 20px;
      font-weight: 600;
      font-size: 0.95rem;
      color: var(--text);
      border-bottom: 1px solid var(--border);
    }

    .integration-card .card-items {
      padding: 16px 20px;
    }

    .integration-card .card-item {
      padding: 8px 0;
      font-size: 0.9rem;
      color: var(--text-muted);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .integration-card .card-item:last-child {
      border-bottom: none;
    }

    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 0.7rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      white-space: nowrap;
    }

    .badge-planned {
      background: var(--warning-light);
      color: var(--warning);
    }

    .badge-msp {
      background: var(--purple-light);
      color: var(--purple);
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

    .pricing-table td.plan-name,
    .pricing-table td.row-label {
      font-weight: 600;
      color: var(--primary);
      font-size: 1.05rem;
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

    /* === MATRIX TABLE (Integrations by plan) === */
    .matrix-table {
      width: 100%;
      border-collapse: collapse;
      background: white;
      min-width: 500px;
    }

    .matrix-table th,
    .matrix-table td {
      padding: 14px 16px;
      text-align: left;
      border-bottom: 1px solid var(--border);
      font-size: 0.9rem;
    }

    .matrix-table th {
      background: var(--bg-dark);
      font-weight: 600;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
    }

    .matrix-table th.tier-col {
      text-align: center;
      min-width: 100px;
    }

    .matrix-table td.row-label {
      font-weight: 500;
      color: var(--text);
      font-size: 0.9rem;
    }

    .matrix-table td.yes,
    .matrix-table td.no {
      text-align: center;
    }

    .matrix-table .check {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      background: var(--success-light);
      color: var(--success);
      border-radius: 50%;
      font-weight: bold;
      font-size: 0.85rem;
    }

    .matrix-table .dash {
      color: var(--text-light);
    }

    .matrix-table tbody tr:hover {
      background: var(--bg-alt);
    }

    .matrix-table tbody tr:last-child td {
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

    /* === PRICING SECTION ENHANCEMENTS === */
    #pricing .table-wrap + .table-wrap {
      margin-top: 48px;
    }

    h3.card-title + .table-wrap {
      margin-top: 16px;
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

      .integration-grid {
        grid-template-columns: 1fr;
      }

      .pricing-table th,
      .pricing-table td,
      .matrix-table th,
      .matrix-table td {
        padding: 12px;
        font-size: 0.85rem;
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

// Serve marketing pages - now using standalone HTML
router.get('/:page?', (req, res) => {
  const page = req.params.page || '';

  // Check for redirects (old pages -> anchors)
  if (REDIRECTS[page]) {
    const queryString = req.originalUrl.includes('?')
      ? req.originalUrl.substring(req.originalUrl.indexOf('?'))
      : '';
    return res.redirect(302, '/marketing' + REDIRECTS[page] + queryString);
  }

  // Serve the standalone HTML site
  const htmlPath = path.join(MARKETING_DIR, 'site.html');

  if (!fs.existsSync(htmlPath)) {
    // Fallback to markdown parsing if site.html doesn't exist
    const filename = PAGES[page];
    if (!filename) {
      return res.redirect(302, '/marketing');
    }
    const filepath = path.join(MARKETING_DIR, filename);
    if (!fs.existsSync(filepath)) {
      return res.status(404).send('<h1>Page Not Found</h1>');
    }
    const markdown = fs.readFileSync(filepath, 'utf8');
    const title = extractTitle(markdown);
    const html = parseMarkdown(markdown);
    res.set('Cache-Control', 'public, max-age=3600');
    return res.send(renderHTML(html, title, page || 'home'));
  }

  // Serve the standalone HTML
  res.set('Cache-Control', 'public, max-age=3600');
  res.sendFile(htmlPath);
});

module.exports = router;
