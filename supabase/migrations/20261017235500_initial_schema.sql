-- Initial schema for the fashion analysis backend.
--
-- Every table is server-only. Row Level Security is enabled with no policies, and the
-- anon and authenticated roles have no table privileges. Only server code using the
-- Supabase secret (service role) key can read or write.
--
-- Column limits match web/lib/contracts (contract version 3.0.0).

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Retailers ------------------------------------------------------------------

create table public.retailers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  domain text not null unique check (
    char_length(domain) <= 253
    and domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Products -------------------------------------------------------------------

create table public.products (
  id uuid primary key default gen_random_uuid(),
  retailer_id uuid not null references public.retailers (id),
  canonical_url text not null check (
    char_length(canonical_url) <= 2048 and canonical_url ~ '^https?://'
  ),
  retailer_product_id text check (char_length(retailer_product_id) between 1 and 120),
  title text check (char_length(title) between 1 and 300),
  brand text check (char_length(brand) between 1 and 120),
  department text not null default 'unknown' check (
    department in ('womens', 'mens', 'unisex', 'unknown')
  ),
  category text check (char_length(category) between 1 and 120),
  image_url text check (char_length(image_url) <= 2048 and image_url ~ '^https?://'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (retailer_id, canonical_url),
  unique (retailer_id, retailer_product_id)
);

comment on column public.products.department is
  'Retailer department label. unknown when the page did not say. Never inferred.';
comment on column public.products.image_url is
  'Image URL as listed by the retailer. Not downloaded or cached.';

create index products_category_department_idx on public.products (category, department);

-- Variants -------------------------------------------------------------------

create table public.product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  retailer_variant_id text check (char_length(retailer_variant_id) between 1 and 120),
  color text check (char_length(color) between 1 and 120),
  size_label text check (char_length(size_label) between 1 and 40),
  description text check (char_length(description) between 1 and 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, id),
  unique (product_id, retailer_variant_id),
  check (coalesce(retailer_variant_id, color, size_label, description) is not null)
);

create unique index product_variants_attributes_key
  on public.product_variants (product_id, color, size_label, description)
  nulls not distinct
  where retailer_variant_id is null;

-- Evidence -------------------------------------------------------------------

create table public.product_evidence (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  source_type text not null check (
    source_type in ('extension_capture', 'manual_review', 'retailer_feed')
  ),
  source_url text not null check (char_length(source_url) <= 2048 and source_url ~ '^https?://'),
  excerpt text not null check (char_length(excerpt) between 1 and 500),
  captured_at timestamptz not null,
  extractor_version text check (char_length(extractor_version) between 1 and 40),
  created_at timestamptz not null default now(),
  unique (product_id, id),
  check (source_type <> 'extension_capture' or extractor_version is not null)
);

comment on table public.product_evidence is
  'Short source excerpts. Immutable: insert a new row for each capture instead of updating.';

create index product_evidence_product_captured_idx
  on public.product_evidence (product_id, captured_at desc);

-- Material claims --------------------------------------------------------------

create table public.material_claims (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  evidence_id uuid not null,
  component text not null check (component in ('shell', 'lining', 'trim', 'other')),
  fiber text not null check (char_length(fiber) between 1 and 80),
  percent numeric(5, 2) check (percent between 0 and 100),
  raw_text text not null check (char_length(raw_text) between 1 and 2000),
  verification_status text not null default 'extracted' check (
    verification_status in ('extracted', 'verified')
  ),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (product_id, evidence_id)
    references public.product_evidence (product_id, id) on delete cascade,
  unique (evidence_id, component, fiber),
  check ((verification_status = 'verified') = (verified_at is not null))
);

comment on column public.material_claims.percent is
  'Null when the source gave no percentage. Claims for a product are not required to total 100.';
comment on column public.material_claims.verification_status is
  'extracted by default. Only backend review may set verified.';

create index material_claims_product_evidence_idx
  on public.material_claims (product_id, evidence_id);

-- Prices ---------------------------------------------------------------------

create table public.price_observations (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  variant_id uuid,
  evidence_id uuid,
  listed_amount_minor bigint not null check (listed_amount_minor >= 0),
  regular_amount_minor bigint check (regular_amount_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (product_id, variant_id) references public.product_variants (product_id, id),
  foreign key (product_id, evidence_id) references public.product_evidence (product_id, id)
);

comment on table public.price_observations is
  'Append-only price history. Insert a new row per observation; do not update existing rows.';
comment on column public.price_observations.regular_amount_minor is
  'Only when the retailer listed a regular price. Null does not imply a discount or its absence.';

create index price_observations_product_observed_idx
  on public.price_observations (product_id, observed_at desc);
create index price_observations_variant_observed_idx
  on public.price_observations (product_id, variant_id, observed_at desc)
  where variant_id is not null;
create index price_observations_evidence_idx
  on public.price_observations (product_id, evidence_id)
  where evidence_id is not null;

-- Measurements -----------------------------------------------------------------

create table public.garment_measurements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  variant_id uuid,
  evidence_id uuid not null,
  name text not null check (char_length(name) between 1 and 40),
  size_label text check (char_length(size_label) between 1 and 40),
  value numeric(8, 2) not null check (value > 0),
  unit text not null check (unit in ('cm', 'in')),
  basis text not null default 'unknown' check (
    basis in ('garment_flat', 'garment_circumference', 'body', 'unknown')
  ),
  created_at timestamptz not null default now(),
  foreign key (product_id, evidence_id)
    references public.product_evidence (product_id, id) on delete cascade,
  foreign key (product_id, variant_id) references public.product_variants (product_id, id),
  unique nulls not distinct (evidence_id, name, size_label, basis)
);

comment on table public.garment_measurements is
  'Only measurements listed by the source. Missing measurements have no row.';

create index garment_measurements_product_evidence_idx
  on public.garment_measurements (product_id, evidence_id);
create index garment_measurements_variant_idx
  on public.garment_measurements (product_id, variant_id)
  where variant_id is not null;

-- Analyses ---------------------------------------------------------------------

create table public.analyses (
  id uuid primary key default gen_random_uuid(),
  submitted_page_url text not null check (
    char_length(submitted_page_url) <= 2048 and submitted_page_url ~ '^https?://'
  ),
  request_payload jsonb not null check (
    jsonb_typeof(request_payload) = 'object'
    and octet_length(request_payload::text) <= 65536
  ),
  selected_product_id uuid references public.products (id),
  selected_variant_id uuid,
  processing_status text not null default 'pending' check (
    processing_status in ('pending', 'completed', 'failed')
  ),
  outcome text check (
    outcome in (
      'alternatives_found',
      'no_suitable_alternative',
      'insufficient_information',
      'unsupported_page'
    )
  ),
  failure_code text check (failure_code in ('processing_failed')),
  failure_message text check (char_length(failure_message) between 1 and 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  foreign key (selected_product_id, selected_variant_id)
    references public.product_variants (product_id, id),
  constraint analyses_outcome_matches_status
    check ((processing_status = 'completed') = (outcome is not null)),
  constraint analyses_failure_matches_status
    check ((processing_status = 'failed') = (failure_code is not null)),
  constraint analyses_failure_fields_together
    check ((failure_code is null) = (failure_message is null)),
  constraint analyses_finished_matches_status
    check ((processing_status = 'pending') = (finished_at is null)),
  constraint analyses_outcome_requires_product
    check (
      outcome is null
      or outcome not in ('alternatives_found', 'no_suitable_alternative')
      or selected_product_id is not null
    ),
  constraint analyses_variant_requires_product
    check (selected_variant_id is null or selected_product_id is not null)
);

comment on column public.analyses.request_payload is
  'Validated extension request (AnalysisRequestSchema). Kept so pending analyses can be processed.';
comment on column public.analyses.failure_message is
  'Client-safe message only. Never store stack traces, credentials, or database errors here.';

create index analyses_pending_idx
  on public.analyses (created_at)
  where processing_status = 'pending';
create index analyses_selected_product_idx
  on public.analyses (selected_product_id)
  where selected_product_id is not null;

-- Comparables ------------------------------------------------------------------

create table public.analysis_comparables (
  analysis_id uuid not null references public.analyses (id) on delete cascade,
  product_id uuid not null references public.products (id),
  variant_id uuid,
  created_at timestamptz not null default now(),
  primary key (analysis_id, product_id),
  foreign key (product_id, variant_id) references public.product_variants (product_id, id)
);

create index analysis_comparables_product_idx on public.analysis_comparables (product_id);

create table public.analysis_comparable_reasons (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null,
  product_id uuid not null,
  kind text not null check (kind in ('explanation', 'advantage', 'disadvantage', 'uncertainty')),
  code text not null check (code ~ '^[a-z][a-z_]{0,79}$'),
  detail text not null check (char_length(detail) between 1 and 300),
  created_at timestamptz not null default now(),
  foreign key (analysis_id, product_id)
    references public.analysis_comparables (analysis_id, product_id) on delete cascade,
  unique (analysis_id, product_id, kind, code)
);

comment on table public.analysis_comparable_reasons is
  'Structured reasons produced by backend comparison code. No scores or rankings.';

-- updated_at -------------------------------------------------------------------

create trigger retailers_set_updated_at
  before update on public.retailers
  for each row execute function public.set_updated_at();
create trigger products_set_updated_at
  before update on public.products
  for each row execute function public.set_updated_at();
create trigger product_variants_set_updated_at
  before update on public.product_variants
  for each row execute function public.set_updated_at();
create trigger analyses_set_updated_at
  before update on public.analyses
  for each row execute function public.set_updated_at();

-- Access control ---------------------------------------------------------------

alter table public.retailers enable row level security;
alter table public.products enable row level security;
alter table public.product_variants enable row level security;
alter table public.product_evidence enable row level security;
alter table public.material_claims enable row level security;
alter table public.price_observations enable row level security;
alter table public.garment_measurements enable row level security;
alter table public.analyses enable row level security;
alter table public.analysis_comparables enable row level security;
alter table public.analysis_comparable_reasons enable row level security;

revoke all on table
  public.retailers,
  public.products,
  public.product_variants,
  public.product_evidence,
  public.material_claims,
  public.price_observations,
  public.garment_measurements,
  public.analyses,
  public.analysis_comparables,
  public.analysis_comparable_reasons
from anon, authenticated;

revoke execute on function public.set_updated_at() from public, anon, authenticated;
