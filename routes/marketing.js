const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

// Simple markdown to HTML converter (no external dependencies)
function parseMarkdown(md) {
  let html = md
    // Escape HTML
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Headers
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    // Horizontal rules
    .replace(/^---$/gm, '<hr>')
    // List items
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    // Paragraphs (lines not already tagged)
    .split('\n\n')
    .map(block => {
      block = block.trim();
      if (!block) return '';
      if (block.startsWith('<h') || block.startsWith('<hr') || block.startsWith('<li>')) {
        // Wrap consecutive <li> in <ul>
        if (block.includes('<li>')) {
          return '<ul>' + block + '</ul>';
        }
        return block;
      }
      // Wrap in paragraph if not already tagged
      return '<p>' + block.replace(/\n/g, '<br>') + '</p>';
    })
    .join('\n');

  return html;
}

// Marketing pages - no auth required
const PAGES = {
  '': 'home.md',
  'home': 'home.md',
  'pricing': 'pricing.md',
  'features-sla': 'features-sla.md',
  'features-cmdb': 'features-cmdb.md',
  'customer-portal': 'customer-portal.md',
  'msp': 'msp.md',
  'security': 'security.md'
};

const MARKETING_DIR = path.join(__dirname, '..', 'marketing');

// HTML template with navigation and styling
function renderHTML(content, title, currentPage) {
  const footerPath = path.join(MARKETING_DIR, 'footer.md');
  let footerContent = '';
  if (fs.existsSync(footerPath)) {
    footerContent = parseMarkdown(fs.readFileSync(footerPath, 'utf8'));
  }

  const navItems = [
    { href: '/marketing', label: 'Home', key: '' },
    { href: '/marketing/pricing', label: 'Pricing', key: 'pricing' },
    { href: '/marketing/features-sla', label: 'SLA Engine', key: 'features-sla' },
    { href: '/marketing/features-cmdb', label: 'CMDB', key: 'features-cmdb' },
    { href: '/marketing/customer-portal', label: 'Customer Portal', key: 'customer-portal' },
    { href: '/marketing/msp', label: 'MSP', key: 'msp' },
    { href: '/marketing/security', label: 'Security', key: 'security' }
  ];

  const nav = navItems.map(item => {
    const isActive = item.key === currentPage || (currentPage === 'home' && item.key === '');
    return `<a href="${item.href}" class="${isActive ? 'active' : ''}">${item.label}</a>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - ServiFlow</title>
  <style>
    :root {
      --primary: #2563eb;
      --primary-dark: #1d4ed8;
      --text: #1f2937;
      --text-muted: #6b7280;
      --bg: #ffffff;
      --bg-alt: #f9fafb;
      --border: #e5e7eb;
      --radius: 8px;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.6;
      color: var(--text);
      background: var(--bg);
    }

    header {
      background: var(--bg);
      border-bottom: 1px solid var(--border);
      padding: 1rem 2rem;
      position: sticky;
      top: 0;
      z-index: 100;
    }

    .header-inner {
      max-width: 1200px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 1rem;
    }

    .logo {
      font-size: 1.5rem;
      font-weight: 700;
      color: var(--primary);
      text-decoration: none;
    }

    nav {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
    }

    nav a {
      color: var(--text-muted);
      text-decoration: none;
      padding: 0.5rem 1rem;
      border-radius: var(--radius);
      font-size: 0.9rem;
      transition: all 0.2s;
    }

    nav a:hover {
      color: var(--primary);
      background: var(--bg-alt);
    }

    nav a.active {
      color: var(--primary);
      background: #eff6ff;
      font-weight: 500;
    }

    .cta-btn {
      display: inline-block;
      background: var(--primary);
      color: white !important;
      padding: 0.6rem 1.2rem;
      border-radius: var(--radius);
      font-weight: 500;
      text-decoration: none;
      transition: background 0.2s;
    }

    .cta-btn:hover {
      background: var(--primary-dark);
    }

    main {
      max-width: 800px;
      margin: 0 auto;
      padding: 3rem 2rem;
    }

    main h1 {
      font-size: 2.5rem;
      margin-bottom: 0.5rem;
      color: var(--text);
    }

    main h2 {
      font-size: 1.5rem;
      color: var(--text-muted);
      font-weight: 400;
      margin-bottom: 2rem;
    }

    main h3 {
      font-size: 1.25rem;
      margin: 2.5rem 0 1rem;
      color: var(--text);
    }

    main p {
      margin-bottom: 1rem;
      color: var(--text);
    }

    main hr {
      border: none;
      border-top: 1px solid var(--border);
      margin: 2rem 0;
    }

    main ul, main ol {
      margin: 1rem 0 1rem 1.5rem;
    }

    main li {
      margin-bottom: 0.5rem;
    }

    main strong {
      color: var(--text);
    }

    main a {
      color: var(--primary);
      text-decoration: none;
    }

    main a:hover {
      text-decoration: underline;
    }

    main a[href^="/marketing"]:not(.cta-btn) {
      display: inline-block;
      margin-top: 0.5rem;
      font-weight: 500;
    }

    /* Table styling */
    main table {
      width: 100%;
      border-collapse: collapse;
      margin: 1.5rem 0;
    }

    main th, main td {
      padding: 0.75rem;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }

    main th {
      font-weight: 600;
      background: var(--bg-alt);
    }

    /* Code styling */
    main code {
      background: var(--bg-alt);
      padding: 0.2rem 0.4rem;
      border-radius: 4px;
      font-size: 0.9em;
    }

    main pre {
      background: var(--bg-alt);
      padding: 1rem;
      border-radius: var(--radius);
      overflow-x: auto;
      margin: 1rem 0;
    }

    main pre code {
      background: none;
      padding: 0;
    }

    footer {
      background: var(--bg-alt);
      border-top: 1px solid var(--border);
      padding: 2rem;
      margin-top: 3rem;
    }

    footer .footer-inner {
      max-width: 800px;
      margin: 0 auto;
      text-align: center;
      color: var(--text-muted);
      font-size: 0.9rem;
    }

    footer h1 {
      font-size: 1.25rem;
      color: var(--primary);
      margin-bottom: 0.5rem;
    }

    footer p {
      margin-bottom: 1rem;
    }

    footer a {
      color: var(--text-muted);
      text-decoration: none;
      margin: 0 0.5rem;
    }

    footer a:hover {
      color: var(--primary);
    }

    footer hr {
      border: none;
      border-top: 1px solid var(--border);
      margin: 1rem 0;
    }

    @media (max-width: 768px) {
      header {
        padding: 1rem;
      }

      .header-inner {
        flex-direction: column;
        align-items: flex-start;
      }

      nav {
        width: 100%;
        justify-content: flex-start;
      }

      main {
        padding: 2rem 1rem;
      }

      main h1 {
        font-size: 2rem;
      }
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
      <a href="/" class="cta-btn">Login</a>
    </div>
  </header>

  <main>
    ${content}
  </main>

  <footer>
    <div class="footer-inner">
      ${footerContent}
    </div>
  </footer>
</body>
</html>`;
}

// Extract title from markdown (first H1)
function extractTitle(markdown) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1] : 'ServiFlow';
}

// Serve marketing pages
router.get('/:page?', (req, res) => {
  const page = req.params.page || '';
  const filename = PAGES[page];

  if (!filename) {
    return res.status(404).send(renderHTML('<h1>Page Not Found</h1><p>The page you requested does not exist.</p>', 'Not Found', ''));
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
