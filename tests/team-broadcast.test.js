const test = require('node:test');
const assert = require('node:assert/strict');

const teamComms = require('../src/services/team-comms.service');
const messaging = require('../src/services/messaging.service');

test('team broadcast reports partial failures and deduplicates recipients', async () => {
  const originals = {
    create: teamComms.createTeamMessage,
    wamid: teamComms.updateRecipientWamid,
    sent: teamComms.markRecipientSent,
    failed: teamComms.markRecipientFailed,
    send: messaging.send,
  };
  const statuses = [];
  try {
    teamComms.createTeamMessage = async (_admin, _team, _text, _type, members) => {
      assert.equal(members.length, 2);
      return { id: 42 };
    };
    teamComms.updateRecipientWamid = async (_id, phone) => statuses.push([phone, 'sent']);
    teamComms.markRecipientSent = async (_id, phone) => statuses.push([phone, 'sent']);
    teamComms.markRecipientFailed = async (_id, phone) => statuses.push([phone, 'failed']);
    messaging.send = async (phone) => {
      if (phone === '919222222222') throw new Error('upstream secret detail');
      return 'wamid-1';
    };

    const result = await teamComms.sendBroadcast({
      adminPhone: '919000000000',
      teamName: 'core',
      messageText: 'Daily update',
      members: [
        { member_phone: '+91 91111 11111', member_name: 'A' },
        { member_phone: '919111111111', member_name: 'A duplicate' },
        { member_phone: '919222222222', member_name: 'B' },
      ],
    });

    assert.deepEqual(result, {
      ok: true,
      team_message_id: 42,
      total: 2,
      sent: 1,
      failed: 1,
      failed_recipients: [{ name: 'B', phone: '919222222222' }],
    });
    assert.deepEqual(statuses, [
      ['919111111111', 'sent'],
      ['919222222222', 'failed'],
    ]);
    assert.equal(JSON.stringify(result).includes('secret detail'), false);
  } finally {
    teamComms.createTeamMessage = originals.create;
    teamComms.updateRecipientWamid = originals.wamid;
    teamComms.markRecipientSent = originals.sent;
    teamComms.markRecipientFailed = originals.failed;
    messaging.send = originals.send;
  }
});
