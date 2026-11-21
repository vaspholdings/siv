import { Dispatch, useEffect, useState } from 'react'
import { OnClickButton } from 'src/_shared/Button'
import { useData } from 'src/pusher-helper'

import { ElectionInfo } from '../../../pages/api/election/[election_id]/info'
import { State, VoteAction } from '../vote-state'
import { EditSubmittedVote } from './EditSubmittedVote'
import { getVoterPrivkey } from './submit-replacement'

/** "Change your vote": while polls are open, reopen the ballot on the same device and replace the submitted ballot.
 * Authorized by the voter key stored on this device at initial submission — never by the auth token alone. */
export function ChangeVote({
  auth,
  dispatch,
  editing,
  election_id,
  setEditing,
  state,
}: {
  /** The real vote token: for auth=link elections this is the persisted link_auth */
  auth: string
  dispatch: Dispatch<VoteAction>
  editing: boolean
  election_id: string
  setEditing: (editing: boolean) => void
  state: State
}) {
  // Plain fetch (no Pusher subscription, to avoid a realtime connection per voter). Refreshes on window focus.
  const { data } = useData(`election/${election_id}/info`)
  const { last_decrypted_at, stop_accepting_votes } = (data || {}) as ElectionInfo
  const [closedByServer, setClosedByServer] = useState(false)
  const [justUpdated, setJustUpdated] = useState(false)

  const closed = !!stop_accepting_votes || closedByServer
  const hasDeviceKey = !!getVoterPrivkey(state)
  const canEdit = !closed && hasDeviceKey

  // e.g. polls closed (seen on refocus) while the editor was open: drop the draft
  useEffect(() => {
    if (editing && !canEdit) setEditing(false)
  }, [canEdit, editing, setEditing])

  // Already unlocked once? Then a newer change only shows after votes are shuffled & unlocked again.
  // (Verification # customizations show their own note.)
  const lastSelectionChangeAt = state.previous_submissions?.filter((s) => s.reason === 'selections').at(-1)?.replaced_at
  const awaitingReunlock =
    !!last_decrypted_at &&
    !!lastSelectionChangeAt &&
    new Date(lastSelectionChangeAt).getTime() > new Date(last_decrypted_at).getTime()

  if (editing && canEdit)
    return (
      <EditSubmittedVote
        {...{ auth, dispatch, election_id, state }}
        onCancel={() => setEditing(false)}
        onClosed={() => {
          setClosedByServer(true)
          setEditing(false)
        }}
        onSuccess={() => {
          setJustUpdated(true)
          setEditing(false)
          window.scrollTo(0, 0)
        }}
      />
    )

  return (
    <div className="mb-8" id="change-vote">
      {justUpdated && (
        <div className="p-3 mb-3 rounded-md border border-green-600/30 bg-green-50" id="vote-updated" role="status">
          <b>Vote updated.</b> Your previous encrypted submission was replaced. Only your latest submitted vote will be
          tallied.
        </div>
      )}

      {awaitingReunlock && (
        <p className="text-xs opacity-70">
          Votes were already unlocked once. Your latest change will appear in the published results after the election
          administrator shuffles &amp; unlocks votes again.
        </p>
      )}

      {closed ? (
        <p className="text-sm opacity-80" id="change-vote-closed">
          Voting has closed. Your submitted vote can no longer be changed.
        </p>
      ) : !hasDeviceKey ? (
        <p className="text-sm opacity-80" id="change-vote-no-key">
          To change a submitted vote, return using the same browser &amp; device that was used to submit it. This
          browser doesn&apos;t have the private voting key for this ballot, so it can&apos;t be changed here.
        </p>
      ) : (
        <>
          <OnClickButton
            id="change-vote-button"
            onClick={() => {
              setJustUpdated(false)
              setEditing(true)
            }}
            style={{ marginLeft: 0 }}
          >
            Change your vote
          </OnClickButton>
          <p className="mt-2 max-w-xl text-xs opacity-70">
            You can change your selections while voting is still open. If you submit changes, your previous encrypted
            ballot will be replaced and only your latest submitted vote will be tallied. To change it later, return
            using this same browser &amp; device.
          </p>
        </>
      )}
    </div>
  )
}
