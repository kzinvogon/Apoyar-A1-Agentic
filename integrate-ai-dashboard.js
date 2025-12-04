const fs = require('fs');

console.log('🎨 Integrating AI Insights Dashboard...\n');

// Read the main HTML file
const htmlPath = './A1 Support Build from here .html';
let html = fs.readFileSync(htmlPath, 'utf8');

// Read the AI dashboard component
const aiDashboard = fs.readFileSync('./ai-insights-dashboard.html', 'utf8');

// Extract the view HTML
const viewMatch = aiDashboard.match(/<!-- AI Insights Dashboard.*?<!-- END AI Insights Dashboard -->/s);
if (!viewMatch) {
  console.error('❌ Could not find AI dashboard view in component file');
  process.exit(1);
}
const viewHtml = viewMatch[0];

// Extract the JavaScript
const jsMatch = aiDashboard.match(/<script>(.*?)<\/script>/s);
if (!jsMatch) {
  console.error('❌ Could not find JavaScript in component file');
  process.exit(1);
}
const jsCode = jsMatch[1];

// 1. Add navigation link (after Analytics nav link)
console.log('1️⃣  Adding navigation link...');
const navPattern = /(<div class="navlink" data-target="analytics"[^>]*>📈 Analytics<\/div>)/;
if (html.match(navPattern)) {
  html = html.replace(
    navPattern,
    '$1\n          <div class="navlink" data-target="ai-insights" onclick="nav(this)">🤖 AI Insights</div>'
  );
  console.log('   ✅ Navigation link added');
} else {
  console.log('   ⚠️  Could not find Analytics nav link, skipping');
}

// 2. Add the view (before Tickets view)
console.log('2️⃣  Adding AI Insights view...');
const ticketsViewPattern = /(<!-- Tickets -->\s*<div id="view-tickets")/;
if (html.match(ticketsViewPattern)) {
  html = html.replace(ticketsViewPattern, `\n${viewHtml}\n\n        $1`);
  console.log('   ✅ View added');
} else {
  console.log('   ⚠️  Could not find Tickets view marker, skipping');
}

// 3. Add JavaScript functions (before closing script tag)
console.log('3️⃣  Adding JavaScript functions...');
const scriptEndPattern = /(<\/script>\s*<\/body>)/;
if (html.match(scriptEndPattern)) {
  html = html.replace(scriptEndPattern, `\n\n  // ====== AI Insights Functions ======\n${jsCode}\n\n  $1`);
  console.log('   ✅ JavaScript added');
} else {
  console.log('   ⚠️  Could not find script closing tag, skipping');
}

// 4. Add to nav() function switch statement
console.log('4️⃣  Adding to nav() function...');
const navSwitchPattern = /(case 'analytics':\s*loadAnalytics\(\);\s*break;)/;
if (html.match(navSwitchPattern)) {
  html = html.replace(navSwitchPattern, "$1\n      case 'ai-insights': loadAIInsights(); break;");
  console.log('   ✅ Added to nav() switch statement');
} else {
  console.log('   ⚠️  Could not find analytics case in nav(), you may need to add manually');
}

// Write the updated HTML
console.log('\n5️⃣  Writing updated HTML file...');
fs.writeFileSync(htmlPath, html, 'utf8');
console.log('   ✅ File updated successfully!\n');

console.log('🎉 Integration complete!');
console.log('\n📝 Next steps:');
console.log('   1. Refresh your browser (hard refresh: Cmd+Shift+R or Ctrl+Shift+F5)');
console.log('   2. Look for the "🤖 AI Insights" link in the navigation');
console.log('   3. Click it to view your AI analytics dashboard!');
console.log('\n💡 The dashboard shows:');
console.log('   • Active insights and alerts');
console.log('   • Sentiment distribution');
console.log('   • Top categories');
console.log('   • Root cause analysis');
console.log('   • AI performance metrics');
