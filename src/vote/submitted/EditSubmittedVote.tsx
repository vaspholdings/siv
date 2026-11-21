import { isEqual } from 'lodash-es'
import { Dispatch, useReducer, useState } from 'react'
import { OnClickButton } from 'src/_shared/Button'

import { Ballot } from '../Ballot'
import { generateColumnNames } from '../generateColumnNames'
import {
  completeBallotPlaintext,
  createVoteDraft,
  hasSelection,
  prepareVoteReplacement,
  reducer,
  State,
  VoteAction,
} from '../vote-state'
import { getVoterPrivkey, submitVoteReplacement } from './submit-replacement'

/** Ballot edits only touch this isolated draft, never the canonical submitted receipt */
const draftReducer = (draft: State, action: VoteAction) => reducer(draft, action) as State

/** Edit a submitted ballot, then replace it with a freshly encrypted, signed version.
 * The device's local receipt is only updated after the server accepts the replacement. */
export function EditSubmittedVote({
  auth,
  dispatch,
  election_id,
  onCancel,
  onClosed,
  onSuccess,
  state,
}: {
  /** The real vote token: for auth=link elections this is the persisted link_auth */
  auth: string
  dispatch: Dispatch<VoteAction>
  election_id: string
  onCancel: () => void
  onClosed: () => void
  onSuccess: () => void
  state: State
}) {
  const [draft, draftDispatch] = useReducer(draftReducer, state, createVoteDraft)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const { columns } = generateColumnNames({ ballot_design: draft.ballot_design })
  const edited = completeBallotPlaintext(draft.plaintext, columns)
  const changed = !isEqual(edited, completeBallotPlaintext(state.plaintext, columns))
  const canSubmit = changed && hasSelection(edited) && !submitting

  async function submit() {
    if (!canSubmit) return
    if (state.submission_confirmation && !confirm(state.submission_confirmation)) return

    const privkey = getVoterPrivkey(state)
    if (!privkey) return setError('This device no longer has the key needed to change your vote.')

    // Same BLANK-completion as the initial submit, fresh encryption randomness, same Verification #
    const prepared = prepareVoteReplacement(draft, { columns, tracking: state.tracking })
    if ('error' in prepared) return setError(prepared.error)

    setError('')
    setSubmitting(true)
    const result = await submitVoteReplacement({
      auth,
      election_id,
      encrypted_vote: prepared.vote.encrypted,
      privkey,
      reason: 'selections',
    })
    setSubmitting(false)

    if (!result.ok) {
      setError(result.error)
      if (result.election_closed) onClosed()
      return
    }

    // Server accepted: now (and only now) make it this device's receipt
    const { replaced_at } = result
    dispatch({ commit_vote_replacement: { reason: 'selections', replaced_at, vote: prepared.vote } })
    onSuccess()
  }

  return (
    <div className="mb-10" id="edit-submitted-vote">
      <h3 className="mb-1">Change your vote</h3>
      <p className="mt-0 text-sm opacity-70">
        Your submitted vote stays in place until you submit your changes. Submitting replaces it; it doesn&apos;t add a
        second vote.
      </p>

      <Ballot {...{ dispatch: draftDispatch, election_id, state: draft }} />

      {error && (
        <p className="text-sm text-red-600" id="change-vote-error" role="alert">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-4 justify-end items-center">
        <button
          className="p-0 text-sm bg-transparent border-0 opacity-70 cursor-pointer hover:opacity-100"
          disabled={submitting}
          id="cancel-change-vote"
          onClick={onCancel}
          type="button"
        >
          Cancel
        </button>
        <OnClickButton disabled={!canSubmit} id="submit-changed-vote" onClick={submit} style={{ marginRight: 0 }}>
          {submitting ? 'Submitting…' : 'Submit changed vote'}
        </OnClickButton>
      </div>
      {!changed && <p className="mt-2 text-xs text-right opacity-60">Make a change to submit.</p>}
    </div>
  )
}
