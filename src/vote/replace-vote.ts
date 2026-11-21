import type { firestore } from 'firebase-admin'
import type { CipherStrings } from 'src/crypto/stringify-shuffle'

import {
  canonicalizeEncryptedVote,
  encodeReplacementPayload,
  is64HexChars,
  is128HexChars,
  isReplacementReason,
  ReplacementReason,
  verifyReplacement,
} from 'src/crypto/voter-key'

/** Server-side core of `POST /api/replace-vote` (and the legacy `/api/strengthened-vote`).
 *
 * One voter -> one current accepted encrypted ballot. While polls are open, the holder of the
 * device private key registered at initial submission may atomically replace that ballot's
 * ciphertext in place. Only the latest ciphertext is served by /cache-accepted and tallied.
 *
 * - The auth token only *identifies* which vote is addressed.
 * - The Ed25519 signature (by the stored `voter_pubkey`) is what *authorizes* the replacement.
 * - `num_votes` and the vote's identity (`auth`, `created_at`, `voter_pubkey`) are never changed.
 *
 * Kept free of firebase-admin runtime imports so it can be unit tested with a fake Firestore. */

export const STOPPED_ACCEPTING_VOTES = 'The election administrator has stopped accepting new votes.'

/** Upper bound on archived versions per vote: keeps the vote doc far below Firestore's 1 MiB limit,
 * and bounds how often one voter can force /cache-accepted page rewrites. */
export const MAX_REPLACEMENTS = 100
const MAX_COLUMNS = 1000
const MAX_CIPHER_STRING_LENGTH = 1000

export type ReplaceVoteDeps = {
  /** Used when the request doesn't say why (e.g. legacy /api/strengthened-vote callers) */
  defaultReason?: ReplacementReason
  getElectionDoc: (election_id: string) => firestore.DocumentReference
  invalidateCachedVote: (
    electionDoc: firestore.DocumentReference,
    args: {
      auth: string
      created_at?: firestore.Timestamp
      encrypted_vote: EncryptedVote
      pending: boolean
      vote_doc_id: string
      vote_ref: firestore.DocumentReference
    },
  ) => Promise<unknown>
  now?: () => Date
  /** Called if cache invalidation throws after the replacement was committed */
  onCacheError?: (electionDoc: firestore.DocumentReference, error: unknown) => Promise<unknown> | unknown
}

export type ReplaceVoteResponse =
  | { election_closed?: true; error: string }
  | { replaced_at: string; success: true; unchanged?: true }

type EncryptedVote = Record<string, CipherStrings>

type Result = { body: ReplaceVoteResponse; status: number }

const fail = (status: number, error: string): Result => ({ body: { error }, status })
const closed = (): Result => ({ body: { election_closed: true, error: STOPPED_ACCEPTING_VOTES }, status: 400 })

/** Thrown inside the transaction to abort it with a specific response */
class Abort {
  constructor(public result: Result) {}
}

