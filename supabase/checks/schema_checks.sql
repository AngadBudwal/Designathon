-- Constraint and access checks for the initial schema.
--
-- Run after the migration against a disposable database or the Supabase SQL editor.
-- Requires the Supabase roles anon and service_role. Everything is rolled back.
-- Test rows use example.com and are never committed.

begin;

create function pg_temp.expect_error(statement text, expected_sqlstate text)
returns void
language plpgsql
as $$
begin
  execute statement;
  raise exception 'expected SQLSTATE % but statement succeeded: %', expected_sqlstate, statement;
exception
  when others then
    if sqlstate <> expected_sqlstate then
      raise;
    end if;
end;
$$;

create function pg_temp.expect_true(condition boolean, description text)
returns void
language plpgsql
as $$
begin
  if condition is not true then
    raise exception 'check failed: %', description;
  end if;
end;
$$;

insert into public.retailers (id, name, domain) values
  ('a0000000-0000-4000-8000-000000000001', 'Example Retailer', 'shop.example.com');

insert into public.products (id, retailer_id, canonical_url, title, department, category) values
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'https://shop.example.com/products/womens-crew', 'Womens Crew', 'womens', 'sweater'),
  ('b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001',
   'https://shop.example.com/products/mens-crew', 'Mens Crew', 'mens', 'sweater');

insert into public.products (id, retailer_id, canonical_url) values
  ('b0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001',
   'https://shop.example.com/products/no-department');

select pg_temp.expect_true(
  (select department from public.products where id = 'b0000000-0000-4000-8000-000000000003') = 'unknown',
  'department defaults to unknown'
);

select pg_temp.expect_error($$
  insert into public.products (retailer_id, canonical_url)
  values ('a0000000-0000-4000-8000-000000000001', 'https://shop.example.com/products/womens-crew')
$$, '23505');

select pg_temp.expect_error($$
  insert into public.products (retailer_id, canonical_url, department)
  values ('a0000000-0000-4000-8000-000000000001', 'https://shop.example.com/x', 'girls')
$$, '23514');

select pg_temp.expect_error($$
  insert into public.products (retailer_id, canonical_url, image_url)
  values ('a0000000-0000-4000-8000-000000000001', 'https://shop.example.com/y', 'javascript:alert(1)')
$$, '23514');

