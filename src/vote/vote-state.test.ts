import { describe, expect, test } from 'bun:test'
import { pointToString, RP } from 'src/crypto/curve'
import { decrypt } from 'src/crypto/decrypt'
import { generate_key_pair } from 'src/crypto/generate-key-pair'

import { createVoteDraft, isVerificationNumberChange, prepareVoteReplacement, reducer, State } from './vote-state'

const { decryption_key, public_key } = generate_key_pair()
const pub = public_key.toHex()

const blank = (): State => ({ encoded: {}, encrypted: {}, plaintext: {}, randomizer: {} })

function decryptSelection(state: State, key: string) {
  const cipher = state.encrypted[key]
  return pointToString(
    decrypt(decryption_key, { encrypted: RP.fromHex(cipher.encrypted), lock: RP.fromHex(cipher.lock) }),
  )
}

describe('vote-state reducer', () => {
  test('encrypts selections as tracking:value and generates a tracking number', () => {
    const state = reducer({ ...blank(), public_key: pub }, { mayor: 'Alice' })

    expect(state.tracking).toMatch(/^\d{4}-\d{4}-\d{4}$/)
    expect(state.plaintext.mayor).toBe('Alice')
    expect(decryptSelection(state, 'mayor')).toBe(`${state.tracking}:Alice`)
    expect(state.encoded.mayor).toBeTruthy()
    expect(state.randomizer.mayor).toBeTruthy()
  })

  test('customizing tracking re-encrypts under the new number without changing selections', () => {
    const voted = reducer({ ...blank(), public_key: pub, tracking: '1111-1111-1111' }, { mayor: 'Alice' })
    const customized = reducer(voted, { tracking: '1111-1111-2345' })

    expect(customized.tracking).toBe('1111-1111-2345')
    expect(customized.plaintext.mayor).toBe('Alice')
    expect(customized.previous_submissions).toHaveLength(1)
    expect(decryptSelection(customized, 'mayor')).toBe('1111-1111-2345:Alice')
    expect(customized.encrypted.mayor).not.toEqual(voted.encrypted.mayor)
  })

  test('customizing archives prior crypto in previous_submissions', () => {
    const firstVerif = '1111-1111-1111'
    const first = reducer({ ...blank(), public_key: pub, tracking: firstVerif }, { mayor: 'Alice' })

    const secondVerif = '1111-1111-2345'
    const second = reducer(first, { tracking: secondVerif })

    expect(second.previous_submissions).toHaveLength(1)
    const [archived] = second.previous_submissions || []
    expect(archived).toMatchObject({
      encoded: first.encoded,
      encrypted: first.encrypted,
      plaintext: first.plaintext,
      randomizer: first.randomizer,
      tracking: firstVerif,
    })
    expect(archived.replaced_at).toBeTruthy()
    expect(archived).not.toHaveProperty('public_key')
    expect(archived).not.toHaveProperty('previous_submissions')
    expect(second.randomizer.mayor).not.toBe(first.randomizer.mayor)

    // Third strengthen stacks; first archive stays intact
    const third = reducer(second, { tracking: '1111-1111-9999' })
    expect(third.previous_submissions).toHaveLength(2)
    const [orig, next] = third.previous_submissions || []
    expect(orig).toEqual(archived)
    expect(next).toMatchObject({
      encrypted: second.encrypted,
      randomizer: second.randomizer,
      tracking: secondVerif,
    })
    expect(next.replaced_at).toBeTruthy()
  })

  test('tracking customize is a no-op without plaintext or public key', () => {
    expect(reducer({ ...blank(), public_key: pub }, { tracking: '1111-1111-2345' })).toEqual({
      ...blank(),
      public_key: pub,
    })
    expect(reducer({ ...blank(), plaintext: { mayor: 'Alice' } }, { tracking: '1111-1111-2345' })).toEqual({
      ...blank(),
      plaintext: { mayor: 'Alice' },
    })
  })

  test('same tracking does not take the customize path', () => {
    const voted = reducer({ ...blank(), public_key: pub, tracking: '1111-1111-1111' }, { mayor: 'Alice' })
    const again = reducer(voted, { tracking: '1111-1111-1111' })
    expect(again.previous_submissions).toBeUndefined()
    expect(decryptSelection(again, 'mayor')).toBe('1111-1111-1111:Alice')
  })

  test('clearing a selection removes its encrypted fields', () => {
    const voted = reducer({ ...blank(), public_key: pub, tracking: '1111-1111-1111' }, { mayor: 'Alice' })
    const cleared = reducer(voted, { mayor: '' })

    expect(cleared.plaintext.mayor).toBeUndefined()
    expect(cleared.encrypted.mayor).toBeUndefined()
    expect(cleared.encoded.mayor).toBeUndefined()
    expect(cleared.randomizer.mayor).toBeUndefined()
  })

  test('submitted_at updates without touching encryption', () => {
    const voted = reducer({ ...blank(), public_key: pub, tracking: '1111-1111-1111' }, { mayor: 'Alice' })
    const submitted = reducer(voted, { submitted_at: '2026-01-01' })

    expect(String(submitted.submitted_at)).toBe('2026-01-01')
    expect(submitted.encrypted).toEqual(voted.encrypted)
  })

  test('voter keypair can be stored without re-encrypting', () => {
    const voted = reducer({ ...blank(), public_key: pub, tracking: '1111-1111-1111' }, { mayor: 'Alice' })
    const withKeys = reducer(voted, {
      voter_privkey: 'a'.repeat(64),
      voter_pubkey: 'b'.repeat(64),
    })

    expect(withKeys.voter_privkey).toBe('a'.repeat(64))
    expect(withKeys.voter_pubkey).toBe('b'.repeat(64))
    expect(withKeys.encrypted).toEqual(voted.encrypted)
  })

  test('customizing re-encrypts every contest under the new tracking', () => {
    let state = reducer({ ...blank(), public_key: pub, tracking: '1111-1111-1111' }, { mayor: 'Alice' }) // 1st contest
    state = reducer(state, { prop: 'Yes' }) // add 2nd contest
    const customized = reducer(state, { tracking: '1111-1111-2345' }) // customize tracking

    // Both contests should be there, with updated tracking
    expect(customized.plaintext).toEqual({ mayor: 'Alice', prop: 'Yes' })
    expect(decryptSelection(customized, 'mayor')).toBe('1111-1111-2345:Alice')
    expect(decryptSelection(customized, 'prop')).toBe('1111-1111-2345:Yes')
  })

  test('customizing archives submitted_at on the prior snapshot', () => {
    const voted = reducer({ ...blank(), public_key: pub, tracking: '1111-1111-1111' }, { mayor: 'Alice' }) // test selection
    const submitted = reducer(voted, { submitted_at: '2026-01-01' }) // "submit vote"
    const customized = reducer(submitted, { tracking: '1111-1111-2345' }) // customize tracking

    // Expect the prior snapshot to be archived, with the submitted_at timestamp
    expect(customized.previous_submissions?.[0]).toMatchObject({
      submitted_at: '2026-01-01',
      tracking: '1111-1111-1111',
    })
  })

  test('tracking customize is a no-op without a prior tracking number', () => {
    const withPlaintext = { ...blank(), plaintext: { mayor: 'Alice' }, public_key: pub }
    expect(reducer(withPlaintext, { tracking: '1111-1111-2345' })).toEqual(withPlaintext)
  })

  test('changing a selection after customize encrypts under the current tracking', () => {
    const voted = reducer({ ...blank(), public_key: pub, tracking: '1111-1111-1111' }, { mayor: 'Alice' })
    const customized = reducer(voted, { tracking: '1111-1111-2345' })
    const changed = reducer(customized, { mayor: 'Bob' })

    expect(changed.tracking).toBe('1111-1111-2345')
    expect(decryptSelection(changed, 'mayor')).toBe('1111-1111-2345:Bob')
    expect(changed.previous_submissions).toEqual(customized.previous_submissions)
  })
})

