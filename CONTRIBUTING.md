# Contributing to harnesst

Thanks for your interest in contributing! This guide covers how we take work from
idea to merged.

## Ground rules

- Be respectful. This project follows our [Code of Conduct](./CODE_OF_CONDUCT.md).
- harnesst is licensed under **AGPL-3.0** (see [LICENSE](./LICENSE)). By contributing you
  agree that your contributions are licensed under the same terms.

## 1. Start with an issue

Every change starts with an issue so we can agree on the approach before code is written.

- **Found a bug?** Open a [Bug report](https://github.com/zero8ai/eden/issues/new?template=bug_report.yml).
- **Have an idea?** Open a [Feature request](https://github.com/zero8ai/eden/issues/new?template=feature_request.yml).
- **Just a question?** Use [Discussions](https://github.com/zero8ai/eden/discussions) instead.

Please search existing issues first to avoid duplicates. Wait for a maintainer to
confirm the approach on non-trivial work before investing time in a PR.

## 2. Set up locally

See the [README](./README.md#local-setup) for prerequisites and setup. In short:

```bash
npm install
npm run dev
```

## 3. Make your change

- Branch off `main`. Use a descriptive branch name (e.g. `fix/discord-hint`,
  `feature/model-picker`).
- Keep PRs focused — one logical change per PR is much easier to review.
- Match the surrounding code style; there's no separate lint step to appease, just
  keep it consistent.

## 4. Verify before you push

CI runs these two checks on every pull request, and they must pass before a PR can be
merged. Run them locally first:

```bash
npm run typecheck   # React Router typegen + tsc
npm test            # vitest unit suite
```

## 5. Open a pull request

- Target the `main` branch.
- Fill out the [pull request template](./.github/PULL_REQUEST_TEMPLATE.md) — it prompts
  for the context reviewers need.
- Link the issue it resolves (e.g. "Closes #123").
- A maintainer (@asiraky) will review. Every PR requires their approval before it can
  be merged, and all CI checks and review conversations must be resolved.

Once approved and green, a maintainer will merge it. Thanks for contributing! 🌱
