import type { firestore } from 'firebase-admin'

import { describe, expect, test } from 'bun:test'
import { CipherStrings } from 'src/crypto/stringify-shuffle'
import { encodeReplacementPayload, generateVoterKeypair, signReplacement } from 'src/crypto/voter-key'

import { MAX_REPLACEMENTS, replaceSubmittedVote, ReplaceVoteDeps, STOPPED_ACCEPTING_VOTES } from './replace-vote'

// ---------------------------------------------------------------------------------------------
// Minimal in-memory Firestore, with optimistic transactions (retry if a read doc changed).
// ---------------------------------------------------------------------------------------------
type Data = Record<string, unknown>

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

class FakeDb {
  docs = new Map<string, { data: Data; version: number }>()
  transactionAttempts = 0

  doc(path: string) {
    return new FakeDocRef(this, path)
  }

  async runTransaction<T>(fn: (tx: FakeTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 10; attempt++) {
      this.transactionAttempts++
      const tx = new FakeTransaction(this)
      const result = await fn(tx)
      await tick()
      const stale = [...tx.readVersions].some(([path, version]) => (this.docs.get(path)?.version ?? 0) !== version)
      if (stale) continue // Contention: retry, like Firestore does
      tx.writes.forEach(([path, data]) => this.write(path, data))
      return result
    }
    throw new Error('Transaction failed after retries')
  }

  write(path: string, data: Data) {
    const current = this.docs.get(path)
    this.docs.set(path, { data: { ...(current?.data || {}), ...data }, version: (current?.version ?? 0) + 1 })
  }
}

class FakeDocRef {
  firestore: FakeDb
  id: string
  parent: { id: string }
  constructor(public db: FakeDb, public path: string) {
    this.firestore = db
    this.id = path.split('/').at(-1) as string
    this.parent = { id: path.split('/').at(-2) as string }
  }
  collection(name: string) {
    return new FakeQuery(this.db, `${this.path}/${name}`)
  }
  async get() {
    await tick()
    return snapshot(this, this.db.docs.get(this.path)?.data)
  }
  async update(data: Data) {
    await tick()
    this.db.write(this.path, data)
  }
}

class FakeQuery {
  constructor(public db: FakeDb, public path: string, public filters: [string, unknown][] = []) {}
  doc(id: string) {
    return new FakeDocRef(this.db, `${this.path}/${id}`)
  }
  async get() {
    await tick()
    const docs = [...this.db.docs.entries()]
      .filter(([path]) => path.startsWith(`${this.path}/`) && !path.slice(this.path.length + 1).includes('/'))
      .filter(([, { data }]) => this.filters.every(([field, value]) => data[field] === value))
      .map(([path, { data }]) => snapshot(new FakeDocRef(this.db, path), data))
    return { docs, empty: !docs.length }
  }
  limit() {
    return this
  }
  where(field: string, _op: '==', value: unknown) {
    return new FakeQuery(this.db, this.path, [...this.filters, [field, value]])
  }
}

class FakeTransaction {
  readVersions = new Map<string, number>()
  writes: [string, Data][] = []
  constructor(public db: FakeDb) {}
  async get(ref: FakeDocRef) {
    await tick()
    const entry = this.db.docs.get(ref.path)
    this.readVersions.set(ref.path, entry?.version ?? 0)
    return snapshot(ref, entry && { ...entry.data })
  }
  update(ref: FakeDocRef, data: Data) {
    this.writes.push([ref.path, data])
  }
}

const snapshot = (ref: FakeDocRef, data?: Data) => ({ data: () => data, exists: !!data, id: ref.id, ref })

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------
const election_id = 'test-election'
const auth = 'a1b2c3d4e5'
const ballot = (n: number): Record<string, CipherStrings> => ({
  mayor: { encrypted: `enc_${n}`, lock: `lock_${n}` },
  prop: { encrypted: `penc_${n}`, lock: `plock_${n}` },
})

