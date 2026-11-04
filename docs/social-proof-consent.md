# Consent-based social proof workflow

This operator-only workflow reviews the already-approved minimal installation records without
saving another copy of their identities. It never sends messages, exposes a public endpoint, or
authorizes public display from an installation alone.

## Safety boundary

- Run these commands only on a trusted local machine.
- Keep the registry and account-fingerprint key outside the repository. Both files are created
  with owner-only permissions and will not overwrite an existing file. The command refuses paths
  inside the repository, including paths reached through a symlinked parent directory, and refuses
  input files readable or writable by other users.
- Never commit the registry, fingerprint key, permission evidence, or installation identities.
- Do not add repository information, issue contents, reporter details, email addresses, last-active
  dates, or other enrichment to this workflow. The only allowed usage signal is the exact count of
  successful feedback Issues associated with an installation.
- Contact an app owner at most once unless they reply. Record `contacted`, `declined`, `approved`,
  or `withdrawn` before reviewing candidates again.
- Publishing requires affirmative permission from an authorized representative. Copy only the
  exact approved name, URL, logo URL, quote, and attribution into `publicProfile`.

## Create the private registry

Create the registry and its separate fingerprint key together:

```sh
npm run social-proof:consent -- init \
  --registry /private/path/bugdrop-consent.json \
  --key /private/path/bugdrop-social-proof.key
```

Back up the key securely. It lets the workflow recognize a prior decision after an app is
reinstalled, but the registry itself stores only a keyed account fingerprint—not the GitHub login,
profile link, or installation ID. The registry includes a non-secret key verifier, and review fails
instead of resurfacing prior decisions if the wrong key is supplied.

## Review outreach candidates

Authenticate Wrangler with read access to the production Cloudflare KV namespace, then run:

```sh
npm run social-proof:consent -- review \
  --registry /private/path/bugdrop-consent.json \
  --key /private/path/bugdrop-social-proof.key \
  --exclude mean-weasel,neonwatty
```

The private terminal displays the currently eligible account, profile, installation date, keyed
fingerprint, and—when collection was enabled for that installation—the successful-feedback count.
Known counts are ranked highest first; a missing count is not presented as zero. The command does
not save installation identities or usage counts to another file. Close the terminal session after
finishing the review. The command rejects identity and usage records with any fields beyond their
approved minimal schemas. The exclusion list is required so owned and controlled test accounts
cannot accidentally enter the outreach queue.

## Record decisions

Non-approved entries contain exactly `accountFingerprint`, `status`, and `updatedAt`. Copy the
fingerprint shown by the review command; do not copy the account login or profile. For example:

```json
{
  "accountFingerprint": "9df00f4d0ea916a50368e409184430b50cb1f8c17eae5bce7695b9ff706829be",
  "status": "declined",
  "updatedAt": "2026-08-30T00:00:00.000Z"
}
```

Because the fingerprint is keyed, it continues to suppress repeat outreach if the same account
reinstalls with a new GitHub installation ID, without retaining a directly identifying account
value in the registry.

An approved entry also contains `approval`, including the approval date, a private evidence
reference, confirmation that the person was authorized, and the exact public profile they
approved. The validator rejects approvals without all of those safeguards.

## Export approved profiles

```sh
npm run social-proof:consent -- export-approved \
  --registry /private/path/bugdrop-consent.json \
  --output /private/path/bugdrop-approved-social-proof.json
```

This export contains only approved public profile fields. It omits account fingerprints, usage
counts, private evidence references, contact status, and all unapproved apps. Review the output
against the permission evidence before copying it into the website repository.
