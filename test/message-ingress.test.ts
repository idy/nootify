import assert from 'node:assert/strict';
import { test } from 'node:test';
import { incomingMessageRejection, normalizeIncomingMessage, selectIncomingMessage } from '../src/message-ingress.js';

const TEXT = '  继续检查 messages <&> 🐧  ';
const event = () => ({ sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } },
  message: { chat_id: 'oc_chat', message_id: 'om_reply', thread_id: 'omt_thread', message_type: 'text', content: JSON.stringify({ text: TEXT }) } });
const history = () => ({ message_id: 'om_reply', chat_id: 'oc_chat', thread_id: 'omt_thread', msg_type: 'text',
  sender: { sender_type: 'user', id_type: 'open_id', id: 'ou_owner' }, body: { content: JSON.stringify({ text: TEXT }) } });
const expected = { chat_id: 'oc_chat', message_id: 'om_reply', thread_id: 'omt_thread', sender_id: 'ou_owner', text: TEXT };

for (const [name, payload] of [['event', event], ['merged history', history], ['event envelope', () => ({ event: event() })]] as const) {
  test(`Feishu ${name} uses the shared policy and preserves original text`, () => {
    const normalized = normalizeIncomingMessage('feishu', payload());
    assert.equal(normalized?.sender_type, 'user'); assert.equal(incomingMessageRejection(normalized), undefined);
    assert.deepEqual(selectIncomingMessage(normalized), expected);
  });
}
test('application authorship survives both Feishu formats even when the sender ID matches the trusted human', () => {
  const live = event(); live.sender.sender_type = 'app';
  const row = history(); row.sender.sender_type = 'app';
  for (const payload of [live, { event: live }, row]) {
    const normalized = normalizeIncomingMessage('feishu', payload);
    assert.equal(normalized?.sender_type, 'bot'); assert.equal(incomingMessageRejection(normalized), 'sender_not_user');
    assert.equal(selectIncomingMessage(normalized), undefined);
  }
});
test('unknown or missing sender types cannot become human input', () => {
  for (const sender_type of [undefined, 'unknown', '', {}, null]) {
    const payload = { ...event(), sender: { sender_type, sender_id: { open_id: 'ou_owner' } } };
    assert.equal(selectIncomingMessage(normalizeIncomingMessage('feishu', payload)), undefined);
  }
});
test('malformed JSON and non-text content are ignored', () => {
  for (const content of ['{broken', 'null', '[]', '{"text":42}', '{"text":"   "}']) {
    const payload = event(); payload.message.content = content;
    assert.equal(selectIncomingMessage(normalizeIncomingMessage('feishu', payload)), undefined);
  }
  const post = event(); post.message.message_type = 'post';
  assert.equal(selectIncomingMessage(normalizeIncomingMessage('feishu', post)), undefined);
});
test('deleted rows and non-open-id history identities remain excluded', () => {
  const deleted = { ...history(), deleted: true };
  const appId = history(); appId.sender.id_type = 'app_id';
  for (const payload of [deleted, appId]) assert.equal(selectIncomingMessage(normalizeIncomingMessage('feishu', payload)), undefined);
});
test('malformed provider input cannot throw or admit commands', () => {
  for (const value of [undefined, null, false, 12, 'text', [], {}, { event: [] }, { message: null }, { sender: {} }]) {
    assert.equal(selectIncomingMessage(normalizeIncomingMessage('feishu', value)), undefined);
  }
});