describe('changing a submitted vote (draft → signed replacement → commit)', () => {
  const columns = ['mayor', 'prop', 'council_1', 'council_2']

  /** A submitted ballot, as SubmitButton leaves it: all columns present, BLANK-padded */
  function submittedBallot(): State {
    let state = reducer({ ...blank(), public_key: pub, tracking: '1111-1111-1111' }, { mayor: 'Alice' })
    state = reducer(state, { council_1: 'Carol', council_2: 'BLANK', prop: 'Yes' })
    return reducer(state, { submitted_at: '2026-11-01T00:00:00.000Z' })
  }

  /** What EditSubmittedVote does: edit a draft, prepare, (server accepts), commit */
  function changeSelections(canonical: State, edits: Record<string, string>[]) {
    let draft = createVoteDraft(canonical)
    for (const edit of edits) draft = reducer(draft, edit)
    const prepared = prepareVoteReplacement(draft, { columns, tracking: canonical.tracking })
    if (!('vote' in prepared)) throw new Error(prepared.error)
    const replaced_at = new Date().toISOString()
    return reducer(canonical, { commit_vote_replacement: { reason: 'selections', replaced_at, vote: prepared.vote } })
  }

  test('editing a draft never mutates the canonical submitted state', () => {
    const canonical = submittedBallot()
    const snapshot = structuredClone(canonical)

    let draft = createVoteDraft(canonical)
    draft = reducer(draft, { mayor: 'Bob' })
    draft = reducer(draft, { prop: '' }) // clearing deletes keys inside nested objects
    draft = reducer(draft, { council_1: 'Dave' })

    expect(draft.plaintext.mayor).toBe('Bob')
    expect(canonical).toEqual(snapshot) // Cancel = discard draft: canonical receipt untouched
  })

  test('the draft does not carry replacement history', () => {
    const canonical = reducer(submittedBallot(), { tracking: '1111-1111-2345' })
    expect(canonical.previous_submissions).toHaveLength(1)
    expect(createVoteDraft(canonical)).not.toHaveProperty('previous_submissions')
  })

  test('commit archives the prior receipt exactly once', () => {
    const canonical = submittedBallot()
    const changed = changeSelections(canonical, [{ mayor: 'Bob' }])

    expect(changed.previous_submissions).toHaveLength(1)
    const [archived] = changed.previous_submissions || []
    expect(archived).toMatchObject({
      encoded: canonical.encoded,
      encrypted: canonical.encrypted,
      plaintext: canonical.plaintext,
      randomizer: canonical.randomizer,
      reason: 'selections',
      submitted_at: canonical.submitted_at,
      tracking: canonical.tracking,
    })
    expect(archived.replaced_at).toBeTruthy()
    expect(changed.last_replaced_at).toBe(archived.replaced_at)
  })

  test('commit updates plaintext, encoded, randomizers & ciphertext together, re-encrypting every column', () => {
    const canonical = submittedBallot()
    const changed = changeSelections(canonical, [{ mayor: 'Bob' }])

    expect(changed.plaintext).toEqual({ council_1: 'Carol', council_2: 'BLANK', mayor: 'Bob', prop: 'Yes' })
    for (const column of columns) {
      expect(decryptSelection(changed, column)).toBe(`1111-1111-1111:${changed.plaintext[column]}`)
      expect(changed.randomizer[column]).not.toBe(canonical.randomizer[column]) // fresh randomness everywhere
      expect(changed.encrypted[column]).not.toEqual(canonical.encrypted[column])
    }
    expect(Object.keys(changed.encoded).sort()).toEqual([...columns].sort())
    expect(changed.encoded.mayor).not.toBe(canonical.encoded.mayor)
    expect(changed.submitted_at).toBe(canonical.submitted_at)
  })

  test('selection changes keep the existing Verification #', () => {
    const canonical = submittedBallot()
    const changed = changeSelections(canonical, [{ mayor: 'Bob' }, { prop: 'No' }])
    expect(changed.tracking).toBe('1111-1111-1111')
  })

  test('cleared columns are completed with BLANK before submitting', () => {
    const canonical = submittedBallot()
    const changed = changeSelections(canonical, [{ council_1: '' }])
    expect(changed.plaintext.council_1).toBe('BLANK')
    expect(decryptSelection(changed, 'council_1')).toBe('1111-1111-1111:BLANK')
    expect(Object.keys(changed.encrypted).sort()).toEqual([...columns].sort())
  })

  test('a ballot with no real selections cannot be prepared', () => {
    const draft = createVoteDraft(submittedBallot())
    const allBlank = { council_1: 'BLANK', council_2: 'BLANK', mayor: '', prop: '' }
    expect(prepareVoteReplacement(draft, { columns, plaintext: allBlank })).toEqual({
      error: 'Please make at least one selection.',
    })
  })

  test('repeated changes stack history without recursive nesting', () => {
    let state = submittedBallot()
    state = changeSelections(state, [{ mayor: 'Bob' }])
    state = changeSelections(state, [{ mayor: 'Eve' }])
    state = changeSelections(state, [{ prop: 'No' }])

    expect(state.previous_submissions?.map((s) => s.plaintext.mayor)).toEqual(['Alice', 'Bob', 'Eve'])
    for (const archived of state.previous_submissions || []) expect(archived).not.toHaveProperty('previous_submissions')
  })

  test('archived receipts are isolated from later edits', () => {
    const changed = changeSelections(submittedBallot(), [{ mayor: 'Bob' }])
    const archivedPlaintext = structuredClone(changed.previous_submissions?.[0].plaintext)
    reducer(changed, { mayor: 'Zed' }) // the reducer's merge() mutates nested objects of its input
    expect(changed.previous_submissions?.[0].plaintext).toEqual(archivedPlaintext as Record<string, string>)
  })

  test('verification-number customization still works after selection changes', () => {
    let state = changeSelections(submittedBallot(), [{ mayor: 'Bob' }])
    state = changeSelections(state, [{ mayor: 'Eve' }])

    // Same path CustomizeVerificationNumber uses
    const prepared = prepareVoteReplacement(state, { columns: [], tracking: '1111-1111-2345' })
    if (!('vote' in prepared)) throw new Error(prepared.error)
    const replaced_at = new Date().toISOString()
    state = reducer(state, {
      commit_vote_replacement: { reason: 'verification-number', replaced_at, vote: prepared.vote },
    })

    expect(state.tracking).toBe('1111-1111-2345')
    expect(state.plaintext.mayor).toBe('Eve')
    expect(decryptSelection(state, 'mayor')).toBe('1111-1111-2345:Eve')

    // Only the customization counts as a Verification # change; selection changes don't
    const verificationChanges = (state.previous_submissions || []).filter(isVerificationNumberChange)
    expect(verificationChanges.map((s) => s.tracking)).toEqual(['1111-1111-1111'])
  })

  test('selection changes still work after verification-number customization', () => {
    const customized = reducer(submittedBallot(), { tracking: '1111-1111-2345' }) // legacy reducer path
    const changed = changeSelections(customized, [{ mayor: 'Bob' }])

    expect(changed.tracking).toBe('1111-1111-2345')
    expect(decryptSelection(changed, 'mayor')).toBe('1111-1111-2345:Bob')
    expect(changed.previous_submissions?.map((s) => s.reason)).toEqual(['verification-number', 'selections'])
    expect((changed.previous_submissions || []).filter(isVerificationNumberChange)).toHaveLength(1)
  })

  test('legacy history entries without a reason count as verification-number changes', () => {
    expect(isVerificationNumberChange({ ...blank(), replaced_at: '2026-01-01' })).toBe(true)
    expect(isVerificationNumberChange({ ...blank(), reason: 'selections', replaced_at: '2026-01-01' })).toBe(false)
  })

  test('commit is ignored before the initial submission', () => {
    const notSubmitted = reducer({ ...blank(), public_key: pub, tracking: '1111-1111-1111' }, { mayor: 'Alice' })
    const prepared = prepareVoteReplacement(notSubmitted, { columns: ['mayor'] })
    if (!('vote' in prepared)) throw new Error(prepared.error)
    const after = reducer(notSubmitted, {
      commit_vote_replacement: { reason: 'selections', replaced_at: '2026-01-01', vote: prepared.vote },
    })
    expect(after).toBe(notSubmitted)
  })
})
