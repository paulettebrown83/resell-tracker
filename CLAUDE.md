# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Resale tracker application for logging sales, inventory, and expenses across platforms (eBay, Mercari, Poshmark, Depop). Built with Next.js 16 (App Router), React 19, TypeScript, Supabase, and Tailwind CSS v4.

## Commands

- `npm run dev` — Start dev server (port 3000)
- `npm run build` — Production build
- `npm start` — Start production server
- `npm run lint` — Run ESLint (Next.js Web Vitals + TypeScript rules)

## Architecture

- **`app/`** — Next.js App Router pages and layouts. Currently a single page (`page.tsx`) with placeholder content.
- **`lib/supabase.ts`** — Supabase client, TypeScript types (`Sale`, `InventoryItem`, `Expense`), and CRUD functions for all three entities. This is the data layer.
- **`app/globals.css`** — Tailwind CSS v4 using `@import "tailwindcss"` syntax with `@theme inline` for CSS custom properties. Supports light/dark mode via `prefers-color-scheme`.

## Supabase

Three tables: `sales`, `inventory`, `expenses`. Schema is managed via Supabase dashboard (no local migration files). The client uses `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` from `.env.local`.

## Conventions

- TypeScript strict mode enabled
- Path alias: `@/*` maps to project root
- Tailwind CSS v4 (no `tailwind.config.js` — theming done inline in `globals.css`)
- No test framework configured yet
- No Prettier — formatting relies on ESLint defaults
