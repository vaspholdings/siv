import { cloneDeep, mapValues, merge, omit, pick } from 'lodash-es'
import { random_bigint, RP, stringToPoint } from 'src/crypto/curve'
import { CipherStrings } from 'src/crypto/stringify-shuffle'
import { ReplacementReason } from 'src/crypto/voter-key'

import { encrypt } from '../crypto/encrypt'
import { Item } from './storeElectionInfo'
import { generateTrackingNum } from './tracking-num'
import { useLocalStorageReducer } from './useLocalStorage'

/** A prior local receipt, kept after its ballot was replaced on the server */
export type ArchivedSubmission = VoteData & {
  /** Missing on entries from before 'selections' existed: those were all verification-number changes */
  reason?: ReplacementReason
  replaced_at: string
}

/** Commit a server-accepted replacement as the new canonical local receipt (see EditSubmittedVote) */
export type CommitVoteReplacement = {
  commit_vote_replacement: { reason: ReplacementReason; replaced_at: string; vote: ReplacementVote }
}

/** A complete, freshly encrypted ballot, ready to sign & submit as a replacement */
export type ReplacementVote = Pick<VoteData, 'encoded' | 'encrypted' | 'plaintext' | 'randomizer'> & {
  tracking: string
}

export type State = VoteData & {
  auth_added_at?: string
  ballot_design?: Item[]
  ballot_design_finalized?: boolean
  custom_invitation_text?: string
  election_manager?: string
  election_title?: string
  esignature_requested?: boolean
  last_modified_at?: Date
  last_replaced_at?: string
  link_auth?: string
  previous_submissions?: ArchivedSubmission[]
  privacy_protectors_statements?: string
  public_key?: string
  // replacement_pub/privkey renamed to voter_pub/privkey. Safe to delete after 2026-09-29
  replacement_privkey?: string
  replacement_pubkey?: string
  submission_confirmation?: string
  voter_privkey?: string
  voter_pubkey?: string
}

export type VoteAction = CommitVoteReplacement | Map

type Map = Record<string, string>
type VoteData = {
  encoded: Map
  encrypted: Record<string, CipherStrings>
  plaintext: Map
  randomizer: Map
  submitted_at?: Date
  tracking?: string
}

/** Fill missing ballot columns with 'BLANK' (to avoid visible encryption holes), and drop cleared ones */
export function completeBallotPlaintext(plaintext: Map, columns: string[]): Map {
  const completed: Map = {}
  Object.entries(plaintext).forEach(([key, value]) => {
    if (value !== '') completed[key] = value
  })
  columns.forEach((column) => {
    if (!completed[column]) completed[column] = 'BLANK'
  })
  return completed
}

/** Isolated, deep-cloned copy of the submitted state, for editing without touching the canonical receipt.
 * (The reducer's merge() mutates nested objects, so a shallow copy is NOT enough.) */
export function createVoteDraft(state: State): State {
  return cloneDeep(omit(state, ['previous_submissions'])) as State
}

/** Archived receipts from verification-number customizations (not selection changes).
 * Legacy entries have no reason: they predate selection changes, so they were all verification-number changes. */
export const isVerificationNumberChange = (submission: ArchivedSubmission) => submission.reason !== 'selections'

/** True if at least one column has a real (non-BLANK) selection */
export const hasSelection = (plaintext: Map) => Object.values(plaintext).some((value) => !!value && value !== 'BLANK')

/** Build a complete, freshly re-encrypted ballot for a signed replacement, without changing any state.
 * Defaults keep the current selections & Verification #. */
export function prepareVoteReplacement(
  state: State,
  {
    columns,
    plaintext = state.plaintext,
    tracking = state.tracking,
  }: { columns: string[]; plaintext?: Map; tracking?: string },
): { error: string } | { vote: ReplacementVote } {
  if (!state.public_key) return { error: 'Missing election public key. Please reload the page.' }
  if (!tracking) return { error: 'Missing Verification #' }

  const completed = completeBallotPlaintext(plaintext, columns)
  if (!hasSelection(completed)) return { error: 'Please make at least one selection.' }

  return { vote: { ...encryptSelections(completed, tracking, state.public_key), plaintext: completed, tracking } }
}

