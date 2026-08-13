CREATE OR REPLACE FUNCTION pg_temp.ontos_fixture_integer(raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $function$
DECLARE
  parsed bigint;
BEGIN
  IF raw !~ '^-?(0|[1-9][0-9]*)$' THEN
    RAISE EXCEPTION 'invalid integer lexical form' USING ERRCODE = '22023';
  END IF;
  parsed := raw::bigint;
  RETURN parsed::text;
END
$function$;

CREATE OR REPLACE FUNCTION pg_temp.ontos_fixture_decimal(
  raw text,
  declared_precision integer,
  declared_scale integer
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $function$
DECLARE
  negative boolean;
  unsigned_value text;
  separator integer;
  integer_part text;
  fractional_part text;
  padded_fraction text;
  integer_digits integer;
  zero_value boolean;
BEGIN
  IF declared_precision < 1 OR declared_precision > 38
    OR declared_scale < 0 OR declared_scale > 18
    OR declared_scale > declared_precision THEN
    RAISE EXCEPTION 'invalid decimal declaration' USING ERRCODE = '22023';
  END IF;
  IF raw !~ '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$' THEN
    RAISE EXCEPTION 'invalid decimal lexical form' USING ERRCODE = '22023';
  END IF;

  negative := left(raw, 1) = '-';
  unsigned_value := CASE WHEN negative THEN substring(raw FROM 2) ELSE raw END;
  separator := strpos(unsigned_value, '.');
  integer_part := CASE
    WHEN separator = 0 THEN unsigned_value
    ELSE left(unsigned_value, separator - 1)
  END;
  fractional_part := CASE
    WHEN separator = 0 THEN ''
    ELSE substring(unsigned_value FROM separator + 1)
  END;
  integer_digits := CASE WHEN integer_part = '0' THEN 0 ELSE length(integer_part) END;

  IF length(fractional_part) > declared_scale
    OR integer_digits > declared_precision - declared_scale THEN
    RAISE EXCEPTION 'decimal does not fit declaration' USING ERRCODE = '22003';
  END IF;

  padded_fraction := rpad(fractional_part, declared_scale, '0');
  zero_value := btrim(integer_part || padded_fraction, '0') = '';
  RETURN (CASE WHEN negative AND NOT zero_value THEN '-' ELSE '' END)
    || integer_part
    || (CASE WHEN declared_scale = 0 THEN '' ELSE '.' || padded_fraction END);
END
$function$;

CREATE OR REPLACE FUNCTION pg_temp.ontos_fixture_date(raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $function$
DECLARE
  parsed date;
BEGIN
  IF raw !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR left(raw, 4) = '0000' THEN
    RAISE EXCEPTION 'invalid date lexical form' USING ERRCODE = '22023';
  END IF;
  parsed := raw::date;
  IF to_char(parsed, 'YYYY-MM-DD') <> raw THEN
    RAISE EXCEPTION 'date did not round-trip' USING ERRCODE = '22023';
  END IF;
  RETURN raw;
END
$function$;

CREATE OR REPLACE FUNCTION pg_temp.ontos_fixture_timestamp(raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $function$
DECLARE
  parsed timestamptz;
  zone_text text;
  offset_hour integer;
  offset_minute integer;
BEGIN
  IF raw !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
    OR left(raw, 4) = '0000'
    OR substring(raw FROM 12 FOR 2)::integer > 23
    OR substring(raw FROM 15 FOR 2)::integer > 59
    OR substring(raw FROM 18 FOR 2)::integer > 59 THEN
    RAISE EXCEPTION 'invalid timestamp lexical form' USING ERRCODE = '22023';
  END IF;

  zone_text := CASE WHEN right(raw, 1) = 'Z' THEN 'Z' ELSE right(raw, 6) END;
  IF zone_text <> 'Z' THEN
    offset_hour := substring(zone_text FROM 2 FOR 2)::integer;
    offset_minute := substring(zone_text FROM 5 FOR 2)::integer;
    IF zone_text = '-00:00'
      OR offset_hour > 14
      OR offset_minute > 59
      OR (offset_hour = 14 AND offset_minute <> 0) THEN
      RAISE EXCEPTION 'invalid timestamp offset' USING ERRCODE = '22023';
    END IF;
  END IF;

  parsed := raw::timestamptz;
  RETURN to_char(parsed AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
END
$function$;

CREATE OR REPLACE FUNCTION pg_temp.ontos_fixture_uuid(raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $function$
BEGIN
  IF raw !~ '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$' THEN
    RAISE EXCEPTION 'invalid UUID lexical form' USING ERRCODE = '22023';
  END IF;
  RETURN raw::uuid::text;
END
$function$;

CREATE OR REPLACE FUNCTION pg_temp.ontos_fixture_enum(raw text, allowed_values text[])
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $function$
BEGIN
  IF NOT raw = ANY(allowed_values) THEN
    RAISE EXCEPTION 'enum code is not allowed' USING ERRCODE = '22023';
  END IF;
  RETURN raw;
END
$function$;

CREATE OR REPLACE FUNCTION pg_temp.ontos_fixture_string(raw text, maximum_bytes integer)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $function$
BEGIN
  IF octet_length(raw) > maximum_bytes THEN
    RAISE EXCEPTION 'string exceeds byte limit' USING ERRCODE = '22001';
  END IF;
  RETURN raw;
END
$function$;

CREATE OR REPLACE FUNCTION pg_temp.ontos_fixture_string_array(raw text[], maximum_items integer)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $function$
DECLARE
  result text;
BEGIN
  IF cardinality(raw) > maximum_items THEN
    RAISE EXCEPTION 'string array exceeds item limit' USING ERRCODE = '22001';
  END IF;
  SELECT '[' || COALESCE(
    string_agg(to_jsonb(item)::text, ',' ORDER BY ordinal),
    ''
  ) || ']'
  INTO result
  FROM unnest(raw) WITH ORDINALITY AS items(item, ordinal);
  RETURN result;
END
$function$;

CREATE OR REPLACE FUNCTION pg_temp.ontos_fixture_json(value jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $function$
DECLARE
  result text;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      SELECT '{' || COALESCE(
        string_agg(
          to_jsonb(entry.key)::text || ':' || pg_temp.ontos_fixture_json(entry.value),
          ','
          ORDER BY entry.key COLLATE "C"
        ),
        ''
      ) || '}'
      INTO result
      FROM jsonb_each(value) AS entry;
      RETURN result;
    WHEN 'array' THEN
      SELECT '[' || COALESCE(
        string_agg(pg_temp.ontos_fixture_json(item.value), ',' ORDER BY item.ordinal),
        ''
      ) || ']'
      INTO result
      FROM jsonb_array_elements(value) WITH ORDINALITY AS item(value, ordinal);
      RETURN result;
    ELSE
      RETURN value::text;
  END CASE;
END
$function$;

CREATE OR REPLACE FUNCTION pg_temp.ontos_fixture_primary_key(
  canonical text,
  maximum_bytes integer
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $function$
BEGIN
  IF canonical !~ '^pk1\|[1-9][0-9]*\|' THEN
    RAISE EXCEPTION 'invalid Primary Key codec version or count' USING ERRCODE = '22023';
  END IF;
  IF octet_length(canonical) > maximum_bytes THEN
    RAISE EXCEPTION 'Primary Key exceeds byte limit' USING ERRCODE = '22001';
  END IF;
  RETURN canonical;
END
$function$;
