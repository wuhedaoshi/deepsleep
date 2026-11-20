import assert from 'node:assert/strict'
import 'fake-indexeddb/auto'
import { revealMessage, getVisibleMessages } from '../src/services/chat/branches.ts'
import { saveSession } from '../src/services/chat/db.ts'
import { searchConversations } from '../src/services/chat/search.ts'
const user = (id, parentId, selectedChildId, content) => ({
  id,
  parentId,
  selectedChildId,
  role: 'user',
  content,
  files: [],
  createdAt: 1,
})
const session = {
  id: 'dialog',
  title: 'Needle in title',
  createdAt: 1,
  updatedAt: 2,
  rootMessageId: 'root',
  messages: [
    user('root', null, 'active', 'root'),
    user('active', 'root', undefined, 'First Needle'),
    user('other', 'root', 'deep', 'alternate'),
    {
      id: 'deep',
      parentId: 'other',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Second NEEDLE' }],
      createdAt: 1,
      status: 'done',
    },
  ],
}
await saveSession(session)
const hits = await searchConversations('needle')
assert.deepEqual(
  hits.map((hit) => hit.messageId),
  [undefined, 'active', 'deep']
)
assert.match(hits[2].snippet, /NEEDLE/)
assert.deepEqual(
  getVisibleMessages(revealMessage(session, 'deep')).map((m) => m.id),
  ['root', 'other', 'deep']
)
assert.equal(revealMessage(session, 'absent'), session)
assert.equal(revealMessage(session, 'active'), session)
await saveSession({
  ...session,
  updatedAt: 3,
  messages: [...session.messages, user('new', null, undefined, 'Third needle')],
})
assert.ok((await searchConversations('needle')).some((hit) => hit.messageId === 'new'))
console.log('Title, multiple messages, hidden branch and refreshed index passed')
