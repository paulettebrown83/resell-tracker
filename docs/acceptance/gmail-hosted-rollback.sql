-- Hosted SQL-role acceptance; NOT a fabricated HTTP bearer, real OAuth consent or mailbox run.
-- Requires reviewed migration and coordinator config + client/tick/ingress Vault setup.
-- Must run before real enrollment. No Auth user is created. Every test write rolls back.
begin;
create temporary table gmail_acceptance_results(check_name text,result text) on commit drop;
grant select,insert on gmail_acceptance_results to authenticated,service_role;
select set_config('request.jwt.claim.sub','13262711-f77a-45e5-9d98-9649be243a22',true);
do $acceptance$
declare owner_id uuid:=auth.uid(); account_id uuid:=gen_random_uuid(); request_id uuid:=gen_random_uuid(); feed_id uuid; state_id uuid;
 state_hash text:=encode(extensions.gen_random_bytes(32),'hex'); cookie_hash text:=encode(extensions.gen_random_bytes(32),'hex');
 result jsonb; run jsonb; tick text; receipt text; signature text; payload jsonb; cursor_value jsonb; first_result jsonb;
 tick_key text; ingress_key text; member_row private.memberships; before_sales bigint; before_inventory bigint; before_orders bigint;
begin
 if exists(select 1 from public.resale_gmail_feeds) then raise exception 'Acceptance requires no real feed enrollment yet';end if;
 if not exists(select 1 from private.memberships where user_id=owner_id and area='resale') then raise exception 'Approved existing member required';end if;
 if not exists(select 1 from private.resale_gmail_config where publishing_status='production') then raise exception 'Production coordinator configuration required';end if;
 select count(*) into before_sales from public.sales; select count(*) into before_inventory from public.inventory; select count(*) into before_orders from public.resale_order_events;
 insert into public.resale_accounts(id,marketplace,account_alias,username) values(account_id,'vinted','rollback_'||replace(account_id::text,'-',''),'synthetic_seller');
 payload:=jsonb_build_object('mailbox_email','paulettebrown83@gmail.com','account_id',account_id,'parser_version','vinted-gmail-v1');
 perform set_config('role','authenticated',true);
 feed_id:=public.resale_enroll_gmail_feed(request_id,payload);
 if public.resale_enroll_gmail_feed(request_id,payload)<>feed_id then raise exception 'Enrollment retry changed';end if;
 begin perform public.resale_enroll_gmail_feed(request_id,payload||'{"parser_version":"unapproved"}');raise exception 'Unapproved parser accepted';exception when sqlstate '22023' then null;end;
 begin update public.resale_gmail_feeds set status='active';raise exception 'Member activated feed';exception when insufficient_privilege then null;end;
 begin perform private.gmail_client_secret();raise exception 'Member read client secret';exception when insufficient_privilege then null;end;
 begin perform public.resale_gmail_oauth_start(owner_id,feed_id,state_hash,cookie_hash,repeat('a',43));raise exception 'Member called credential RPC';exception when insufficient_privilege then null;end;
 insert into gmail_acceptance_results values('real member identity, exact enrollment retry and browser authority denial','passed');
 perform set_config('role','service_role',true);
 result:=public.resale_gmail_oauth_start(owner_id,feed_id,state_hash,cookie_hash,repeat('a',43));state_id:=(result->>'state_id')::uuid;
 begin perform public.resale_gmail_oauth_consume(state_hash,repeat('0',64));raise exception 'Wrong browser binding consumed';exception when sqlstate '22023' then null;end;
 result:=public.resale_gmail_oauth_consume(state_hash,cookie_hash);
 if result->>'code_verifier'<>repeat('a',43) then raise exception 'Verifier missing';end if;
 begin perform public.resale_gmail_oauth_consume(state_hash,cookie_hash);raise exception 'OAuth state replay accepted';exception when sqlstate '22023' then null;end;
 begin perform public.resale_gmail_oauth_complete(state_id,'wrong@example.test',array['https://www.googleapis.com/auth/gmail.readonly'],'rollback-only-synthetic-token');raise exception 'Wrong mailbox accepted';exception when sqlstate '22023' then null;end;
 result:=public.resale_gmail_oauth_complete(state_id,'paulettebrown83@gmail.com',array['https://www.googleapis.com/auth/gmail.readonly'],'rollback-only-synthetic-token');
 if result->>'status'<>'active' then raise exception 'Production feed not active';end if;
 insert into gmail_acceptance_results values('bound single-use OAuth, exact mailbox/scope and narrow Vault token write','passed');
 perform set_config('role','postgres',true);
 select decrypted_secret into tick_key from vault.decrypted_secrets where name='resale_gmail_paulettebrown83_production_tick_signing_key';
 select decrypted_secret into ingress_key from vault.decrypted_secrets where name='resale_gmail_paulettebrown83_production_ingress_signing_key';
 tick:=jsonb_build_object('v',1,'nonce',gen_random_uuid(),'expires_at',floor(extract(epoch from clock_timestamp()))+300)::text;
 signature:=encode(extensions.hmac(convert_to(E'gmail_tick_v1\n'||tick,'UTF8'),decode(tick_key,'hex'),'sha256'),'hex');
 perform set_config('role','service_role',true);run:=public.resale_gmail_verify_tick_and_claim(tick,signature);
 if run->>'lease_token' is null then raise exception 'Lease missing';end if;
 if public.resale_gmail_verify_tick_and_claim(tick,signature) is not null then raise exception 'Tick replay leased again';end if;
 cursor_value:=jsonb_build_object('window_start_ms',floor(extract(epoch from clock_timestamp())*1000)-86400000,'window_end_ms',floor(extract(epoch from clock_timestamp())*1000)-60000,'page_token',null,'window_complete',false,'pending_message_ids',jsonb_build_array('abc123'),'next_page_token',null);
 perform public.resale_gmail_checkpoint_run(feed_id,(run->>'lease_token')::uuid,cursor_value);
 payload:=jsonb_build_object('v',1,'nonce',gen_random_uuid(),'feed_id',feed_id,'lease_token',run->>'lease_token','parser_version','vinted-gmail-v1','account_id',account_id,
 'message_id','abc123','thread_id','abc456','received_at',floor(extract(epoch from clock_timestamp())*1000)-100000,'captured_at',floor(extract(epoch from clock_timestamp())*1000),
 'kind','sale_notification','source_sha256',repeat('a',64),'expires_at',floor(extract(epoch from clock_timestamp()))+300,
 'normalized',jsonb_build_object('subject','Synthetic rollback notification','account_handle','synthetic_seller','product_titles',jsonb_build_array('Synthetic item'),'money_mentions','[]'::jsonb,'conversation_ids','[]'::jsonb,
 'transaction_id',null,'order_id',null,'listing_id',null,'parser_status','recognized','quarantine_reason',null,'authentication_pass',true));
 perform set_config('role','postgres',true);
 receipt:=payload::text;signature:=encode(extensions.hmac(convert_to(E'gmail_ingest_v1\n'||receipt,'UTF8'),decode(ingress_key,'hex'),'sha256'),'hex');
 perform set_config('role','service_role',true);
 first_result:=public.resale_ingest_gmail_message(receipt,signature);result:=public.resale_ingest_gmail_message(receipt,signature);
 if result->>'source_record_id'<>first_result->>'source_record_id' or result->>'duplicate'<>'true' then raise exception 'Message retry not stable';end if;
 perform set_config('role','postgres',true);
 payload:=payload||jsonb_build_object('nonce',gen_random_uuid(),'source_sha256',repeat('b',64));receipt:=payload::text;signature:=encode(extensions.hmac(convert_to(E'gmail_ingest_v1\n'||receipt,'UTF8'),decode(ingress_key,'hex'),'sha256'),'hex');
 perform set_config('role','service_role',true);
 begin perform public.resale_ingest_gmail_message(receipt,signature);raise exception 'Changed message overwrote evidence';exception when sqlstate '22023' then null;end;
 perform set_config('role','postgres',true);
 if not exists(select 1 from public.resale_actions where id=(first_result->>'operation_id')::uuid and state='blocked' and action='reconcile_sale' and listing_id is null and target_inventory_id is null) then raise exception 'Notification created unsafe action';end if;
 if not exists(select 1 from public.resale_source_records where id=(first_result->>'source_record_id')::uuid and event_time is null and external_identifiers->'order_id'='null'::jsonb) then raise exception 'Source fabricated transaction identity/time';end if;
 if (select count(*) from public.sales)<>before_sales or (select count(*) from public.inventory)<>before_inventory or (select count(*) from public.resale_order_events)<>before_orders then raise exception 'Canonical counts changed';end if;
 insert into gmail_acceptance_results values('signed lease, exact source dedupe, unknown order/time preserved and blocked evidence only','passed');
 perform set_config('role','service_role',true);
 begin perform public.resale_gmail_finish_run(feed_id,(run->>'lease_token')::uuid,'complete',cursor_value,null);raise exception 'Incomplete scope completed';exception when sqlstate '22023' then null;end;
 perform public.resale_gmail_finish_run(feed_id,(run->>'lease_token')::uuid,'paused',cursor_value,'message_unavailable');
 perform set_config('role','postgres',true);
 if not exists(select 1 from public.resale_gmail_feeds where id=feed_id and status='paused' and last_success_at is null) then raise exception 'Gap not preserved as paused';end if;
 delete from private.memberships where user_id=owner_id and area='resale' returning * into member_row;
 perform set_config('role','authenticated',true);
 begin perform public.resale_enroll_gmail_feed(request_id,jsonb_build_object('mailbox_email','paulettebrown83@gmail.com','account_id',account_id,'parser_version','vinted-gmail-v1'));raise exception 'Revoked retry accepted';exception when insufficient_privilege then null;end;
 if exists(select 1 from public.resale_gmail_feeds) then raise exception 'Revoked feed visible';end if;
 perform set_config('role','service_role',true);
 begin perform public.resale_gmail_oauth_start(owner_id,feed_id,repeat('e',64),cookie_hash,repeat('a',43));raise exception 'Revoked owner OAuth accepted';exception when insufficient_privilege then null;end;
 perform set_config('role','postgres',true);insert into private.memberships select (member_row).*;
 insert into gmail_acceptance_results values('partial scope cannot complete, missing-message pause and current revocation','passed');
end $acceptance$;
set local role anon;
do $$ begin
begin perform 1 from public.resale_gmail_feeds;raise exception 'Anonymous read allowed';exception when insufficient_privilege then null;end;
begin perform public.resale_gmail_verify_tick_and_claim('{}',repeat('0',64));raise exception 'Anonymous tick RPC allowed';exception when insufficient_privilege then null;end;
end $$;
reset role;
insert into gmail_acceptance_results values('anonymous feed read and privileged tick denied','passed');
select * from gmail_acceptance_results;
rollback;
