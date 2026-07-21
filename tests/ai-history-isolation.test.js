'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
}

test('sessionless AI history never reads, deduplicates against, or deletes dashboard rows', async () => {
  const phone = 'history-isolation-user';
  const dashboardSession = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const baseTime = Date.now() - 5_000;
  let nextId = 10;
  let rows = [
    {
      id: 1,
      user_phone: phone,
      role: 'user',
      content: 'same text in dashboard',
      session_id: dashboardSession,
      created_at: new Date(baseTime + 1_000),
    },
    {
      id: 2,
      user_phone: phone,
      role: 'assistant',
      content: 'WhatsApp-only context',
      session_id: null,
      created_at: new Date(baseTime + 2_000),
    },
    {
      id: 3,
      user_phone: phone,
      role: 'assistant',
      content: 'Secret dashboard context',
      session_id: dashboardSession,
      created_at: new Date(baseTime + 3_000),
    },
  ];
  const statements = [];

  const fakeQuery = async (sql, params = []) => {
    const normalized = normalizeSql(sql);
    statements.push({ sql: String(sql), normalized, params: [...params] });

    if (normalized.startsWith('insert into conversation_history')) {
      const [userPhone, role, content] = params;
      const isSessionless = normalized.includes('session_id is null');
      const duplicate = rows.some((row) =>
        row.user_phone === userPhone
        && row.role === role
        && row.content === content
        && (!isSessionless || row.session_id == null));

      if (duplicate) return { rows: [], rowCount: 0 };

      const inserted = {
        id: nextId++,
        user_phone: userPhone,
        role,
        content,
        session_id: null,
        created_at: new Date(),
      };
      rows.push(inserted);
      return { rows: [{ id: inserted.id }], rowCount: 1 };
    }

    if (normalized.startsWith('select') && normalized.includes('from conversation_history')) {
      let selected = rows.filter((row) => row.user_phone === params[0]);
      if (normalized.includes('session_id is null')) {
        selected = selected.filter((row) => row.session_id == null);
      } else if (normalized.includes('session_id = $2::uuid')) {
        selected = selected.filter((row) => row.session_id === params[1]);
      }

      selected.sort((left, right) => right.created_at - left.created_at);
      let limit = 100;
      if (normalized.includes('limit $2')) limit = params[1];
      if (normalized.includes('limit $3')) limit = params[2];
      selected = selected.slice(0, limit);
      if (normalized.includes(') recent order by created_at asc')) selected.reverse();

      return {
        rows: selected.map(({ role, content, created_at }) => ({ role, content, created_at })),
        rowCount: selected.length,
      };
    }

    if (normalized.startsWith('delete from conversation_history')) {
      const isSessionless = normalized.includes('session_id is null');
      if (normalized.includes('id not in')) {
        const limit = params.at(-1);
        const candidates = rows
          .filter((row) => row.user_phone === params[0] && (!isSessionless || row.session_id == null))
          .sort((left, right) => right.created_at - left.created_at);
        const keepIds = new Set(candidates.slice(0, limit).map((row) => row.id));
        const before = rows.length;
        rows = rows.filter((row) => {
          const inDeleteScope = row.user_phone === params[0]
            && (!isSessionless || row.session_id == null);
          return !inDeleteScope || keepIds.has(row.id);
        });
        return { rows: [], rowCount: before - rows.length };
      }

      const before = rows.length;
      rows = rows.filter((row) => {
        if (row.user_phone !== params[0]) return true;
        return isSessionless && row.session_id != null;
      });
      return { rows: [], rowCount: before - rows.length };
    }

    return { rows: [], rowCount: 0 };
  };

  const databasePath = require.resolve('../src/config/database');
  const aiServicePath = require.resolve('../src/services/ai.service');
  const originalDatabaseModule = require.cache[databasePath];
  const originalAiServiceModule = require.cache[aiServicePath];
  const originalRandom = Math.random;

  require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: { query: fakeQuery },
  };
  delete require.cache[aiServicePath];
  Math.random = () => 1;

  let aiService;
  try {
    aiService = require('../src/services/ai.service');
    aiService.historyCache.clear();
    aiService.summaryCache.clear();
    aiService.maxStoredMessages = 1;

    // A matching dashboard message must not suppress a new WhatsApp row.
    await aiService.saveMessage(phone, 'user', 'same text in dashboard');
    assert.equal(
      rows.filter((row) => row.session_id == null && row.content === 'same text in dashboard').length,
      1,
    );

    const history = await aiService.getHistory(phone);
    assert.deepEqual(
      history.map(({ role, content }) => ({ role, content })),
      [
        { role: 'assistant', content: 'WhatsApp-only context' },
        { role: 'user', content: 'same text in dashboard' },
      ],
    );

    const recent = await aiService.getRecentContext(phone, 10, { maxAgeMinutes: 60 });
    assert.deepEqual(
      recent.map(({ role, content }) => ({ role, content })),
      [
        { role: 'assistant', content: 'WhatsApp-only context' },
        { role: 'user', content: 'same text in dashboard' },
      ],
    );

    await aiService.cleanupUserHistory(phone);
    assert.equal(rows.filter((row) => row.session_id === dashboardSession).length, 2);
    assert.equal(rows.filter((row) => row.session_id == null).length, 1);

    await aiService.clearHistory(phone, { deferAgentState: true });
    assert.equal(rows.filter((row) => row.session_id == null).length, 0);
    assert.equal(rows.filter((row) => row.session_id === dashboardSession).length, 2);

    // Summary commands are context readers too. Dashboard-only rows must look
    // empty from WhatsApp instead of being sent to the model for summarizing.
    assert.equal(await aiService.summarizeRecentMessages(phone), 'No messages to summarize.');
    assert.equal(await aiService.summarizeByTimeframe(phone, 'today'), 'No messages found for today.');

    const historyStatements = statements.filter(({ normalized }) =>
      normalized.includes('from conversation_history'));
    for (const statement of historyStatements) {
      assert.match(statement.normalized, /session_id is null/);
    }

    const cleanup = statements.find(({ normalized }) =>
      normalized.startsWith('delete from conversation_history') && normalized.includes('id not in'));
    assert.ok(cleanup);
    assert.equal((cleanup.normalized.match(/session_id is null/g) || []).length, 2);

    const clear = statements.find(({ normalized }) =>
      normalized === 'delete from conversation_history where user_phone = $1 and session_id is null');
    assert.ok(clear);
  } finally {
    Math.random = originalRandom;
    if (aiService?._pruneStartup) clearTimeout(aiService._pruneStartup);
    aiService?.historyCache?.destroy();
    aiService?.summaryCache?.destroy();
    delete require.cache[aiServicePath];
    if (originalAiServiceModule) require.cache[aiServicePath] = originalAiServiceModule;
    if (originalDatabaseModule) require.cache[databasePath] = originalDatabaseModule;
    else delete require.cache[databasePath];
  }
});
