import { handle } from '@/lib/package-server/service.mjs'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120
export const POST = (request: Request) => handle(request)
