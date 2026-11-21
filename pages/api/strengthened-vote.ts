import { makeReplaceVoteHandler } from './replace-vote'

/** Legacy alias of `/api/replace-vote`, kept for older clients of "Customize Verification Number".
 * Same signed-replacement implementation; requests that don't send a `reason` are recorded as
 * verification-number changes (which also keeps updating `strengthened_at`). */
export default makeReplaceVoteHandler('verification-number')
