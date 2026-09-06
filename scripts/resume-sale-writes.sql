-- Run only after the compatible app and database correction have been verified.
begin;
grant execute on function private.save_sale(uuid,jsonb) to authenticated;
grant execute on function public.save_sale(uuid,jsonb) to authenticated;
commit;