async function setup({ pending = false, voterPubkeyField = 'voter_pubkey' } = {}) {
  const db = new FakeDb()
  const keys = await generateVoterKeypair()
  const invalidations: { encrypted_vote: unknown; pending: boolean; vote_doc_id: string }[] = []

  db.write(`elections/${election_id}`, { num_pending_votes: pending ? 1 : 0, num_votes: 1 })
  const created_at = { toMillis: () => 1 }
  if (pending) {
    db.write(`elections/${election_id}/votes-pending/${auth}`, {
      created_at,
      encrypted_vote: ballot(0),
      link_auth: auth,
      [voterPubkeyField]: keys.voter_pubkey,
    })
  } else {
    db.write(`elections/${election_id}/votes/${auth}`, {
      auth,
      created_at,
      encrypted_vote: ballot(0),
      [voterPubkeyField]: keys.voter_pubkey,
    })
  }

  const deps: ReplaceVoteDeps = {
    getElectionDoc: (id) => db.doc(`elections/${id}`) as unknown as firestore.DocumentReference,
    invalidateCachedVote: async (_electionDoc, { encrypted_vote, pending, vote_doc_id }) => {
      invalidations.push({ encrypted_vote, pending, vote_doc_id })
    },
  }

  const votePath = `elections/${election_id}/${pending ? 'votes-pending' : 'votes'}/${auth}`
  const getVote = () => db.docs.get(votePath)?.data as Data & { previous_submissions?: Data[] }

  const replace = async (
    encrypted_vote: Record<string, CipherStrings>,
    { privkey = keys.voter_privkey, reason = 'selections' as null | string, sendAuth = auth } = {},
    extraDeps: Partial<ReplaceVoteDeps> = {},
  ) => {
    const message = encodeReplacementPayload({ auth: sendAuth, election_id, encrypted_vote })
    const signature = await signReplacement(privkey, message)
    return replaceSubmittedVote(
      { auth: sendAuth, election_id, encrypted_vote, signature, ...(reason && { reason }) },
      { ...deps, ...extraDeps },
    )
  }

  const getElection = () => db.docs.get(`elections/${election_id}`)?.data as Data

  return { db, getElection, getVote, invalidations, keys, replace }
}

