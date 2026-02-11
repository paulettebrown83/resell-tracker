# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Resale tracker for logging sales, inventory, and expenses across eBay, Mercari, Poshmark, and Depop. Deployed on Vercel with Supabase backend. Used for a resale business doing ~250+ items/year.

## Commands

- `npm run dev` — Start dev server (port 3000)
- `npm run build` — Production build
- `npm run lint` — Run ESLint (Next.js Web Vitals + TypeScript rules)

## Tech Stack

Next.js 16 (App Router), React 19, TypeScript (strict), Tailwind CSS v4, Supabase (PostgreSQL). No test framework configured.

## Architecture

Single-page client component app. All UI lives in `app/page.tsx` (~675 lines). All data access lives in `lib/supabase.ts`.

- **`app/page.tsx`** — `'use client'` component with three tabs (Sales, Inventory, Bulk Expenses), stats dashboard (5 cards), forms, and lists. All state managed with `useState`/`useEffect`.
- **`lib/supabase.ts`** — Supabase client, TypeScript types (`Sale`, `InventoryItem`, `Expense`), and CRUD functions. This is the entire data layer.
- **`app/globals.css`** — Tailwind CSS v4 with `@import "tailwindcss"` and `@theme inline`. Light/dark mode via `prefers-color-scheme`.

## Supabase

Three tables: `sales`, `inventory`, `expenses`. Schema managed via Supabase dashboard (no local migrations). RLS enabled. Uses `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` from `.env.local`.

## Business Logic

- **Platform fee calculations** (`calculateFees` in page.tsx:78-91):
  - eBay: 13.6% + $0.40
  - Mercari: 12.9% + $0.30
  - Poshmark: 20% (or $2.95 if under $15)
  - Depop: 3.3% + $0.45
- **eBay special handling**: Optional "Gross Total" and "Actual Received" fields override calculated fees for accuracy
- **Mark as Sold**: Converts inventory item to a sale record and deletes from inventory
- **Personal items**: Use $0 item cost for non-taxable vintage clothing
- **Crosslisting**: Inventory items can be listed on multiple platforms (array field)
- **Sorting**: Sales and inventory alphabetized by item name

## Conventions

- Path alias: `@/*` maps to project root
- Tailwind CSS v4 (no `tailwind.config.js` — theming inline in globals.css)
- No Prettier — formatting relies on ESLint
- Error handling uses `alert()` and `console.error()`
