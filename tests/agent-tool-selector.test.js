'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  inferredDomains,
  lexicalToolNames,
  selectAriTools,
} = require('../src/services/agent-tool-selector.service');
const { listTools } = require('../src/mcp/desktop-tool-registry');

function names(tools) {
  return tools.map((tool) => tool.name);
}

test('typo-tolerant natural reminder wording keeps set_reminder visible', async () => {
  const selected = await selectAriTools('remnd me abt d visa docs kal', {
    allTools: listTools(),
    skipSemantic: true,
  });

  assert.ok(names(selected).includes('set_reminder'));
  assert.ok(names(selected).includes('request_clarification'));
  assert.ok(selected.length <= 24);
});

test('Hinglish meeting phrasing selects calendar creation without requiring command syntax', async () => {
  const selected = await selectAriTools('kal 4 baje Rahul ke saath meeting rakh do', {
    allTools: listTools(),
    skipSemantic: true,
  });

  assert.ok(names(selected).includes('create_calendar_event'));
  assert.ok(inferredDomains('kal 4 baje Rahul ke saath meeting rakh do').includes('calendar'));
});

test('active workflow context wins for a short confirmation follow-up', async () => {
  const selected = await selectAriTools('yes, do it', {
    allTools: listTools(),
    skipSemantic: true,
    recentMessages: [
      { role: 'user', content: 'Email Priya the updated launch plan' },
      { role: 'assistant', content: 'The email draft is ready for approval.' },
    ],
    contextHints: { activeEmailDraftConfirmation: true },
  });

  assert.equal(names(selected)[0], 'handle_email_confirmation');
});

test('compound natural request keeps tools from every detected domain', async () => {
  const selected = await selectAriTools(
    'Move the Acme deal to won and remind me tomorrow to send the handoff',
    { allTools: listTools(), skipSemantic: true },
  );
  const selectedNames = names(selected);

  assert.ok(selectedNames.includes('manage_sales'));
  assert.ok(selectedNames.includes('set_reminder'));
});

test('lexical ranking tolerates a misspelling instead of requiring exact tokens', () => {
  const ranked = lexicalToolNames('remnd me tomorrow', listTools());
  assert.ok(ranked.slice(0, 8).includes('set_reminder'));
});

test('casual conversation does not surface an outbound email action by default', async () => {
  const selected = await selectAriTools('hey, how are you?', {
    allTools: listTools(),
    skipSemantic: true,
  });

  assert.equal(names(selected).includes('send_email'), false);
  assert.ok(names(selected).includes('request_clarification'));
});

test('current-turn typo matches rank ahead of stale multi-domain history', async () => {
  const recentMessages = [{
    role: 'user',
    content: 'Email Priya, check the sales pipeline, calendar, team tasks, reminders, and notes.',
  }];
  const cases = [
    ['translat this to french', 'translate_text'],
    ['log an expnse of 500', 'manage_expenses'],
    ['start a focs session', 'focus_mode'],
  ];

  for (const [message, expectedTool] of cases) {
    const selectedNames = names(await selectAriTools(message, {
      allTools: listTools(),
      skipSemantic: true,
      recentMessages,
    }));

    assert.ok(selectedNames.includes(expectedTool), `${expectedTool} should remain visible for "${message}"`);
    assert.ok(
      selectedNames.indexOf(expectedTool) < selectedNames.indexOf('manage_sales'),
      `${expectedTool} should rank ahead of a tool inferred only from stale history`,
    );
  }
});

test('one compound turn retains a representative tool for every requested domain within the cap', async () => {
  const selectedNames = names(await selectAriTools(
    'Move the Acme deal to won, email Priya, book a meeting tomorrow, remind me to follow up, add a task, and save a note about the handoff',
    { allTools: listTools(), skipSemantic: true },
  ));

  for (const expectedTool of [
    'manage_sales',
    'send_email',
    'create_calendar_event',
    'set_reminder',
    'manage_tasks',
    'manage_notes',
  ]) {
    assert.ok(selectedNames.includes(expectedTool), `${expectedTool} should remain visible`);
  }
  assert.ok(selectedNames.length <= 24);
});

test('non-Latin fallback exposes core reminder, calendar, and email actions', async () => {
  const selectedNames = names(await selectAriTools('मुझे कल सुबह याद दिलाना', {
    allTools: listTools(),
    skipSemantic: true,
  }));

  assert.ok(selectedNames.includes('set_reminder'));
  assert.ok(selectedNames.includes('create_calendar_event'));
  assert.ok(selectedNames.includes('send_email'));
  assert.ok(selectedNames.includes('request_clarification'));
});

test('script-aware hints retain specialized tools without an embedding provider', async () => {
  const cases = [
    ['मैं अगले सोमवार छुट्टी लेना चाहता हूँ', 'manage_leave'],
    ['ترجم هذه الجملة إلى الإنجليزية', 'translate_text'],
    ['Recuerda que mi color favorito es verde', 'save_memory'],
    ['¿Qué recuerdas de mí?', 'recall_memory'],
    ['Email all these customers about the launch', 'bulk_email'],
  ];

  for (const [message, expected] of cases) {
    const selectedNames = names(await selectAriTools(message, {
      allTools: listTools(),
      skipSemantic: true,
    }));
    assert.ok(selectedNames.includes(expected), `${expected} should be visible for ${message}`);
  }
});

test('every registered tool is reachable from a readable natural invocation', async () => {
  for (const tool of listTools()) {
    const spokenName = tool.name.replaceAll('_', ' ');
    const selectedNames = names(await selectAriTools(`Please help me ${spokenName}`, {
      allTools: listTools(),
      skipSemantic: true,
    }));
    assert.ok(selectedNames.includes(tool.name), `${tool.name} should be reachable`);
  }
});
