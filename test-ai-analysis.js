const { AIAnalysisService } = require('./services/ai-analysis-service');
const { getTenantConnection } = require('./config/database');

async function testAIAnalysis() {
  console.log('🤖 AI Analysis Test\n');

  try {
    const aiService = new AIAnalysisService('apoyar');
    const connection = await getTenantConnection('apoyar');

    try {
      // Get recent unanalyzed tickets
      console.log('1️⃣  Finding unanalyzed tickets...\n');
      const [tickets] = await connection.query(`
        SELECT t.id, t.title, t.description, t.category
        FROM tickets t
        WHERE t.ai_analyzed = FALSE
        ORDER BY t.created_at DESC
        LIMIT 10
      `);

      console.log(`Found ${tickets.length} unanalyzed tickets\n`);

      // Analyze each ticket
      for (const ticket of tickets) {
        console.log(`📧 Analyzing Ticket #${ticket.id}...`);
        console.log(`   Title: ${ticket.title.substring(0, 60)}...`);

        const emailData = {
          subject: ticket.title,
          body: ticket.description,
          ticketId: ticket.id
        };

        const analysis = await aiService.analyzeTicket(ticket.id, emailData);

        console.log(`   ✅ Sentiment: ${analysis.sentiment} (${analysis.confidence}% confident)`);
        console.log(`   📊 Category: ${analysis.category}`);
        console.log(`   🔍 Root Cause: ${analysis.rootCause}`);
        console.log(`   ⚡ Impact: ${analysis.impactLevel}`);
        console.log();
      }

      // Detect trends
      console.log('\n2️⃣  Detecting trends and insights...\n');
      const insights = await aiService.detectTrends(24);

      console.log(`\n✅ Found ${insights.length} insights:\n`);
      insights.forEach((insight, i) => {
        console.log(`${i + 1}. [${insight.severity.toUpperCase()}] ${insight.title}`);
        console.log(`   ${insight.description}`);
        if (insight.affected_tickets) {
          console.log(`   Affected tickets: ${insight.affected_tickets.length}`);
        }
        console.log();
      });

      // Get dashboard data
      console.log('3️⃣  Fetching AI dashboard data...\n');
      const dashboardData = await aiService.getDashboardData(7);

      console.log('📊 Dashboard Summary:');
      console.log(`   Analyzed tickets: ${dashboardData.performance.total_analyzed}`);
      const avgConf = parseFloat(dashboardData.performance.avg_confidence);
      if (!isNaN(avgConf)) {
        console.log(`   Avg confidence: ${avgConf.toFixed(2)}%`);
      }
      const avgTime = parseFloat(dashboardData.performance.avg_processing_time);
      if (!isNaN(avgTime)) {
        console.log(`   Avg processing time: ${avgTime.toFixed(0)}ms`);
      }
      console.log();

      console.log('😊 Sentiment Distribution:');
      Object.entries(dashboardData.sentiment.distribution).forEach(([sentiment, count]) => {
        console.log(`   ${sentiment}: ${count}`);
      });
      console.log();

      console.log('📁 Top Categories:');
      dashboardData.categories.slice(0, 5).forEach(cat => {
        const conf = parseFloat(cat.avg_confidence);
        const confStr = !isNaN(conf) ? ` (${conf.toFixed(1)}% confidence)` : '';
        console.log(`   ${cat.ai_category}: ${cat.count}${confStr}`);
      });
      console.log();

      console.log('🔍 Root Causes:');
      dashboardData.rootCauses.forEach(rc => {
        console.log(`   ${rc.root_cause_type}: ${rc.count}`);
      });

    } finally {
      connection.release();
    }

    console.log('\n✅ AI Analysis Test completed successfully!');

  } catch (error) {
    console.error('❌ Test failed:', error);
    throw error;
  }
}

testAIAnalysis()
  .then(() => {
    console.log('\n✅ Done!');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n❌ Failed:', error.message);
    process.exit(1);
  });
