// Run: bun run e2e --spec cypress/integration/change_vote.ts
// Exercises "Change your vote" on the real voter interface. Vote APIs are stubbed: the server side
// (signature checks, transactions, cache) is covered by src/vote/replace-vote.test.ts and cache-accepted.test.ts.

const election_id = 'change-vote-test'
const auth = 'abcdef1234'
const storageKey = `voter-${election_id}-${auth}`

const info = (overrides: Record<string, unknown> = {}) => ({
  ballot_design: [
    {
      id: 'mayor',
      options: [{ name: 'Alice' }, { name: 'Bob' }],
      title: 'Mayor',
      write_in_allowed: false,
    },
    {
      id: 'council',
      options: [{ name: 'Carol' }, { name: 'Dave' }, { name: 'Erin' }],
      title: 'City Council',
      type: 'approval',
      write_in_allowed: false,
    },
  ],
  ballot_design_finalized: true,
  stop_accepting_votes: false,
  threshold_public_key: 'e2f2ae0a6abc4e71a884a961c500515f58e30b6aa582dd8db6a65945e08d2d76',
  ...overrides,
})

const option = (name: string) => cy.contains('#edit-submitted-vote label', name).find('input')

describe('Change your vote', () => {
  beforeEach(() => {
    cy.intercept('GET', `/api/election/${election_id}/info`, info()).as('info')
    cy.intercept('POST', '/api/check-auth-token', { body: 'Valid', statusCode: 200 })
    cy.intercept('POST', '/api/submit-vote', { body: 'Success.', statusCode: 200 }).as('submit')
    cy.intercept('POST', '/api/replace-vote', (req) =>
      req.reply({ body: { replaced_at: new Date().toISOString(), success: true }, statusCode: 200 }),
    ).as('replace')
  })

  it('submits, edits a draft, replaces the vote, and keeps the Verification #', () => {
    cy.visit(`/election/${election_id}/vote?auth=${auth}`, { onBeforeLoad: (win) => win.localStorage.clear() })

    // 1. Initial vote, exactly as before
    cy.contains('label', 'Alice').click()
    cy.contains('label', 'Carol').click()
    cy.contains('a', /^Submit$/).click()
    cy.wait('@submit')
    cy.contains('Vote Submitted.').should('be.visible')

    let originalTracking = ''
    cy.window().then((win) => {
      originalTracking = JSON.parse(win.localStorage.getItem(storageKey) || '{}').tracking
      expect(originalTracking).to.match(/^\d{4}-\d{4}-\d{4}$/)
    })

    // 2. "Change your vote" reopens the ballot with the submitted choices
    cy.get('#change-vote-button').should('be.visible').click()
    option('Alice').should('be.checked')
    option('Carol').should('be.checked')
    option('Dave').should('not.be.checked')
    cy.get('#submit-changed-vote').should('have.class', 'disabled') // nothing changed yet

    // 3. Editing the draft doesn't touch the stored receipt
    option('Bob').click({ force: true })
    option('Dave').click({ force: true })
    cy.window().then((win) => {
      const stored = JSON.parse(win.localStorage.getItem(storageKey) || '{}')
      expect(stored.plaintext.mayor).to.eq('Alice')
      expect(stored.previous_submissions).to.eq(undefined)
    })

    // 4. Submit the change: complete, signed, freshly re-encrypted ballot
    cy.get('#submit-changed-vote').click()
    cy.wait('@replace')
      .its('request.body')
      .then((body) => {
        expect(body.auth).to.eq(auth)
        expect(body.election_id).to.eq(election_id)
        expect(body.reason).to.eq('selections')
        expect(body.signature).to.match(/^[0-9a-f]{128}$/)
        expect(Object.keys(body.encrypted_vote).sort()).to.deep.eq(['council_1', 'council_2', 'council_3', 'mayor'])
      })

    // 5. Success message, and the receipt now holds the new vote under the same Verification #
    cy.get('#vote-updated').should('contain', 'Vote updated.')
    cy.window().then((win) => {
      const stored = JSON.parse(win.localStorage.getItem(storageKey) || '{}')
      expect(stored.plaintext.mayor).to.eq('Bob')
      expect(stored.tracking).to.eq(originalTracking)
      expect(stored.previous_submissions).to.have.length(1)
      expect(stored.previous_submissions[0].plaintext.mayor).to.eq('Alice')
      expect(stored.previous_submissions[0].reason).to.eq('selections')
    })

    // 6. Reopening shows the newest selections; it can be changed again
    cy.get('#change-vote-button').click()
    option('Bob').should('be.checked')
    option('Dave').should('be.checked')
    cy.get('#cancel-change-vote').click()
    cy.get('#change-vote-button').should('be.visible')

    // 7. A failed replacement keeps the current receipt and shows an error
    cy.intercept('POST', '/api/replace-vote', { body: { error: 'Server exploded' }, statusCode: 500 }).as('failed')
    cy.get('#change-vote-button').click()
    option('Alice').click({ force: true })
    cy.get('#submit-changed-vote').click()
    cy.wait('@failed')
    cy.get('#change-vote-error').should('contain', 'Server exploded')
    cy.get('#vote-updated').should('not.exist')
    cy.window().then((win) => {
      const stored = JSON.parse(win.localStorage.getItem(storageKey) || '{}')
      expect(stored.plaintext.mayor).to.eq('Bob')
      expect(stored.previous_submissions).to.have.length(1)
    })
    cy.get('#cancel-change-vote').click()

    // 8. Once voting closes, the change action is no longer offered
    cy.intercept('GET', `/api/election/${election_id}/info`, info({ stop_accepting_votes: true }))
    cy.reload()
    cy.get('#change-vote-closed').should('contain', 'Voting has closed')
    cy.get('#change-vote-button').should('not.exist')
  })

  it('explains the same-device requirement when the voter key is missing', () => {
    cy.visit(`/election/${election_id}/vote?auth=${auth}`, { onBeforeLoad: (win) => win.localStorage.clear() })
    cy.contains('label', 'Alice').click()
    cy.contains('a', /^Submit$/).click()
    cy.wait('@submit')
    cy.contains('Vote Submitted.').should('be.visible')

    // Simulate another device / cleared key: no private key, and none must be generated
    cy.window().then((win) => {
      const stored = JSON.parse(win.localStorage.getItem(storageKey) || '{}')
      delete stored.voter_privkey
      delete stored.replacement_privkey
      win.localStorage.setItem(storageKey, JSON.stringify(stored))
    })
    cy.reload()

    cy.get('#change-vote-no-key').should('contain', 'same browser')
    cy.get('#change-vote-button').should('not.exist')
    cy.window().then((win) => {
      expect(JSON.parse(win.localStorage.getItem(storageKey) || '{}').voter_privkey).to.eq(undefined)
    })
  })
})
