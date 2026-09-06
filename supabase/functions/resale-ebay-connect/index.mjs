import {createHandler,createServices} from './runtime.mjs';
const env=Object.fromEntries(['SUPABASE_URL','SUPABASE_SECRET_KEYS','SUPABASE_SERVICE_ROLE_KEY','SUPABASE_PUBLISHABLE_KEYS','SUPABASE_ANON_KEY'].map(name=>[name,Deno.env.get(name)]));
Deno.serve(createHandler(createServices(env)));