insert into public.product_variants (id, product_id, color, size_label) values
  ('c0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'Oat', 'M'),
  ('c0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', 'Oat', 'L');

select pg_temp.expect_error($$
  insert into public.product_variants (product_id, color, size_label)
  values ('b0000000-0000-4000-8000-000000000001', 'Oat', 'M')
$$, '23505');

select pg_temp.expect_error($$
  insert into public.product_variants (product_id) values ('b0000000-0000-4000-8000-000000000001')
$$, '23514');

insert into public.product_evidence (id, product_id, source_type, source_url, excerpt, captured_at, extractor_version) values
  ('d0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'extension_capture',
   'https://shop.example.com/products/womens-crew', 'Shell: 70% merino wool, 30% polyester',
   '2026-10-17T22:15:00Z', '0.1.0'),
  ('d0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002', 'manual_review',
   'https://shop.example.com/products/mens-crew', 'Shell: 100% wool', '2026-10-17T22:15:00Z', null);

select pg_temp.expect_error($$
  insert into public.product_evidence (product_id, source_type, source_url, excerpt, captured_at)
  values ('b0000000-0000-4000-8000-000000000001', 'extension_capture',
          'https://shop.example.com/products/womens-crew', 'Shell: wool', now())
$$, '23514');

select pg_temp.expect_error(format($$
  insert into public.product_evidence (product_id, source_type, source_url, excerpt, captured_at)
  values ('b0000000-0000-4000-8000-000000000001', 'manual_review',
          'https://shop.example.com/products/womens-crew', %L, now())
$$, repeat('x', 501)), '23514');

insert into public.material_claims (product_id, evidence_id, component, fiber, percent, raw_text) values
  ('b0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001',
   'shell', 'merino wool', 70, 'Shell: 70% merino wool, 30% polyester');

insert into public.material_claims (product_id, evidence_id, component, fiber, percent, raw_text) values
  ('b0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001',
   'lining', 'cotton', null, 'Lining: cotton');

select pg_temp.expect_true(
  (select verification_status from public.material_claims where fiber = 'merino wool') = 'extracted',
  'claims default to extracted'
);

-- A claim on product 1 cannot cite evidence captured for product 2.
select pg_temp.expect_error($$
  insert into public.material_claims (product_id, evidence_id, component, fiber, percent, raw_text)
  values ('b0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002',
          'shell', 'wool', 100, 'Shell: 100% wool')
$$, '23503');

select pg_temp.expect_error($$
  insert into public.material_claims (product_id, evidence_id, component, fiber, percent, raw_text)
  values ('b0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001',
          'trim', 'wool', 101, 'Trim: 101% wool')
$$, '23514');

select pg_temp.expect_error($$
  insert into public.material_claims (product_id, evidence_id, component, fiber, raw_text)
  values ('b0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001',
          'collar', 'wool', 'Collar: wool')
$$, '23514');

select pg_temp.expect_error($$
  insert into public.material_claims (product_id, evidence_id, component, fiber, raw_text, verification_status)
  values ('b0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001',
          'trim', 'wool', 'Trim: wool', 'verified')
$$, '23514');

insert into public.price_observations (product_id, variant_id, evidence_id, listed_amount_minor, currency, observed_at) values
  ('b0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-000000000001', 8900, 'USD', '2026-10-17T22:15:00Z'),
  ('b0000000-0000-4000-8000-000000000001', null, null, 7900, 'USD', '2026-10-18T22:15:00Z');

select pg_temp.expect_true(
  (select count(*) from public.price_observations
   where product_id = 'b0000000-0000-4000-8000-000000000001') = 2,
  'price observations are appended, not replaced'
);

select pg_temp.expect_error($$
  insert into public.price_observations (product_id, listed_amount_minor, currency, observed_at)
  values ('b0000000-0000-4000-8000-000000000001', -1, 'USD', now())
$$, '23514');

select pg_temp.expect_error($$
  insert into public.price_observations (product_id, listed_amount_minor, currency, observed_at)
  values ('b0000000-0000-4000-8000-000000000001', 8900, 'usd', now())
$$, '23514');

select pg_temp.expect_error($$
  insert into public.price_observations (product_id, variant_id, listed_amount_minor, currency, observed_at)
  values ('b0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000001', 8900, 'USD', now())
$$, '23503');

select pg_temp.expect_error($$
  insert into public.price_observations (product_id, evidence_id, listed_amount_minor, currency, observed_at)
  values ('b0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', 8900, 'USD', now())
$$, '23503');

insert into public.garment_measurements (product_id, variant_id, evidence_id, name, size_label, value, unit, basis) values
  ('b0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-000000000001', 'chest', 'M', 50, 'cm', 'garment_flat');

select pg_temp.expect_error($$
  insert into public.garment_measurements (product_id, evidence_id, name, value, unit)
  values ('b0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'length', 0, 'cm')
$$, '23514');

select pg_temp.expect_error($$
  insert into public.garment_measurements (product_id, evidence_id, name, value, unit)
  values ('b0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002', 'length', 60, 'cm')
$$, '23503');

select pg_temp.expect_error($$
  insert into public.garment_measurements (product_id, evidence_id, name, value, unit, basis)
  values ('b0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'length', 60, 'cm', 'estimated')
$$, '23514');

-- Analysis lifecycle.
insert into public.analyses (id, submitted_page_url, request_payload) values
  ('e0000000-0000-4000-8000-000000000001', 'https://shop.example.com/products/womens-crew', '{}');

select pg_temp.expect_true(
  (select processing_status = 'pending' and outcome is null and finished_at is null
   from public.analyses where id = 'e0000000-0000-4000-8000-000000000001'),
  'analyses start pending with no outcome'
);

select pg_temp.expect_error($$
  insert into public.analyses (submitted_page_url, request_payload, processing_status, finished_at)
  values ('https://shop.example.com/a', '{}', 'completed', now())
$$, '23514');

select pg_temp.expect_error($$
  insert into public.analyses (submitted_page_url, request_payload, outcome)
  values ('https://shop.example.com/a', '{}', 'unsupported_page')
$$, '23514');

select pg_temp.expect_error($$
  insert into public.analyses (submitted_page_url, request_payload, processing_status, finished_at)
  values ('https://shop.example.com/a', '{}', 'failed', now())
$$, '23514');

select pg_temp.expect_error($$
  insert into public.analyses (submitted_page_url, request_payload, processing_status, outcome, finished_at)
  values ('https://shop.example.com/a', '{}', 'completed', 'alternatives_found', now())
$$, '23514');

select pg_temp.expect_error($$
  insert into public.analyses (submitted_page_url, request_payload, selected_variant_id)
  values ('https://shop.example.com/a', '{}', 'c0000000-0000-4000-8000-000000000001')
$$, '23514');

select pg_temp.expect_error($$
  insert into public.analyses (submitted_page_url, request_payload, selected_product_id, selected_variant_id)
  values ('https://shop.example.com/a', '{}', 'b0000000-0000-4000-8000-000000000002',
          'c0000000-0000-4000-8000-000000000001')
$$, '23503');

select pg_temp.expect_error($$
  insert into public.analyses (submitted_page_url, request_payload) values ('https://shop.example.com/a', '[]')
$$, '23514');

insert into public.analyses (submitted_page_url, request_payload, processing_status, outcome, finished_at) values
  ('https://shop.example.com/pages/about', '{}', 'completed', 'unsupported_page', now());

insert into public.analyses (submitted_page_url, request_payload, processing_status, failure_code, failure_message, finished_at) values
  ('https://shop.example.com/a', '{}', 'failed', 'processing_failed', 'This analysis could not be completed.', now());

update public.analyses
set processing_status = 'completed',
    outcome = 'alternatives_found',
    selected_product_id = 'b0000000-0000-4000-8000-000000000001',
    selected_variant_id = 'c0000000-0000-4000-8000-000000000001',
    finished_at = now()
where id = 'e0000000-0000-4000-8000-000000000001';

insert into public.analysis_comparables (analysis_id, product_id) values
  ('e0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002');

select pg_temp.expect_error($$
  insert into public.analysis_comparables (analysis_id, product_id)
  values ('e0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002')
$$, '23505');

insert into public.analysis_comparable_reasons (analysis_id, product_id, kind, code, detail) values
  ('e0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002',
   'explanation', 'same_category', 'Both products are categorized as sweater.');

select pg_temp.expect_error($$
  insert into public.analysis_comparable_reasons (analysis_id, product_id, kind, code, detail)
  values ('e0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002',
          'score', 'quality', 'Rated 9 out of 10.')
$$, '23514');

-- Products used by an analysis cannot be deleted out from under it.
select pg_temp.expect_error($$
  delete from public.products where id = 'b0000000-0000-4000-8000-000000000002'
$$, '23503');

-- Deleting an unreferenced product removes its evidence, claims, prices, and measurements.
insert into public.product_evidence (id, product_id, source_type, source_url, excerpt, captured_at) values
  ('d0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000003', 'manual_review',
   'https://shop.example.com/products/no-department', 'Shell: 100% cotton', now());
insert into public.material_claims (product_id, evidence_id, component, fiber, percent, raw_text) values
  ('b0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000003',
   'shell', 'cotton', 100, 'Shell: 100% cotton');
insert into public.price_observations (product_id, evidence_id, listed_amount_minor, currency, observed_at) values
  ('b0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000003', 3900, 'USD', now());

delete from public.products where id = 'b0000000-0000-4000-8000-000000000003';

select pg_temp.expect_true(
  not exists (select 1 from public.material_claims where product_id = 'b0000000-0000-4000-8000-000000000003')
  and not exists (select 1 from public.price_observations where product_id = 'b0000000-0000-4000-8000-000000000003')
  and not exists (select 1 from public.product_evidence where product_id = 'b0000000-0000-4000-8000-000000000003'),
  'product delete cascades to its own rows'
);

-- Access control. anon has no table privileges.
set local role anon;
do $$
begin
  perform 1 from public.products limit 1;
  raise exception 'anon was able to read products';
exception
  when insufficient_privilege then null;
end;
$$;
do $$
begin
  insert into public.analyses (submitted_page_url, request_payload) values ('https://shop.example.com/a', '{}');
  raise exception 'anon was able to insert an analysis';
exception
  when insufficient_privilege then null;
end;
$$;
reset role;

-- Even if a privilege were granted by mistake, RLS with no policies returns no rows.
grant select on public.products to anon;
set local role anon;
do $$
begin
  if (select count(*) from public.products) <> 0 then
    raise exception 'RLS did not hide products from anon';
  end if;
end;
$$;
reset role;

-- The server role can read and write.
set local role service_role;
do $$
begin
  insert into public.retailers (name, domain) values ('Server Write Check', 'server-check.example.com');
  if (select count(*) from public.products) < 2 then
    raise exception 'service_role could not read products';
  end if;
end;
$$;
reset role;

select 'all schema checks passed' as result;

rollback;