/** Core state logic */
export function reducer(prev: State, payload: VoteAction) {
  // Replacement accepted by the server: archive the prior receipt, then swap in the new one
  if (isCommitVoteReplacement(payload)) return commitVoteReplacement(prev, payload.commit_vote_replacement)

  // Special handler for customizing verification number.
  // Re-encrypt under the new tracking, & archive prior
  if (payload.tracking && payload.tracking !== prev.tracking) {
    if (!prev.public_key) return fail(prev, 'prev.public_key')
    if (!prev.tracking) return fail(prev, 'prev.tracking')
    if (!prev.plaintext || !Object.keys(prev.plaintext).length) return fail(prev, 'prev.plaintext')

    return {
      ...prev,
      ...encryptSelections(prev.plaintext, payload.tracking, prev.public_key),
      last_modified_at: new Date(),
      previous_submissions: [
        ...(prev.previous_submissions || []),
        archiveSubmission(prev, 'verification-number', new Date().toISOString()),
      ],
      tracking: payload.tracking,
    }
  }

  // Special handler for other state updates
  // that don't require encryption
  if (
    payload.ballot_design ||
    payload.submitted_at ||
    payload.esigned_at ||
    payload.link_auth ||
    payload.voter_privkey ||
    payload.voter_pubkey
  ) {
    return { ...prev, ...payload }
  }

  // Merge in new state from payload
  const newState = merge({ ...prev }, { last_modified_at: new Date(), plaintext: payload })

  // Filter out empty values
  Object.keys(newState.plaintext).forEach((key) => {
    if (newState.plaintext[key] == '') {
      Object.keys(initState).forEach((group) => {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- don't encrypt empty strings
        delete (newState as never)[group][key]
      })
    }
  })

  // Stop if no public key
  if (Object.keys(newState.plaintext) && !prev.public_key) return prev

  // Generate Verification number if needed
  if (!newState.tracking) newState.tracking = generateTrackingNum()

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return merge(newState, encryptSelections(newState.plaintext, newState.tracking, prev.public_key!))
}

/** Snapshot of the current receipt. Deep-cloned, and never nests previous_submissions. */
function archiveSubmission(prev: State, reason: ReplacementReason, replaced_at: string): ArchivedSubmission {
  return {
    ...cloneDeep(pick(prev, ['encoded', 'encrypted', 'plaintext', 'randomizer', 'submitted_at', 'tracking'])),
    reason,
    replaced_at,
  }
}

function commitVoteReplacement(
  prev: State,
  { reason, replaced_at, vote }: CommitVoteReplacement['commit_vote_replacement'],
) {
  if (!prev.submitted_at) return fail(prev, 'prev.submitted_at')
  if (!vote?.tracking || !Object.keys(vote.encrypted || {}).length) return fail(prev, 'replacement vote')

  const { encoded, encrypted, plaintext, randomizer, tracking } = vote
  return {
    ...prev,
    encoded,
    encrypted,
    last_modified_at: new Date(),
    last_replaced_at: replaced_at,
    plaintext,
    previous_submissions: [...(prev.previous_submissions || []), archiveSubmission(prev, reason, replaced_at)],
    randomizer,
    tracking,
  }
}

function encryptSelections(plaintext: Map, tracking: string, public_key: string) {
  // Initialize empty dicts for intermediary steps
  const randomizer: Map = {}
  const encoded: Map = {}

  // For each key in plaintext
  const encrypted = mapValues(plaintext, (value, key) => {
    // Encode the string into an element of our Prime Order Group
    encoded[key] = stringToPoint(`${tracking}:${value}`).toHex()

    // Generate & store a randomizer
    const random = random_bigint()
    randomizer[key] = String(random)

    // Encrypt the encoded value w/ its randomizer
    const cipher = encrypt(RP.fromHex(public_key), random, RP.fromHex(encoded[key]))

    // Store the encrypted cipher as strings
    return mapValues(cipher, String)
  })
  return { encoded, encrypted, randomizer }
}

function fail(prev: State, item: string) {
  if (process.env.NODE_ENV !== 'test') {
    const msg = `Error: ${item} missing`
    console.error(msg, prev)
    alert(msg)
  }
  return prev
}

function isCommitVoteReplacement(payload: VoteAction): payload is CommitVoteReplacement {
  return typeof (payload as Partial<CommitVoteReplacement>).commit_vote_replacement === 'object'
}

const initState = {
  encoded: {},
  encrypted: {},
  plaintext: {},
  randomizer: {},
}

/** Export consumable hook that returns [state, dispatch] */
export const useVoteState = (storage_key: string) => useLocalStorageReducer(storage_key, reducer, initState)
