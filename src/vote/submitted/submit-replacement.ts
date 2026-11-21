import { api } from 'src/api-helper'
import { CipherStrings } from 'src/crypto/stringify-shuffle'
import { encodeReplacementPayload, ReplacementReason, signReplacement } from 'src/crypto/voter-key'

import { State } from '../vote-state'

export type SubmitReplacementResult =
  | { election_closed: boolean; error: string; ok: false }
  | { ok: true; replaced_at: string }

/** This device's voter signing key. `replacement_privkey` is the pre-rename name; drop after 2026-09-29 */
export const getVoterPrivkey = (state: State) => state.voter_privkey || state.replacement_privkey

/** Sign a replacement ciphertext with this device's voter key, and submit it to /api/replace-vote.
 * Never changes local state: callers commit only after `ok: true`. */
export async function submitVoteReplacement({
  auth,
  election_id,
  encrypted_vote,
  privkey,
  reason,
}: {
  auth: string
  election_id: string
  encrypted_vote: Record<string, CipherStrings>
  privkey: string
  reason: ReplacementReason
}): Promise<SubmitReplacementResult> {
  let signature: string
  try {
    signature = await signReplacement(privkey, encodeReplacementPayload({ auth, election_id, encrypted_vote }))
  } catch (e) {
    return { election_closed: false, error: `Could not sign your vote on this device: ${String(e)}`, ok: false }
  }

  let response: Response
  try {
    response = await api('replace-vote', { auth, election_id, encrypted_vote, reason, signature })
  } catch {
    return {
      election_closed: false,
      error: "We couldn't reach the server, so your change may not have been saved. Please try again.",
      ok: false,
    }
  }

  // Shape of ReplaceVoteResponse (src/vote/replace-vote.ts)
  const body = (await response.json().catch(() => ({}))) as {
    election_closed?: boolean
    error?: string
    replaced_at?: string
    success?: boolean
  }
  if (response.status !== 200 || !body.success)
    return {
      election_closed: !!body.election_closed,
      error: body.error || `Server error (${response.status}). Your vote was not changed.`,
      ok: false,
    }

  return { ok: true, replaced_at: body.replaced_at || new Date().toISOString() }
}
