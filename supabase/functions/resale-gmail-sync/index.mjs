import {createHandler,createServices} from './runtime.mjs';
// The deployed runtime supplies these values. Never log environment, bodies or provider responses.
const env=Object.fromEntries(['SUPABASE_URL','SUPABASE_SECRET_KEYS','SUPABASE_SERVICE_ROLE_KEY','SUPABASE_PUBLISHABLE_KEYS','SUPABASE_ANON_KEY'].map(name=>[name,globalThis.Deno.env.get(name)]));
globalThis.Deno.serve(createHandler(createServices(env)));
