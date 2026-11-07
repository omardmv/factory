# The quality bar

What "done" means for code in every project (founder 2026-11-07). A
project's own `AGENTS.md` may add to it, never lower it.

## 1. Design

- **API design**: names, inputs, outputs and errors a caller can guess;
  small surface; no breaking change to a public API or URL shape without
  `DECISION NEEDED`.
- **Architecture**: put code where its responsibility lives; a new
  service, dependency or data-model change is `DECISION NEEDED`.
- **Refactoring**: leave touched code simpler than you found it; a
  refactor changes structure only (refactor playbook).

## 2. Static analysis (every change, in CI)

- lint, type check, compile/build: all clean, no new suppressions
  (`ignore`, `any`, `noqa`, `@ts-expect-error`) without a reason in the PR.

## 3. Tests: end-to-end only

- "A test" means an **e2e test**: the user-visible flow against a running
  app (the project's e2e runner, against the PR preview). No unit tests.
- Every new behaviour and every fixed bug gets an e2e test that fails
  without the change.
- CI runs static analysis and the e2e suite on every push.

## 4. Verification

- **Empirical**: the e2e run on the preview, with videos; the independent
  QA tester; numbers before and after for performance work.
- **Formal**, where a bug would be costly (money, auth, permissions,
  migrations, concurrency): state the invariant in the PR and make it
  checked by the machine (types that make the bad state unrepresentable,
  database constraints, an assertion the e2e suite exercises).
- A result is VERIFIED, NOT VERIFIED or INCONCLUSIVE; only VERIFIED passes.

## 5. Before a person sees it

- The project's rules, skills and `AGENTS.md` are followed; a rule that
  turned out wrong is fixed in the same PR or flagged under Attention.
- The review panel passes.
- Then **human review**: the founder checks staging and merges to
  production.
