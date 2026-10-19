# Repository automation

Install `github-ledger.mjs` as `.github/scripts/ledger.mjs` and `ledger.yml` as
`.github/workflows/ledger.yml`. The ledger workflow uses trusted default-branch
code and the GitHub actor credential. It never merges: harnesst merges the
approved PR head with its own GitHub App, and this workflow only observes it.

When the approved PR merges (the `pull_request` closed event, or the scheduled
sweep if that run failed), the helper emits `repository_dispatch: ledger-deploy`
with the item ID, approved PR head, confirmed merge commit and PR number, then
moves the item to merged. Install a consumer before approving merges.
`deploy.yml` is a Cloudflare Workers example; configure the
repository variable `CLOUDFLARE_WORKER_URL` and the Cloudflare secrets it names.
Both workflows must be on the default branch. The helper alone is not a complete
deployment integration.

The consumer verifies GitHub's merged PR and current default-branch commit before
checking out code. It records a GitHub deployment with the original event payload,
then publishes its status. A successful result explicitly dispatches
`ledger-deployed` with the GitHub deployment ID: GitHub also suppresses ordinary
deployment-status workflow triggers when its built-in token wrote the status.
The ledger helper fetches that record and its latest status, verifies the merge
commit, and uses the original PR head to bind the ledger result.

Dispatch can be delivered more than once after a transport failure. Deployment
consumers must tolerate repeated requests for the same commit; the example
serializes production deployments and refuses a superseded merge to prevent an
older request from rolling back newer default-branch code. Re-running a failed
workflow can repeat an already successful deploy if only reporting failed.

This integration does not authorize merging infrastructure items that have no
merge stage. Configure that workflow policy separately; do not infer merge
permission from an infrastructure item merely being marked done.