export async function replaceSubmittedVote(body: unknown, deps: ReplaceVoteDeps): Promise<Result> {
  // Validate body
  const {
    auth,
    election_id,
    encrypted_vote,
    reason: requestedReason,
    signature,
  } = (body || {}) as Record<string, unknown>
  if (!election_id || typeof election_id !== 'string') return fail(400, 'Missing Election ID')
  if (!auth || typeof auth !== 'string') return fail(400, 'Missing auth')
  if (!isEncryptedVote(encrypted_vote)) return fail(400, 'Missing or malformed encrypted_vote')
  if (!is128HexChars(signature)) return fail(400, 'Missing or malformed signature')
  if (requestedReason !== undefined && !isReplacementReason(requestedReason))
    return fail(400, 'Unknown replacement reason')
  const reason = requestedReason ?? deps.defaultReason

  // Load election
  const electionDoc = deps.getElectionDoc(election_id)
  const election = await electionDoc.get()
  if (!election.exists) return fail(400, 'Unknown Election ID')
  if (election.data()?.stop_accepting_votes) return closed()

  // Find existing vote (accepted first, then pending link-auth submissions).
  // For auth=link elections, clients must send the persisted link_auth here, never the literal 'link'.
  let voteSnap = await electionDoc.collection('votes').where('auth', '==', auth).limit(1).get()
  if (voteSnap.empty)
    voteSnap = await electionDoc.collection('votes-pending').where('link_auth', '==', auth).limit(1).get()
  if (voteSnap.empty) return fail(404, 'No vote found for this auth')
  const voteRef = voteSnap.docs[0].ref

  // Require the device's voter_pubkey from the original submit
  const voter_pubkey = getVoterPubkey(voteSnap.docs[0].data())
  if (!is64HexChars(voter_pubkey)) return fail(400, 'Vote has no voter_pubkey; cannot authorize replace')

  // Verify signature over the new encrypted_vote
  const message = encodeReplacementPayload({ auth, election_id, encrypted_vote })
  if (!(await safeVerify(voter_pubkey, signature, message))) return fail(401, 'Invalid replacement signature')

  // Only store the signed fields
  const newVote = canonicalizeEncryptedVote(encrypted_vote)
  const newVoteKey = JSON.stringify(newVote)
  const replaced_at = (deps.now || (() => new Date()))()

  // Atomically: re-read, re-check, archive the current ciphertext, swap in the new one
  let outcome: { created_at?: firestore.Timestamp; unchanged: boolean }
  try {
    outcome = await electionDoc.firestore.runTransaction(async (tx: firestore.Transaction) => {
      const [electionNow, voteNow] = await Promise.all([tx.get(electionDoc), tx.get(voteRef)])

      // Polls may have closed since the first check
      if (electionNow.data()?.stop_accepting_votes) throw new Abort(closed())

      // Pending vote may have just been approved (moved to `votes`)
      if (!voteNow.exists)
        throw new Abort(fail(409, 'Your vote was moved while it was being changed. Please try again.'))

      const vote = voteNow.data() || {}
      if (getVoterPubkey(vote) !== voter_pubkey) throw new Abort(fail(401, 'Invalid replacement signature'))

      // Same ciphertext as the current one: idempotent retry, nothing to do
      if (isSameVote(vote.encrypted_vote, newVoteKey)) return { created_at: vote.created_at, unchanged: true }

      // Re-encryption always uses fresh randomness, so a legitimate replacement never repeats an
      // archived ciphertext. Rejecting these blocks replays of old signed requests.
      const previous: Record<string, unknown>[] = Array.isArray(vote.previous_submissions)
        ? vote.previous_submissions
        : []
      if (previous.some((p) => isSameVote(p?.encrypted_vote, newVoteKey)))
        throw new Abort(fail(409, 'This encrypted ballot was already replaced, so it cannot be submitted again.'))

      // Every column of the current ballot must still be present
      const missingColumns = Object.keys(vote.encrypted_vote || {}).filter((key) => !(key in newVote))
      if (missingColumns.length)
        throw new Abort(fail(400, `Replacement is missing columns: ${missingColumns.join(', ')}`))

      if (previous.length >= MAX_REPLACEMENTS)
        throw new Abort(fail(429, `This vote has reached the limit of ${MAX_REPLACEMENTS} changes.`))

      tx.update(voteRef, {
        encrypted_vote: newVote,
        last_replaced_at: replaced_at,
        previous_submissions: [
          ...previous,
          {
            encrypted_vote: vote.encrypted_vote,
            replaced_at,
            ...(vote.created_at && { created_at: vote.created_at }),
            ...(vote.last_replaced_at && { last_replaced_at: vote.last_replaced_at }),
            ...(reason && { replacement_reason: reason }),
            ...(vote.strengthened_at && { strengthened_at: vote.strengthened_at }),
          },
        ],
        // Kept for backwards compatibility with the verification-number feature
        ...(reason === 'verification-number' && { strengthened_at: replaced_at }),
      })
      return { created_at: vote.created_at, unchanged: false }
    })
  } catch (error) {
    if (error instanceof Abort) return error.result
    throw error
  }

  // Ensure /cache-accepted serves the latest ciphertext.
  // The replacement is already committed, so a cache failure must not be reported as a failed replace.
  if (!outcome.unchanged) {
    try {
      await deps.invalidateCachedVote(electionDoc, {
        auth,
        created_at: outcome.created_at,
        encrypted_vote: newVote,
        pending: voteRef.parent.id === 'votes-pending',
        vote_doc_id: voteRef.id,
        vote_ref: voteRef,
      })
    } catch (error) {
      await deps.onCacheError?.(electionDoc, error)
    }
  }

  return {
    body: { replaced_at: replaced_at.toISOString(), success: true, ...(outcome.unchanged && { unchanged: true }) },
    status: 200,
  }
}

/** `replacement_pubkey` was renamed `voter_pubkey`. Safe to drop the fallback after 2026-09-29 */
function getVoterPubkey(vote: firestore.DocumentData | undefined): unknown {
  return vote?.voter_pubkey || vote?.replacement_pubkey
}

function isEncryptedVote(value: unknown): value is EncryptedVote {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const columns = Object.entries(value)
  if (!columns.length || columns.length > MAX_COLUMNS) return false
  return columns.every(([, cipher]) => {
    if (!cipher || typeof cipher !== 'object') return false
    const { encrypted, lock } = cipher as Record<string, unknown>
    return [encrypted, lock].every((s) => typeof s === 'string' && s.length > 0 && s.length <= MAX_CIPHER_STRING_LENGTH)
  })
}

function isSameVote(stored: unknown, newVoteKey: string) {
  if (!isEncryptedVote(stored)) return false
  return JSON.stringify(canonicalizeEncryptedVote(stored)) === newVoteKey
}

/** Malformed keys/signatures should be a 401, not a 500 */
async function safeVerify(pubkey: string, signature: string, message: Uint8Array) {
  try {
    return await verifyReplacement(pubkey, signature, message)
  } catch {
    return false
  }
}
