# Resell Tracker — Feature Build Plan

## Context

The core app is built and deployed on Vercel with Supabase. Four features remain: CSV export, search/filters, year-end archive, and mobile responsiveness. The UI also needs a visual overhaul to match the reference HTML tracker's aesthetic (purple gradient, platform-colored cards, badge pills).

All changes target two files: `app/page.tsx` (~675 lines) and `app/globals.css`. No new dependencies needed.

---

## Implemented Features

### Visual Overhaul
- Purple gradient background (indigo-to-purple)
- White centered header with subtitle and year selector
- Stats cards with uppercase small labels, amber inventory card, dynamic green/red net profit
- Card-based sales list with platform-colored left borders
- Platform badge pills (colored pill spans)
- Profit display: +$X.XX green / -$X.XX red
- Two-column form layout (form left, list right) on desktop
- Blue left-border info callout boxes on forms
- Scrollable lists (max-h-[400px] overflow-y-auto)
- Primary purple buttons, export green, delete red, inventory amber

### Mobile Responsiveness
- Responsive padding (p-4 md:p-5)
- Stats grid: grid-cols-2 md:grid-cols-5, net profit spans full on mobile
- Two-column layout: grid-cols-1 lg:grid-cols-2
- Responsive tab buttons and title sizing
- Cards stack vertically on small screens

### Search & Filters
- Search input, platform dropdown, date range on each tab
- Client-side filtering with useMemo
- Stats recalculate from filtered data
- Clear filters button

### Year-End Archive
- Year dropdown in header, populated from data
- Defaults to current year (2026)
- "All Years" option
- Combines with search/platform/date filters
- Inventory always shows current stock (no year filter)

### CSV Export
- Native Blob + URL.createObjectURL
- Export CSV button (green) on each tab
- Exports only filtered/visible data
- Proper CSV escaping (double-quote handling)
