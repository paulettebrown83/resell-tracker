-- Emergency fail-closed pause: records and read access remain intact.
begin;
revoke execute on function public.save_sale(uuid,jsonb) from authenticated;
revoke execute on function private.save_sale(uuid,jsonb) from authenticated;
commit;
