import { Checkbox, FormControlLabel, FormGroup } from '@mui/material'
import { Dispatch, useEffect, useState } from 'react'

import { optionPlaintextToken } from './Ballot'
import { Label, TitleDescriptionQuestion } from './Item'
import { Item as ItemType } from './storeElectionInfo'
import { State } from './vote-state'

export const MultiVoteItem = ({
  description,
  dispatch,
  id = 'vote',
  multiple_votes_allowed,
  options,
  question,
  state,
  title,
  type,
}: ItemType & {
  dispatch: Dispatch<Record<string, string>>
  election_id?: string
  multiple_votes_allowed: number
  state: State
}): JSX.Element => {
  // Start from any stored selections (e.g. when changing a submitted vote)
  const [selected, setState] = useState(() => storedSelections(state.plaintext, id, multiple_votes_allowed))

  // Store changes in localstorage state
  useEffect(() => {
    const selections = [...selected].sort()

    // Pad selections array up to `multiple_votes_allowed`, to prevent encryption holes
    for (let i = selected.size; i < multiple_votes_allowed; i++) {
      selections.push('BLANK')
    }

    // Convert selections array to object like:
    // { [item.id_1]: selection_1, [item.id_2]: selection_2 }
    const obj = selections.reduce((acc, choice, index) => ({ ...acc, [`${id}_${index + 1}`]: choice }), {})

    dispatch(obj)
  }, [selected.size])

  return (
    <>
      <TitleDescriptionQuestion {...{ description, question, title }} />

      <p className="sm:ml-[13px] italic ">
        {type === 'approval' ? (
          'Vote for all the options you approve of:'
        ) : (
          <>
            Remaining votes: {multiple_votes_allowed - selected.size} of {multiple_votes_allowed}
          </>
        )}
      </p>
      <FormGroup className="ml-2 sm:ml-4">
        {options.map(({ markdown_sub, name, photo_url, sub, value }) => {
          const val = optionPlaintextToken(name, value)

          return (
            <FormControlLabel
              control={
                <Checkbox
                  checked={selected.has(val)}
                  color="primary"
                  onChange={(event) => {
                    // If they're trying to add
                    if (event.target.checked) {
                      // Allow if they still have votes remaining
                      if (selected.size < multiple_votes_allowed) setState(new Set([val, ...selected]))
                    } else {
                      // Otherwise remove
                      const newSet = new Set([...selected])
                      newSet.delete(val)
                      setState(newSet)
                    }
                  }}
                />
              }
              key={name}
              label={<Label {...{ markdown_sub, name, photo_url, sub }} />}
              name={val}
            />
          )
        })}
      </FormGroup>
      <br />
    </>
  )
}

/** Selections already stored for this question: `{id}_1 … {id}_n`, minus BLANKs */
function storedSelections(plaintext: Record<string, string>, id: string, multiple_votes_allowed: number) {
  const values = Array.from({ length: multiple_votes_allowed }, (_, i) => plaintext[`${id}_${i + 1}`])
  return new Set(values.filter((value): value is string => !!value && value !== 'BLANK'))
}
