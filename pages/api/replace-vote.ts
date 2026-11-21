import { NextApiRequest, NextApiResponse } from 'next'
import { ReplacementReason } from 'src/crypto/voter-key'
import { replaceSubmittedVote } from 'src/vote/replace-vote'

import { firebase, pushover } from './_services'
import { withApiErrorLogs } from './_with-api-error-logs'
import { invalidateCachedVote, resetVotesCache } from './election/[election_id]/cache-accepted'

/** Replace a submitted vote's ciphertext in place, authorized by the voter's device signature.
 * Used for both "Change your vote" (reason: 'selections') and "Customize Verification Number". */
export const makeReplaceVoteHandler = (defaultReason?: ReplacementReason) =>
  withApiErrorLogs(async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

    const { body, status } = await replaceSubmittedVote(req.body, {
      defaultReason,
      getElectionDoc: (election_id) => firebase.firestore().collection('elections').doc(election_id),
      invalidateCachedVote,
      onCacheError: async (electionDoc, error) => {
        // Replacement is committed. Fall back to a full cache rebuild so the new ciphertext gets served.
        const message = error instanceof Error ? error.message : String(error)
        await Promise.all([
          resetVotesCache(electionDoc),
          pushover('replace-vote: cache invalidation failed', `election: ${electionDoc.id}\n${message}`),
        ]).catch((e) => console.error('replace-vote: cache reset failed', e))
      },
    })

    return res.status(status).json(body)
  })

export default makeReplaceVoteHandler()
