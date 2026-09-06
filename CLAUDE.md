# Repository guidance

This is Paulette's existing Next.js resale app. Read README.md and docs/ROLLOUT.md before changes. The prepared security migration is not a verified production deployment.

- Use Comet; the connected browser extension may label its Chromium family as Chrome. Verify the native app before using that connection.
- `app/page.tsx` holds inventory/expense/report UI. `components/AuthGate.tsx` handles password login and membership gating. `components/SaleEditor.tsx` captures actual sale values and corrections. `lib/supabase.ts` owns browser data access and uncertain-request retries.
- Membership rules and narrowly authorized atomic sale functions live in `supabase/migrations/`. Preserve original IDs, source identity, history and request records. Never restore broad public policies or delete inventory to mark it sold.
- New sales require actual fee/shipping; do not add assumed marketplace rates. Unknown historical cost is not zero. Net payout excludes marketplace deductions; avoid counting already deducted shipping twice.
- The public repository must contain no business row dumps, Auth passwords, service keys or Vault values. Public project configuration belongs in `.env.local`/Vercel, with placeholders only in `.env.example`.
- Verify with `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` and `npm audit`. Local SQL tests do not replace hosted Auth/REST/multi-session cutover tests.