// ---------------------------------------------------------------------------------------------
describe('replaceSubmittedVote', () => {
  test('valid replacement updates the existing vote in place, without adding a vote', async () => {
    const { db, getElection, getVote, invalidations, keys, replace } = await setup()

    const result = await replace(ballot(1))
    expect(result.status).toBe(200)

    const vote = getVote()
    expect(vote.encrypted_vote).toEqual(ballot(1))
    expect(vote.auth).toBe(auth)
    expect(vote.voter_pubkey).toBe(keys.voter_pubkey)
    expect(vote.created_at).toBeTruthy()
    expect(vote.last_replaced_at).toBeInstanceOf(Date)
    expect(vote.previous_submissions).toHaveLength(1)
    expect(vote.previous_submissions?.[0]).toMatchObject({
      encrypted_vote: ballot(0),
      replacement_reason: 'selections',
    })
    expect(vote).not.toHaveProperty('strengthened_at') // selection changes aren't "strengthening"

    // Still exactly one vote doc, and num_votes untouched
    expect([...db.docs.keys()].filter((p) => p.includes('/votes/'))).toHaveLength(1)
    expect(getElection().num_votes).toBe(1)

    // Cache told about the new ciphertext
    expect(invalidations).toEqual([{ encrypted_vote: ballot(1), pending: false, vote_doc_id: auth }])
  })

  test('multiple replacements A -> B -> C keep ordered history and only C is current', async () => {
    let t = 0
    const now = () => new Date(Date.UTC(2026, 10, 1, 0, 0, t++))
    const { getElection, getVote, replace } = await setup()

    expect((await replace(ballot(1), {}, { now })).status).toBe(200)
    expect((await replace(ballot(2), {}, { now })).status).toBe(200)

    const vote = getVote()
    expect(vote.encrypted_vote).toEqual(ballot(2))
    const history = vote.previous_submissions || []
    expect(history.map((h) => h.encrypted_vote)).toEqual([ballot(0), ballot(1)])
    expect((history[0].replaced_at as Date) < (history[1].replaced_at as Date)).toBe(true)
    expect(history[1].last_replaced_at).toEqual(history[0].replaced_at)
    expect(getElection().num_votes).toBe(1)
  })

  test('invalid signature (signed a different ballot than sent) is rejected with 401', async () => {
    const { db, getVote, invalidations, keys } = await setup()
    const signedFor = encodeReplacementPayload({ auth, election_id, encrypted_vote: ballot(1) })
    const signature = await signReplacement(keys.voter_privkey, signedFor)

    const result = await replaceSubmittedVote(
      { auth, election_id, encrypted_vote: ballot(2), reason: 'selections', signature },
      {
        getElectionDoc: (id) => db.doc(`elections/${id}`) as unknown as firestore.DocumentReference,
        invalidateCachedVote: async () => undefined,
      },
    )
    expect(result.status).toBe(401)
    expect(getVote().encrypted_vote).toEqual(ballot(0))
    expect(getVote().previous_submissions).toBeUndefined()
    expect(invalidations).toHaveLength(0)
  })

  test('wrong device key is rejected with 401 and the vote is unchanged', async () => {
    const { getVote, invalidations, replace } = await setup()
    const otherDevice = await generateVoterKeypair()

    const result = await replace(ballot(1), { privkey: otherDevice.voter_privkey })
    expect(result.status).toBe(401)
    expect(getVote().encrypted_vote).toEqual(ballot(0))
    expect(getVote().previous_submissions).toBeUndefined()
    expect(invalidations).toHaveLength(0)
  })

  test('knowing the auth token alone is not enough (malformed / missing signature)', async () => {
    const { db, getVote } = await setup()
    const deps: ReplaceVoteDeps = {
      getElectionDoc: (id) => db.doc(`elections/${id}`) as unknown as firestore.DocumentReference,
      invalidateCachedVote: async () => undefined,
    }

    const noSig = await replaceSubmittedVote({ auth, election_id, encrypted_vote: ballot(1) }, deps)
    expect(noSig.status).toBe(400)

    const zeroSig = await replaceSubmittedVote(
      { auth, election_id, encrypted_vote: ballot(1), signature: '0'.repeat(128) },
      deps,
    )
    expect(zeroSig.status).toBe(401)
    expect(getVote().encrypted_vote).toEqual(ballot(0))
  })

  test('closed election rejects a valid signed replacement', async () => {
    const { db, getVote, replace } = await setup()
    db.write(`elections/${election_id}`, { stop_accepting_votes: true })

    const result = await replace(ballot(1))
    expect(result.status).toBe(400)
    expect(result.body).toEqual({ election_closed: true, error: STOPPED_ACCEPTING_VOTES })
    expect(getVote().encrypted_vote).toEqual(ballot(0))
  })

  test('election closing between the first check and the transaction still rejects', async () => {
    const { db, getVote, keys } = await setup()
    const electionPath = `elections/${election_id}`

    // Close the election right after the pre-transaction election read
    const deps: ReplaceVoteDeps = {
      getElectionDoc: (id) => {
        const ref = db.doc(`elections/${id}`)
        const originalGet = ref.get.bind(ref)
        ref.get = async () => {
          const snap = await originalGet()
          db.write(electionPath, { stop_accepting_votes: true })
          return snap
        }
        return ref as unknown as firestore.DocumentReference
      },
      invalidateCachedVote: async () => undefined,
    }
    const signature = await signReplacement(
      keys.voter_privkey,
      encodeReplacementPayload({ auth, election_id, encrypted_vote: ballot(1) }),
    )
    const result = await replaceSubmittedVote({ auth, election_id, encrypted_vote: ballot(1), signature }, deps)
    expect(result.status).toBe(400)
    expect(getVote().encrypted_vote).toEqual(ballot(0))
  })

  test('vote without a voter_pubkey can never be replaced', async () => {
    const { db, getVote, replace } = await setup()
    const path = `elections/${election_id}/votes/${auth}`
    const data = { ...db.docs.get(path)?.data }
    delete data.voter_pubkey
    db.docs.set(path, { data, version: 99 })

    const result = await replace(ballot(1))
    expect(result.status).toBe(400)
    expect(getVote().encrypted_vote).toEqual(ballot(0))
  })

  test('legacy replacement_pubkey is still honored during the migration window', async () => {
    const { getVote, replace } = await setup({ voterPubkeyField: 'replacement_pubkey' })
    expect((await replace(ballot(1))).status).toBe(200)
    expect(getVote().encrypted_vote).toEqual(ballot(1))
  })

  test('replaying an earlier signed replacement is rejected', async () => {
    const { getVote, replace } = await setup()
    expect((await replace(ballot(1))).status).toBe(200)
    expect((await replace(ballot(2))).status).toBe(200)

    // Re-sending ballot(1) (e.g. a captured earlier request) must not roll the vote back
    const replay = await replace(ballot(1))
    expect(replay.status).toBe(409)
    expect(getVote().encrypted_vote).toEqual(ballot(2))
  })

  test('re-sending the current ciphertext is an idempotent no-op', async () => {
    const { getVote, invalidations, replace } = await setup()
    expect((await replace(ballot(1))).status).toBe(200)
    const again = await replace(ballot(1))
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ success: true, unchanged: true })
    expect(getVote().previous_submissions).toHaveLength(1)
    expect(invalidations).toHaveLength(1)
  })

  test('replacement must keep every existing ballot column', async () => {
    const { getVote, replace } = await setup()
    const result = await replace({ mayor: ballot(1).mayor })
    expect(result.status).toBe(400)
    expect(getVote().encrypted_vote).toEqual(ballot(0))
  })

  test('caps the number of replacements per vote', async () => {
    const { db, getVote, replace } = await setup()
    const path = `elections/${election_id}/votes/${auth}`
    const history = Array.from({ length: MAX_REPLACEMENTS }, (_, i) => ({ encrypted_vote: ballot(1000 + i) }))
    db.write(path, { previous_submissions: history })

    const result = await replace(ballot(1))
    expect(result.status).toBe(429)
    expect(getVote().encrypted_vote).toEqual(ballot(0))
  })

  test('concurrent replacements keep a coherent history (no lost versions)', async () => {
    const { db, getElection, getVote, replace } = await setup()

    const [r1, r2] = await Promise.all([replace(ballot(1)), replace(ballot(2))])
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    expect(db.transactionAttempts).toBeGreaterThan(2) // contention forced at least one retry

    const vote = getVote()
    const history = (vote.previous_submissions || []).map((h) => h.encrypted_vote)
    // Original first, then whichever replacement committed first; the other is current
    expect(history).toHaveLength(2)
    expect(history[0]).toEqual(ballot(0))
    const all = [history[1], vote.encrypted_vote]
    expect(all).toContainEqual(ballot(1))
    expect(all).toContainEqual(ballot(2))
    expect(getElection().num_votes).toBe(1)
  })

  test('pending link-auth vote is replaced in votes-pending, addressed by its link_auth', async () => {
    const { db, getVote, invalidations, replace } = await setup({ pending: true })

    // Using the literal 'link' must not find anything
    const literal = await replace(ballot(1), { sendAuth: 'link' })
    expect(literal.status).toBe(404)

    const result = await replace(ballot(1))
    expect(result.status).toBe(200)
    expect(getVote().encrypted_vote).toEqual(ballot(1))
    expect([...db.docs.keys()].filter((p) => p.includes('/votes'))).toHaveLength(1)
    expect(invalidations).toEqual([{ encrypted_vote: ballot(1), pending: true, vote_doc_id: auth }])
  })

  test('legacy /strengthened-vote callers (no reason) are recorded as verification-number changes', async () => {
    const { getVote, replace } = await setup()
    const result = await replace(ballot(1), { reason: null }, { defaultReason: 'verification-number' })
    expect(result.status).toBe(200)
    expect(getVote().strengthened_at).toBeInstanceOf(Date)
    expect(getVote().previous_submissions?.[0].replacement_reason).toBe('verification-number')
  })

  test('unknown reason values are rejected', async () => {
    const { getVote, replace } = await setup()
    expect((await replace(ballot(1), { reason: 'sneaky' })).status).toBe(400)
    expect(getVote().encrypted_vote).toEqual(ballot(0))
  })

  test('a cache failure after commit still reports success, and calls onCacheError', async () => {
    const { getVote, replace } = await setup()
    const errors: unknown[] = []
    const result = await replace(
      ballot(1),
      {},
      {
        invalidateCachedVote: async () => {
          throw new Error('lease exploded')
        },
        onCacheError: (_doc, error) => errors.push(error),
      },
    )
    expect(result.status).toBe(200)
    expect(getVote().encrypted_vote).toEqual(ballot(1))
    expect(errors).toHaveLength(1)
  })

  test('rejects malformed encrypted_vote shapes', async () => {
    const { db } = await setup()
    const deps: ReplaceVoteDeps = {
      getElectionDoc: (id) => db.doc(`elections/${id}`) as unknown as firestore.DocumentReference,
      invalidateCachedVote: async () => undefined,
    }
    for (const encrypted_vote of [{}, [], 'x', { mayor: 'x' }, { mayor: { encrypted: 1, lock: 'l' } }]) {
      const result = await replaceSubmittedVote({ auth, election_id, encrypted_vote, signature: 'a'.repeat(128) }, deps)
      expect(result.status).toBe(400)
    }
  })
})
